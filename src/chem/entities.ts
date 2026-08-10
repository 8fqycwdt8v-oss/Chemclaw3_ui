/**
 * The conversation's subjects.
 *
 * A chat transcript is a list of things that were *said*. A chemistry conversation is also about a
 * small set of things that *exist* — this molecule, that reaction, the job you started twenty
 * minutes ago, the note you cited — and the transcript is a terrible index for them: to answer
 * "what did we decide about the bromoanisole" you scroll. This store is that index.
 *
 * ## The promotion rule
 *
 * An entity is admitted **only from a structured source**: a tool call's arguments that parsed as
 * whole JSON, a job summary, a `note_id` the service listed. Never from loose prose alone.
 *
 * That is not fastidiousness. A rail fed by scanning answer text fills with near-misses, and a rail
 * full of noise is worse than no rail — a chemist stops reading it, and then the one entry that
 * mattered is missed too. Prose can still *link* to an entity this store already holds (that is
 * what the citation chips do); it cannot mint one.
 *
 * And it is the same rule that keeps `tool_result.preview` out: the service truncates it at an
 * arbitrary byte, and a SMILES cut short often stays valid as a smaller, wrong molecule.
 *
 * ### The structure a chemist supplied (`ingestUserStructure`)
 *
 * A molecule pasted, dropped as a MOL file, or drawn in the sketcher is admitted, and it satisfies
 * the rule rather than bending it. Read the rule for what it is defending against: *inference*. The
 * things it excludes — prose scanning, a truncated preview — are all cases where the UI guessed
 * that a run of characters was a molecule and could be wrong. Here there is no guess. A human
 * pointed at this structure, saw it drawn back to them, and pressed a button; the source is as
 * structured as a tool argument and considerably better attested than a job summary, because the
 * person who will read the rail is the person who put it there.
 *
 * It clears the two mechanical conditions as well: it round-trips through RDKit exactly like every
 * other admitted structure, and nothing about it is truncated. What it does *not* have is a turn
 * behind it — see `Mention.messageId` below.
 *
 * ## Identity
 *
 * Molecules are keyed by **canonical** SMILES, resolved through RDKit. Two spellings of one
 * compound must collapse or the rail shows it twice and can never join a computed value to the
 * structure it was computed for. Canonicalisation is asynchronous — it is a WASM call — so
 * ingestion is too, and the store is written after the await rather than before.
 *
 * Anything RDKit refuses is dropped rather than admitted under its raw string. A rail entry that is
 * not a molecule cannot be drawn, cannot be compared, and cannot be searched for; it is a row that
 * only takes up space.
 *
 * ## One index per conversation
 *
 * The store holds a slice per conversation id, and **every reader and every writer names the
 * conversation it means**. There is no "active conversation" pointer in here to keep in step with
 * `chatStore.activeId`, because the invariant this shape exists to guarantee — the rail and the
 * transcript always describe the same conversation — is exactly the kind that a second copy of the
 * current id quietly breaks. `MessageList` and `EntityRail` both render the slice of the
 * conversation id they were handed, and both take it from the same route parameter, so they cannot
 * disagree.
 *
 * It was one global bag before, scoped to nothing. Switching conversations left the previous one's
 * molecules, jobs and notes in the rail, and left `selected` pointing at them — so the transcript
 * filter matched the new conversation's message ids against the old conversation's mentions,
 * matched nothing, and rendered "no turn mentions that" over a conversation full of turns. Under a
 * router, where Back switches conversation in a keypress, that is not an edge case.
 *
 * **Keyed rather than cleared on switch**, and the reason is that entities are only ever minted by
 * a *live* stream: a reloaded transcript re-hydrates messages but re-ingests nothing. Clearing on
 * switch would therefore not lose an index that could be rebuilt on the way back — it would leave
 * every conversation but the current one permanently railless until someone sent a new turn into
 * it. Keying is also what a chemist expects of something titled "what this conversation is about".
 *
 * **Not persisted**, unlike `chatStore`. Two reasons, and the first is sufficient: everything here
 * is derived, and a persisted derivation is a second copy that drifts from the transcript it was
 * derived from — including across the trim `chatStore.partialize` performs on the transcript
 * itself, after which a persisted rail would name turns that no longer exist. The second is size:
 * this holds canonical SMILES, mention lists and job rows per conversation, with no bound of its
 * own. So a reload starts each rail empty, exactly as it does today. That understates the
 * conversation rather than misstating it, and the rail renders nothing at all when empty, so it
 * never claims a conversation was about nothing.
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
  /** How the user supplied it, when no tool did. Kept separate from `tool` rather than folded into
   *  it: the rail's provenance line answers "which tools touched this", and writing `sketch` there
   *  would be a tool name that does not exist. */
  source?: UserStructureSource;
  at: number;
}

/** How a structure reached the composer. */
export type UserStructureSource = 'paste' | 'file' | 'sketch';

/**
 * The `messageId` a composer-supplied structure is filed under.
 *
 * It matches no message, deliberately — there is no turn behind it yet. Selecting such an entity
 * therefore filters the transcript to nothing, which reads as "no turn has discussed this", and
 * that is exactly true. Once the message is sent, the turn's own `tool_call` events attach real
 * mentions to the same canonical key and the rail entry joins the conversation.
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
  /** The branch/PR reference, when the note came from a `note_proposed` rather than a citation. */
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

/** The slice a conversation with no entities has. A shared frozen constant rather than a fresh
 *  object, because it is what selectors return for such a conversation and Zustand compares
 *  selector results by reference — a new `{}` per render is an infinite render loop. */
export const NO_ENTITIES: ConversationEntities = Object.freeze({
  entities: {},
  order: [],
  selected: null,
});

export interface EntityState {
  /** Keyed by conversation id. See "one index per conversation" above. */
  byConversation: Record<string, ConversationEntities>;

  ingest: (conversationId: string, messageId: string, event: ChemclawEvent) => Promise<void>;
  /** Admit a structure the user pasted, dropped or drew. See the promotion rule above for why this
   *  belongs. Returns the canonical key, or `null` if RDKit refused — the caller has already shown
   *  the chemist a drawing, so a refusal here means something changed under it. */
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
    const add = (entity: Entity, tool?: string): void => {
      write(conversationId, (slice) =>
        upsert(slice, entity, { messageId, at, ...(tool ? { tool } : {}) }),
      );
    };

    switch (event.type) {
      case 'tool_call': {
        // `arguments` only, and only when it parses as a whole JSON document. That is the exact
        // boundary the service announces a call on, so a complete document is the normal case and
        // a truncated one is visibly not JSON.
        for (const raw of smilesFromArguments(event.arguments)) {
          if (looksLikeReactionSmiles(raw)) {
            // Not canonicalised: RDKit's minimal build has no reaction object, and canonicalising
            // each component separately would produce a key that is not a reaction SMILES. The
            // recogniser has already checked every component on both sides looks like a molecule,
            // which is as far as this can honestly go.
            add(
              {
                kind: 'reaction',
                key: `rxn:${raw}`,
                reactionSmiles: raw,
                mentions: [],
                firstSeen: at,
              },
              event.tool,
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
    // Canonicalised here rather than trusted from the caller, even though the composer has already
    // canonicalised it to draw the preview. The key is the identity of the entity; deriving it in
    // one place is what stops a second caller one day admitting a molecule under a raw spelling.
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

/** The kind an already-known job was started as. A completion and a failure both carry no `kind`,
 *  and losing it would relabel a DFT run as a generic job at the moment it most needs naming. */
function existingJobKind(conversationId: string, jobId: string): string {
  const existing = entitiesOf(useEntityStore.getState(), conversationId).entities[`job:${jobId}`];
  return existing?.kind === 'job' ? existing.jobKind : 'job';
}

/** The message ids an entity was seen in — what the transcript filters to when one is selected. */
export function messagesFor(entity: Entity | undefined): Set<string> {
  return new Set(entity?.mentions.map((m) => m.messageId) ?? []);
}
