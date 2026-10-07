/**
 * The conversation's subjects — the molecules, reactions, jobs and notes it is about — as an index
 * beside the transcript.
 *
 * **Promotion rule.** An entity is admitted only from a structured source: tool-call arguments that
 * parse as whole JSON, a job summary, a `note_id` the service listed, or a structure the chemist
 * supplied and confirmed (`ingestUserStructure`: no inference involved). Never from prose or the
 * truncated `tool_result.preview`, which would fill the rail with near-misses.
 *
 * **Identity.** Molecules are keyed by RDKit-canonical SMILES (async), so two spellings collapse;
 * anything RDKit refuses is dropped.
 *
 * **One index per conversation.** Every reader and writer names its conversation id, so the rail
 * and transcript (both from the route parameter) cannot disagree. Keyed rather than cleared on
 * switch, since entities are minted only by a live stream. Not persisted: it is derived, and a
 * reload starts each rail empty.
 */

import { create } from 'zustand';
import type { ChemclawEvent } from '../../shared/events.ts';
import { canonicalSmiles } from './rdkit.ts';
import { looksLikeReactionSmiles, smilesFromArguments } from './recognise.ts';

export type EntityKind = 'molecule' | 'reaction' | 'job' | 'note';

/** Where an entity was seen. One row per (message, tool) so the rail can say *why* it is here. */
export interface Mention {
  /** The assistant message whose turn this sighting belongs to, or `COMPOSER_MENTION` for a
   *  structure the user supplied before any turn ran. */
  messageId: string;
  /** The tool that produced or consumed it, when it came from a tool. */
  tool?: string;
  /** How the user supplied it when no tool did (kept apart from `tool`, which names real tools). */
  source?: UserStructureSource;
  /**
   * The figures the tool returned in this turn (`tool_result.numbers`), joined to the structures it
   * was called on by `(messageId, tool)` — exact for single-structure tools; with several, each
   * gets the same values and the rail says so. Never combined into derived claims such as "± sd".
   */
  values?: number[];
  /** The same figures under the tool's own keys, when structured; empty for prose results. */
  named?: { label: string; value: number; unit: string }[];
  /** True when the call this mention belongs to named more than one structure, so `values` cannot
   *  be attributed to this one alone. */
  shared?: boolean;
  at: number;
}

/** How a structure reached the composer. */
export type UserStructureSource = 'paste' | 'file' | 'sketch';

/**
 * The `messageId` a composer-supplied structure is filed under; it matches no message (no turn
 * yet), so selecting it filters the transcript to nothing. Real mentions attach once the message is
 * sent.
 */
export const COMPOSER_MENTION = 'composer';

interface EntityBase {
  key: string;
  kind: EntityKind;
  mentions: Mention[];
  firstSeen: number;
}

export interface MoleculeEntity extends EntityBase {
  kind: 'molecule';
  /** Canonical SMILES — also the key. */
  smiles: string;
  /** Every spelling this conversation used for it, in first-seen order. Worth keeping: a chemist
   *  who typed one form should be able to recognise their own input in the rail. */
  aliases: string[];
}

export interface ReactionEntity extends EntityBase {
  kind: 'reaction';
  reactionSmiles: string;
}

export interface JobEntity extends EntityBase {
  kind: 'job';
  jobId: string;
  /** `qm`, `calc`, `campaign`, `report` — whatever the service labelled it. */
  jobKind: string;
  status: 'running' | 'completed' | 'failed';
  /** Set once the job ends one way or the other. */
  reason?: string;
  moleculeSmiles?: string;
}

export interface NoteEntity extends EntityBase {
  kind: 'note';
  noteId: string;
  /** The reference the note was recorded under, when it came from a `note_proposed` event. */
  reference?: string;
}

export type Entity = MoleculeEntity | ReactionEntity | JobEntity | NoteEntity;

/** One conversation's index. */
export interface ConversationEntities {
  entities: Record<string, Entity>;
  /** Insertion order, newest first — the order the rail renders. */
  order: string[];
  /** The entity the user is focused on, or null. Drives transcript filtering. */
  selected: string | null;
}

/**
 * The slice for a conversation with no entities: one frozen constant, since a fresh `{}` per
 * selector call would loop renders.
 */
export const NO_ENTITIES: ConversationEntities = Object.freeze({
  entities: {},
  order: [],
  selected: null,
});

export interface EntityState {
  /** Keyed by conversation id. See "one index per conversation" above. */
  byConversation: Record<string, ConversationEntities>;

  ingest: (conversationId: string, messageId: string, event: ChemclawEvent) => Promise<void>;
  /**
   * Admit a structure the user pasted, dropped or drew (see the promotion rule). Returns the
   * canonical key, or `null` if RDKit refused.
   */
  ingestUserStructure: (
    conversationId: string,
    raw: string,
    source: UserStructureSource,
  ) => Promise<string | null>;
  select: (conversationId: string, key: string | null) => void;
  /** Drop one conversation's index — called when the conversation itself is deleted, so the index
   *  cannot outlive its subject. */
  forget: (conversationId: string) => void;
  /** Drop every index. */
  clear: () => void;
}

/** One conversation's index, or the empty one. The single reader of `byConversation`, so a caller
 *  never has to decide what a conversation with no entities looks like. */
export const entitiesOf = (
  state: EntityState,
  conversationId: string | null | undefined,
): ConversationEntities =>
  (conversationId ? state.byConversation[conversationId] : undefined) ?? NO_ENTITIES;

/** Merge an entity in, or add a mention to the one already there. */
function upsert(
  slice: ConversationEntities,
  entity: Entity,
  mention: Mention,
): ConversationEntities {
  const existing = slice.entities[entity.key];

  if (!existing) {
    return {
      ...slice,
      entities: { ...slice.entities, [entity.key]: { ...entity, mentions: [mention] } },
      order: [entity.key, ...slice.order],
    };
  }

  // Deduplicate sightings: the same tool naming the same molecule twice in one turn is one fact,
  // and a mention list that counted it twice would make the rail's "seen in 4 turns" a lie.
  const seen = existing.mentions.some(
    (m) =>
      m.messageId === mention.messageId && m.tool === mention.tool && m.source === mention.source,
  );

  const merged: Entity = {
    ...existing,
    // Later information wins for the mutable parts — a job's status above all — while `firstSeen`
    // and the accumulated mentions are preserved.
    ...entity,
    firstSeen: existing.firstSeen,
    mentions: seen ? existing.mentions : [...existing.mentions, mention],
    ...(existing.kind === 'molecule' && entity.kind === 'molecule'
      ? { aliases: [...new Set([...existing.aliases, ...entity.aliases])] }
      : {}),
  } as Entity;

  return { ...slice, entities: { ...slice.entities, [entity.key]: merged } };
}

/** Rewrite one conversation's slice, leaving every other conversation's untouched. */
function write(
  conversationId: string,
  fn: (slice: ConversationEntities) => ConversationEntities,
): void {
  useEntityStore.setState((s) => ({
    byConversation: { ...s.byConversation, [conversationId]: fn(entitiesOf(s, conversationId)) },
  }));
}

export const useEntityStore = create<EntityState>()(() => ({
  byConversation: {},

  async ingest(conversationId, messageId, event) {
    const at = Date.now();
    const add = (entity: Entity, tool?: string, shared?: boolean): void => {
      write(conversationId, (slice) =>
        upsert(slice, entity, {
          messageId,
          at,
          ...(tool ? { tool } : {}),
          ...(shared ? { shared: true } : {}),
        }),
      );
    };

    switch (event.type) {
      case 'tool_call': {
        // `arguments` only, and only when they parse as whole JSON.
        const named = smilesFromArguments(event.arguments);
        // Whether this call can attribute its result to one structure — knowable only here.
        const shared = named.length > 1;
        for (const raw of named) {
          if (looksLikeReactionSmiles(raw)) {
            // Reactions are not canonicalised (no reaction object in RDKit's minimal build); every
            // component was already checked.
            add(
              {
                kind: 'reaction',
                key: `rxn:${raw}`,
                reactionSmiles: raw,
                mentions: [],
                firstSeen: at,
              },
              event.tool,
              shared,
            );
            continue;
          }
          const canonical = await canonicalSmiles(raw);
          // RDKit said no. Dropped rather than admitted under its raw string: an entry that cannot
          // be drawn or compared is a row that only takes up space.
          if (!canonical) continue;
          add(
            {
              kind: 'molecule',
              key: canonical,
              smiles: canonical,
              aliases: [raw],
              mentions: [],
              firstSeen: at,
            },
            event.tool,
            shared,
          );
        }
        return;
      }

      case 'tool_result': {
        // The ids the service says were in front of the model this turn — exact and untruncated,
        // which is why they are read here and the preview beside them is not.
        for (const noteId of event.note_ids) {
          add(
            { kind: 'note', key: `note:${noteId}`, noteId, mentions: [], firstSeen: at },
            event.tool,
          );
        }
        // Attach the returned figures (`numbers`, never `preview`); see `Mention.values`.
        if (event.numbers.length > 0 || event.values?.length) {
          write(conversationId, (slice) =>
            attachValues(slice, messageId, event.tool, event.numbers, event.values ?? []),
          );
        }
        return;
      }

      case 'job_started': {
        add({
          kind: 'job',
          key: `job:${event.job_id}`,
          jobId: event.job_id,
          jobKind: event.kind,
          status: 'running',
          mentions: [],
          firstSeen: at,
        });
        return;
      }

      case 'job_completed': {
        const smiles =
          typeof event.summary.molecule_smiles === 'string' ? event.summary.molecule_smiles : null;
        const canonical = smiles ? await canonicalSmiles(smiles) : null;

        add({
          kind: 'job',
          key: `job:${event.job_id}`,
          jobId: event.job_id,
          // A completion carries no `kind`; an existing row's value survives the merge, and a
          // completion that arrives without its start (a reload mid-job) reads as a plain job.
          jobKind: existingJobKind(conversationId, event.job_id),
          status: 'completed',
          ...(canonical ? { moleculeSmiles: canonical } : {}),
          mentions: [],
          firstSeen: at,
        });

        // The molecule a job computed is an entity in its own right, and this is the one place a
        // structure arrives already structured rather than recovered from an argument document.
        if (canonical) {
          add({
            kind: 'molecule',
            key: canonical,
            smiles: canonical,
            aliases: smiles && smiles !== canonical ? [smiles] : [],
            mentions: [],
            firstSeen: at,
          });
        }
        return;
      }

      case 'job_failed': {
        add({
          kind: 'job',
          key: `job:${event.job_id}`,
          jobId: event.job_id,
          jobKind: existingJobKind(conversationId, event.job_id),
          status: 'failed',
          reason: event.reason,
          mentions: [],
          firstSeen: at,
        });
        return;
      }

      case 'note_proposed': {
        add({
          kind: 'note',
          key: `note:${event.note_id}`,
          noteId: event.note_id,
          reference: event.reference,
          mentions: [],
          firstSeen: at,
        });
        return;
      }

      default:
        // Everything else — tokens, plans, the answer — says nothing about what the conversation
        // is *about*. Prose can link to an entity this store holds; it cannot mint one.
        return;
    }
  },

  async ingestUserStructure(conversationId, raw, source) {
    const at = Date.now();
    // Canonicalised here, the one place the key is derived, rather than trusted from the caller.
    const canonical = await canonicalSmiles(raw);
    if (!canonical) return null;

    write(conversationId, (slice) =>
      upsert(
        slice,
        {
          kind: 'molecule',
          key: canonical,
          smiles: canonical,
          // The chemist's own spelling, kept for the same reason a tool argument's is: they should
          // be able to recognise what they typed in a rail that shows them the canonical form.
          aliases: raw !== canonical ? [raw] : [],
          mentions: [],
          firstSeen: at,
        },
        { messageId: COMPOSER_MENTION, source, at },
      ),
    );
    return canonical;
  },

  select(conversationId, key) {
    write(conversationId, (slice) => ({
      ...slice,
      selected: slice.selected === key ? null : key,
    }));
  },

  forget(conversationId) {
    useEntityStore.setState((s) => {
      const { [conversationId]: _dropped, ...rest } = s.byConversation;
      return { byConversation: rest };
    });
  },

  clear() {
    useEntityStore.setState({ byConversation: {} });
  },
}));

/**
 * Attach a call's figures to the structure mentions of `(messageId, tool)` (not to notes).
 * Last-wins: one mention per pair, so accumulating would mix two calls' figures.
 */
function attachValues(
  slice: ConversationEntities,
  messageId: string,
  tool: string,
  values: number[],
  named: { label: string; value: number; unit: string }[],
): ConversationEntities {
  let touched = false;
  const entities: Record<string, Entity> = {};

  for (const [key, entity] of Object.entries(slice.entities)) {
    if (entity.kind !== 'molecule' && entity.kind !== 'reaction') {
      entities[key] = entity;
      continue;
    }
    let changed = false;
    const mentions = entity.mentions.map((mention) => {
      if (mention.messageId !== messageId || mention.tool !== tool) return mention;
      changed = true;
      return { ...mention, values, named };
    });
    entities[key] = changed ? ({ ...entity, mentions } as Entity) : entity;
    touched ||= changed;
  }

  return touched ? { ...slice, entities } : slice;
}

/** The kind an existing job was started as; endings carry no `kind`. */
function existingJobKind(conversationId: string, jobId: string): string {
  const existing = entitiesOf(useEntityStore.getState(), conversationId).entities[`job:${jobId}`];
  return existing?.kind === 'job' ? existing.jobKind : 'job';
}

/** The message ids an entity was seen in — what the transcript filters to when one is selected. */
export function messagesFor(entity: Entity | undefined): Set<string> {
  return new Set(entity?.mentions.map((m) => m.messageId) ?? []);
}
