/**
 * The conversation store. Zustand rather than `useReducer` + Context because the streaming loop
 * lives outside React and fires per token; `getState()`/`setState()` from plain TypeScript plus
 * selector-scoped subscriptions keep the composer and sidebar out of the per-token render path.
 */

import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { AwaitingAnswerEvent, ChemclawEvent, JobTerminalEvent } from '../../shared/events.ts';
import { useEntityStore } from '../chem/entities.ts';
import type { ApiErrorKind } from '../api/errors.ts';
// Type-only: the check-in wire shape is declared once, in the client.
import type { CheckIn, Digest } from '../api/client.ts';
import type {
  AssistantMessage,
  Banner,
  ChatMessage,
  ComposerLock,
  Conversation,
  TraceEntry,
  UserMessage,
} from './types.ts';
import { mergeTranscript } from './transcript.ts';

/**
 * One finished job, plus the session and timestamp the wire event does not carry (attached by the
 * consumer that opened the stream). `event` is the terminal union, so readers branch on
 * `event.type`.
 */
export interface JobFeedItem {
  event: JobTerminalEvent;
  sessionId: string;
  conversationId: string | null;
  /** When WE saw it. The backend sends no completion time, so the UI must not imply one. */
  receivedAt: number;
  seen: boolean;
  dismissed: boolean;
  /**
   * When `dismissed` last changed in this browser, so the cross-tab fold can tell another tab's
   * dismissal from this tab's later restore. Absent reads as 0.
   */
  dismissedChangedAt?: number;
}

/** Exactly the slice `partialize` writes to localStorage, and what `migrate` must return. */
interface PersistedState {
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
  /**
   * The half-written question per conversation. Persisted so a reload does not lose what the
   * chemist was typing.
   */
  drafts: Record<string, string>;
  jobFeed: JobFeedItem[];
  /**
   * Standing-query findings claimed from the service's mailbox. Persisted because the read consumes
   * them: `GET /digests` never re-delivers a row.
   */
  digests: DigestCard[];
  /**
   * The caller's own blocked questions, claimed from the same destructive mailbox as `digests`, so
   * persisted for the same reason.
   */
  checkIns: CheckInCard[];
  notifyOnJobComplete: boolean;
}

/** One claimed digest, plus what the wire shape does not carry. */
export interface DigestCard {
  query: string;
  noteIds: string[];
  /**
   * Which of `noteIds` the corpus now disagrees with, and one line per note. Optional (absent on
   * older persisted cards); readers default them.
   */
  disputed?: string[];
  headlines?: Record<string, string>;
  /** When WE claimed it. The service sends no timestamp, so nothing here may imply one. */
  receivedAt: number;
  dismissed: boolean;
}

/**
 * One claimed check-in. The service's fields are kept as they arrive (day counts are already
 * floored and never recomputed); `receivedAt` is when this browser claimed it.
 */
export interface CheckInCard {
  /**
   * This card's identity: the service's request id, or a content key when it is empty
   * (`checkInKey`), so id-less rows do not collapse into one.
   */
  requestId: string;
  /** What class of answer is wanted, badged as given — the pending inbox badges its rows by it too. */
  kind: string;
  subject: string;
  rationale: string;
  askedOf: string;
  openDays: number;
  daysLeft: number;
  /** The conversation that raised it, or empty — a plate run and a connector job have none. */
  sessionId: string;
  /** Whether the notice this arrived in was short of the whole set. See `CheckIn.truncated`. */
  truncated: boolean;
  /** When WE claimed it. The service sends no timestamp, so nothing here may imply one. */
  receivedAt: number;
  /**
   * When the last claim carrying this question landed — re-stamped on every refresh, unlike
   * `receivedAt`. `receivedAt` orders the list; `refreshedAt` says how fresh the countdown is and
   * decides which copy wins in `mergeWithStored`.
   */
  refreshedAt: number;
  dismissed: boolean;
}

/**
 * How this page's single claim of `GET /check-ins` went. Not persisted: it describes this page's
 * request. It lets an empty list mean "nothing blocked" only when the claim actually answered.
 */
export type ClaimState = 'pending' | 'ready' | 'failed' | 'absent';

/**
 * One migration step: takes the previous version's shape and returns the next, so `migrate`
 * composes them.
 */
function migrateV1toV2(state: Partial<PersistedState>): Partial<PersistedState> {
  const conversations: Record<string, Conversation> = {};
  for (const [id, conversation] of Object.entries(state.conversations ?? {})) {
    if (!conversation) continue;
    conversations[id] = {
      ...conversation,
      messages: (conversation.messages ?? []).map((m) =>
        m.role === 'assistant' && m.status === 'streaming'
          ? { ...m, status: 'aborted' as const }
          : m,
      ),
    };
  }
  const order = (state.order ?? []).filter((id) => conversations[id]);
  return {
    ...state,
    conversations,
    order,
    activeId: state.activeId && conversations[state.activeId] ? state.activeId : (order[0] ?? null),
  };
}

function migrateV2toV3(state: Partial<PersistedState>): Partial<PersistedState> {
  const conversations: Record<string, Conversation> = {};
  for (const [id, conversation] of Object.entries(state.conversations ?? {})) {
    if (!conversation) continue;
    // The field did not exist in v2, whatever the current type says the shape is.
    const origin = (conversation as Partial<Conversation>).sessionOrigin ?? 'local';
    conversations[id] = { ...conversation, sessionOrigin: origin };
  }
  return {
    ...state,
    conversations,
    // Empty, not reconstructed: a completion is an event we were told about, and inventing cards
    // for jobs nobody reported would be worse than starting the feed clean.
    jobFeed: state.jobFeed ?? [],
    notifyOnJobComplete: state.notifyOnJobComplete ?? false,
  };
}

/**
 * Bring whatever is on disk up to the current shape, as a chain of per-version steps. Unknown or
 * pre-v1 state becomes a clean slate.
 *
 * - v1 -> v2: repairs messages left mid-stream (there is no resume endpoint).
 * - v2 -> v3: adds the durable job feed and notification preference; `sessionOrigin` defaults to
 *   `'local'`.
 */
export function migratePersisted(persisted: unknown, version: number): PersistedState {
  // A version from the future is discarded, not migrated: an older bundle (canary or rollback)
  // cannot safely read a newer schema, and passing it through crashes the render on every reload.
  if (version > CHAT_PERSIST_VERSION) return emptyPersistedState();

  const steps: ((s: Partial<PersistedState>) => Partial<PersistedState>)[] = [];
  if (version < 2) steps.push(migrateV1toV2);
  if (version < 3) steps.push(migrateV2toV3);

  const state = persisted as Partial<PersistedState> | undefined;
  if (!state?.conversations || !state.order) return emptyPersistedState();

  try {
    const migrated = steps.reduce<Partial<PersistedState>>((acc, step) => step(acc), state);
    // Additive fields since v3, defaulted here without a version bump: an absent one means the same
    // as empty.
    return {
      ...migrated,
      drafts: migrated.drafts ?? {},
      digests: migrated.digests ?? [],
      checkIns: migrated.checkIns ?? [],
    } as PersistedState;
  } catch {
    // A step that throws on an unexpected shape yields the empty state rather than an unhandled
    // rejection from `persist.rehydrate()`.
    return emptyPersistedState();
  }
}

/** The schema version this build writes, and the ceiling `migratePersisted` refuses above. */
const CHAT_PERSIST_VERSION = 3;

const emptyPersistedState = (): PersistedState => ({
  conversations: {},
  order: [],
  activeId: null,
  drafts: {},
  jobFeed: [],
  digests: [],
  checkIns: [],
  notifyOnJobComplete: false,
});

/** Keep persisted state bounded — see `partialize` below. */
const MAX_CONVERSATIONS = 30;
/**
 * Most recent messages of one conversation written to disk, so one long conversation cannot exhaust
 * the quota. Memory keeps everything for the session.
 */
const MAX_PERSISTED_MESSAGES = 200;
const MAX_JOB_FEED = 50;
/** A completion older than this is history, not news. Bounds the persisted feed's size too. */
const JOB_FEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a check-in's countdown was last true, which is what ages it out (not `receivedAt`, which a
 * refresh keeps). Falls back to `receivedAt` for cards persisted before `refreshedAt`.
 */
const checkInFreshAt = (card: Pick<CheckInCard, 'receivedAt'> & { refreshedAt?: number }): number =>
  card.refreshedAt ?? card.receivedAt;

/**
 * Bound on claimed check-ins; a claim can be hundreds of kilobytes and must not crowd out
 * transcript persistence.
 */
const MAX_CHECK_INS = 200;

/**
 * Bound on claimed digests, matching `MAX_CHECK_INS` (same mailbox, similar card size).
 * `shedOldest` cannot drop digests (they are the only copy), so without a count bound a long list
 * would stop transcript persistence.
 */
const MAX_DIGESTS = 200;

/**
 * A check-in's identity: `request_id`, or a content key when it is empty, so two id-less questions
 * do not fold into one card (which, with a consuming read, would destroy one).
 */
export const checkInKey = (row: {
  requestId: string;
  subject: string;
  rationale: string;
}): string => row.requestId || `\u0000${row.subject}\u0000${row.rationale}`;
const MAX_TRACE_ENTRIES = 200;
const TITLE_MAX = 60;

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const titleFrom = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'New conversation';
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
};

/** Narrowing predicate, so `find` hands back a `UserMessage` rather than a `ChatMessage`. */
const isUser = (m: ChatMessage): m is UserMessage => m.role === 'user';

export function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: uid(),
    sessionId: null,
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
    contextLost: false,
    // Locally minted until something says otherwise; the server merge and the shared-link
    // resolver both override this explicitly.
    sessionOrigin: 'local',
  };
}

function newAssistantMessage(): AssistantMessage {
  return {
    id: uid(),
    role: 'assistant',
    at: Date.now(),
    status: 'streaming',
    streamedText: '',
    finalText: null,
    confidence: null,
    unsupportedClaims: [],
    reviewRequired: false,
    verifiedBy: null,
    degradedConnectors: [],
    partialReason: null,
    queued: false,
    trace: [],
    latestPlan: null,
    latestPlanHash: null,
    latestPlanScope: null,
    endedAt: null,
    correlationId: '',
    stalled: false,
    error: null,
  };
}

/**
 * Close the oldest still-open `tool_call` row for `tool` with how it ended. Calls are announced at
 * issue, so an open row means "running". No call id on the wire: two concurrent calls to the same
 * tool returning out of order pair the wrong way. An ending whose row was dropped by
 * `MAX_TRACE_ENTRIES` is discarded.
 */
function closeToolCall(
  trace: TraceEntry[],
  tool: string,
  ending:
    | {
        result: string;
        resultRef?: string;
        resultCut?: boolean;
        resultInline?: string;
        numbers?: number[];
        values?: { label: string; value: number; unit: string }[];
      }
    | { failed: true },
): TraceEntry[] {
  // Our clock, at the moment the ending reached this process. Nothing on the wire carries a tool
  // duration, so this is the only honest one available — and it is the wait the reader had.
  const endedAt = Date.now();
  const index = openCallIndex(trace, tool);
  const target = trace[index];
  if (index === -1 || !target?.toolCall) return trace;
  // The queue annotation describes a call still out; an ended row keeps no stale "queued".
  const { queue: _queue, ...call } = target.toolCall;
  const updated: TraceEntry = { ...target, toolCall: { ...call, ...ending, endedAt } };
  return [...trace.slice(0, index), updated, ...trace.slice(index + 1)];
}

/** The oldest still-open `tool_call` row for `tool`, or -1 — the pairing rule `closeToolCall`
 *  documents, shared with `markQueued` so a queue annotation lands on the row a result would. */
function openCallIndex(trace: TraceEntry[], tool: string): number {
  return trace.findIndex(
    (entry) =>
      entry.kind === 'tool_call' &&
      entry.toolCall?.tool === tool &&
      entry.toolCall.result === undefined &&
      !entry.toolCall.failed,
  );
}

/**
 * Record a queued call's position on its open row (not a new row). Paired by job id first; an
 * unseen job id takes the oldest unannotated open row for the tool, then the oldest. Updates for
 * ended or dropped calls are discarded.
 */
function markQueued(
  trace: TraceEntry[],
  tool: string,
  queue: { state: 'queued' | 'running'; waiting: number | null; jobId: string },
): TraceEntry[] {
  const open = (entry: TraceEntry): boolean =>
    entry.kind === 'tool_call' &&
    entry.toolCall?.tool === tool &&
    entry.toolCall.result === undefined &&
    !entry.toolCall.failed;
  let index = trace.findIndex(
    (entry) => open(entry) && entry.toolCall?.queue?.jobId === queue.jobId,
  );
  if (index === -1) index = trace.findIndex((entry) => open(entry) && !entry.toolCall?.queue);
  if (index === -1) index = openCallIndex(trace, tool);
  const target = trace[index];
  if (index === -1 || !target?.toolCall) return trace;
  const updated: TraceEntry = { ...target, toolCall: { ...target.toolCall, queue } };
  return [...trace.slice(0, index), updated, ...trace.slice(index + 1)];
}

/**
 * Fold one evidence source's report into the sweep row it belongs to. Consecutive events of one
 * `gather_evidence` call form one row, saving the bounded trace budget. Returns `null` when this
 * event starts a new sweep.
 */
function foldIntoSweep(trace: TraceEntry[], entry: TraceEntry): TraceEntry[] | null {
  const last = trace[trace.length - 1];
  const reported = entry.evidenceSweep?.[0];
  if (!last || last.kind !== 'evidence_source' || !last.evidenceSweep || !reported) return null;
  const merged: TraceEntry = {
    ...last,
    // The sweep's own end, so the row can say how long every source took together. The entry's
    // `at` stays the first source's, which is when the sweep began.
    evidenceSweepEndedAt: entry.at,
    evidenceSweep: [...last.evidenceSweep, reported],
  };
  return [...trace.slice(0, -1), merged];
}

/**
 * Mark a `job_started` row as ended, so its "runs asynchronously" badge comes off. Matched on job
 * id; a launch row already dropped, or from another turn, leaves the trace alone.
 */
function settleJob(trace: TraceEntry[], jobId: string): TraceEntry[] {
  const index = trace.findIndex(
    (entry) => entry.kind === 'job_started' && entry.job?.jobId === jobId && !entry.job.settled,
  );
  const target = trace[index];
  if (index === -1 || !target?.job) return trace;
  const updated: TraceEntry = {
    ...target,
    job: { ...target.job, settled: true, endedAt: Date.now() },
  };
  return [...trace.slice(0, index), updated, ...trace.slice(index + 1)];
}

/** Map one stream event onto a trace entry, or null for `token` (which is not trace). */
function traceEntryFor(event: ChemclawEvent): TraceEntry | null {
  const base = { id: uid(), at: Date.now() };
  switch (event.type) {
    case 'plan':
      return { ...base, kind: 'plan', plan: { todos: event.todos } };
    case 'tool_call':
      return {
        ...base,
        kind: 'tool_call',
        toolCall: { tool: event.tool, arguments: event.arguments, agent: event.agent },
      };
    case 'job_failed':
      return {
        ...base,
        kind: 'job_failed',
        jobFailure: { jobId: event.job_id, reason: event.reason },
      };
    case 'tool_failed':
      return {
        ...base,
        kind: 'tool_failed',
        toolFailure: {
          tool: event.tool,
          message: event.message,
          reason: event.reason ?? null,
          // As on the `tool_call` row: the service defaults it, so empty is "the main agent" and
          // the row has to be able to say the other thing.
          agent: event.agent,
        },
      };
    // Every source is kept, successes included, so the sweep row can show which sources were asked
    // and which failed.
    case 'evidence_source': {
      const reported = {
        source: event.source,
        chunks: event.chunks,
        failed: event.failed === true,
      };
      return {
        ...base,
        kind: 'evidence_source',
        // Every entry starts as a one-source sweep so `foldIntoSweep` has one shape to merge into
        // and from.
        evidenceSweep: [reported],
        // The same source again, under the field a trace persisted before `evidenceSweep`
        // existed carries. Rehydrated transcripts still render from it.
        evidenceSource: reported,
      };
    }
    case 'job_started':
      return {
        ...base,
        kind: 'job_started',
        job: {
          jobId: event.job_id,
          kind: event.kind,
          // Only when the service sent one — an empty string carries no step to badge, and an
          // absent field is what the plan card's derivation treats as "no link".
          ...(event.plan_step ? { planStep: event.plan_step } : {}),
        },
      };
    case 'job_completed':
      return {
        ...base,
        kind: 'job_completed',
        job: { jobId: event.job_id, summary: event.summary },
      };
    case 'question':
      return {
        ...base,
        kind: 'question',
        question: { question: event.question, options: event.options },
      };
    // The wire event is `note_recorded`; the row keeps the kind it was persisted under.
    case 'note_recorded':
      return {
        ...base,
        kind: 'note_proposed',
        note: { noteId: event.note_id, reference: event.reference },
      };
    case 'approval_request':
      return {
        ...base,
        kind: 'approval_request',
        approval: { prompt: event.prompt },
      };
    case 'handoff':
      return {
        ...base,
        kind: 'handoff',
        handoff: { from: event.from_agent, to: event.to_agent, reason: event.reason },
      };
    // A trace row rather than a message field, so the artefact card sits beside result blocks and
    // repeated revisions stay in order.
    case 'exhibit':
      return {
        ...base,
        kind: 'exhibit',
        exhibit: {
          exhibitId: event.exhibit_id,
          revision: event.revision,
          kind: event.kind,
          title: event.title,
          op: event.op,
          authorKind: event.author_kind,
          author: event.author,
        },
      };
    // Not trace rows. Each is handled before this function (`applyEvent`) or by another consumer
    // (`sendMessage` for drafts, the job stream for `awaiting_answer`). Named, not defaulted, so a
    // kind the contract gains fails the typecheck here until someone decides what it is.
    case 'token':
    case 'answer':
    case 'tool_queued':
    case 'queued':
    case 'capability_degraded':
    case 'error':
    case 'tool_result':
    case 'awaiting_answer':
    case 'exhibit_draft':
      return null;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

export interface ChatState {
  /**
   * The signed-in account id (`oid`) whose history this store holds, or `null`. Not persisted; set
   * by `hydrateChatForAccount`. Used to label the reader's own messages "You" in shared
   * conversations.
   */
  viewer: string | null;
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
  composerLock: ComposerLock;
  banner: Banner | null;
  /** Unsent text per conversation (the composer does not unmount on a conversation switch). */
  drafts: Record<string, string>;
  /**
   * The agent profile a not-yet-created session should use, per conversation. Not persisted: it
   * only matters until the session exists.
   */
  sessionProfiles: Record<string, string>;
  /** Cross-turn job endings — successes and failures — from `GET /sessions/{id}/events`.
   *  Persisted since v3. */
  jobFeed: JobFeedItem[];
  /** Standing-query findings claimed from the service's destructive mailbox — see `DigestCard`. */
  digests: DigestCard[];
  /** The caller's own blocked questions, from the same destructive mailbox — see `CheckInCard`. */
  checkIns: CheckInCard[];
  /** How this page's one claim of `GET /check-ins` went — see `ClaimState`. */
  checkInClaim: ClaimState;
  /** True once the backend has told *this tab* twice that we are over its stream cap. */
  jobStreamsThrottled: boolean;
  /**
   * True while the tab holding the account's streams reports being over the cap. Separate from
   * `jobStreamsThrottled` (this tab's own, irreversible evidence): a relayed report follows its
   * reporter and clears when it says `false` or a new leader publishes. It drives the indicator,
   * never the budget.
   */
  jobStreamsThrottledElsewhere: boolean;
  /**
   * Sessions whose job stream has failed to connect repeatedly. A list, because one boolean would
   * flap across sessions. Not persisted.
   */
  jobStreamsFailing: string[];
  /**
   * Request ids a person must answer before durable work can continue. A notification cache fed by
   * `awaiting_answer` frames and replaced wholesale by `syncAwaiting` from `GET /pending`, the
   * authority. Not persisted, so a reload cannot show a badge for an already-answered question.
   */
  awaiting: string[];
  /**
   * Bumped by `noteAwaiting`, never by `syncAwaiting`: lets the inbox re-read `GET /pending` on a
   * push without its own read re-triggering itself.
   */
  awaitingRevision: number;
  /** Opt-in, and deliberately separate from `Notification.permission` — a browser-level
   *  revocation must read as "blocked", not as "off". */
  notifyOnJobComplete: boolean;
  streaming: {
    conversationId: string;
    messageId: string;
    abort: AbortController;
    /**
     * Stop the turn on the server, then abort the local stream. Aborting alone would leave the turn
     * running, since the backend detaches on disconnect.
     */
    stop: () => void;
    /**
     * The same cancellation sent while the document is discarded: only a `keepalive` request
     * survives navigation. See `src/state/sendMessage.ts`.
     */
    abandon: () => void;
  } | null;

  createConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
  setSessionId: (conversationId: string, sessionId: string, contextLost?: boolean) => void;
  hydrateTranscript: (conversationId: string, messages: ChatMessage[]) => void;
  /**
   * Merge a re-read transcript into a conversation that already has messages (shared-conversation
   * sync), against the messages as they are now. See `mergeTranscript`. Returns whether anything
   * changed.
   */
  mergeRemoteTranscript: (conversationId: string, remote: ChatMessage[]) => boolean;
  /** Open a placeholder for somebody else's running turn, followed live. See
   *  `AssistantMessage.watched`. Returns its id. */
  startWatchedTurn: (conversationId: string) => string;
  /**
   * Remove watched placeholders when the view closes before the re-read replaces them. Returns
   * whether there was one.
   */
  dropWatchedTurns: (conversationId: string) => boolean;
  attachPlan: (
    conversationId: string,
    todos: string[],
    planHash: string,
    awaitingApproval?: boolean,
    scope?: string[] | null,
    /** Whose turn wrote the plan, as the plan route reports it — see
     *  `AssistantMessage.latestPlanAuthor`. Omitted leaves the field absent. */
    author?: string | null,
  ) => void;
  /**
   * Record whether this person is a member of somebody else's conversation, and whose (from `GET
   * /sessions/shared` and `GET /sessions/{id}/members`); `undefined` when they own it.
   */
  setMembership: (conversationId: string, membership: { owner: string | null } | undefined) => void;

  appendUserMessage: (conversationId: string, text: string) => string;
  startAssistantMessage: (conversationId: string) => string;
  appendTokens: (conversationId: string, messageId: string, text: string) => void;
  applyEvent: (conversationId: string, messageId: string, event: ChemclawEvent) => void;
  /** Record the service's id for this turn, so a successful answer is findable in its logs too. */
  setCorrelationId: (conversationId: string, messageId: string, correlationId: string) => void;
  /** The stream has gone quiet, or come back. Never ends the turn — see `AssistantMessage.stalled`. */
  setTurnStalled: (conversationId: string, messageId: string, stalled: boolean) => void;
  finishTurn: (conversationId: string, messageId: string, status: 'done' | 'aborted') => void;
  /**
   * End a turn whose queued message was withdrawn: settled as `aborted`, with the reason on
   * `AssistantMessage.withdrawn`.
   */
  withdrawTurn: (conversationId: string, messageId: string, reason: string) => void;
  failTurn: (
    conversationId: string,
    messageId: string,
    error: { kind: ApiErrorKind; message: string },
  ) => void;

  setComposerLock: (lock: ComposerLock) => void;
  setBanner: (banner: Banner | null) => void;
  setDraft: (conversationId: string, text: string) => void;
  setSessionProfile: (conversationId: string, profile: string) => void;
  setStreaming: (s: ChatState['streaming']) => void;
  pushJobFinished: (event: JobTerminalEvent, sessionId: string) => void;
  /**
   * Record one `awaiting_answer` frame: add on `state: 'waiting'`, remove on anything else (an
   * expiry is pushed too). Idempotent on `request_id` (reminders and reconnects re-push).
   */
  noteAwaiting: (event: AwaitingAnswerEvent) => void;
  /**
   * Replace the list with what `GET /pending` holds. Every inbox read calls it, and `App.tsx` once
   * per page, since the stream's claim is destructive and a reload replays nothing.
   */
  syncAwaiting: (requestIds: string[]) => void;
  /**
   * Record claimed digests, dropping duplicates by (query, note ids) — a second tab or StrictMode
   * can deliver the same claim twice.
   */
  addDigests: (digests: Digest[]) => void;
  dismissDigest: (index: number) => void;
  /**
   * Record this page's claimed check-ins and mark the claim answered. Keyed by `checkInKey`; an
   * existing card is refreshed, not dropped, because the nightly sweep re-sends the same question
   * with updated day counts. `dismissed` survives a refresh. Called with `[]` for an empty mailbox.
   */
  addCheckIns: (claimed: CheckIn[]) => void;
  /** Record that this page's one claim did not land, so the surface can say so rather than read
   *  as an empty mailbox. */
  failCheckInClaim: () => void;
  /** The service answered 404: no check-in mailbox. Distinct from an empty one. */
  markCheckInsAbsent: () => void;
  /** Dismiss one card, identified by `checkInKey` rather than by its possibly-empty id. */
  dismissCheckIn: (key: string) => void;
  /**
   * Make a local conversation for a session forked from `parentId`, carrying the parent's messages.
   * Returns the new id, or `null` if the parent is gone.
   */
  adoptFork: (parentId: string, sessionId: string) => string | null;
  dismissJobItem: (jobId: string) => void;
  restoreJobItem: (jobId: string) => void;
  markJobsSeen: () => void;
  /**
   * Stop polling for a reload-interrupted turn whose recovery budget is spent and whose answer is
   * not on the server. Only if the flag is still set, so a newer turn is left alone.
   */
  giveUpOnInterruptedTurn: (
    conversationId: string,
    messageId: string,
    /** What the bubble now says, when the reason it ended is known better than "interrupted". */
    why?: string,
  ) => void;
  /**
   * A reload-interrupted turn is still running and this page reattached: show it streaming again,
   * or with `false` revert to what `partialize` left. `interruptedByReload` stays set until it
   * settles.
   */
  followInterruptedTurn: (conversationId: string, messageId: string, following: boolean) => void;
  setJobStreamsThrottled: (throttled: boolean) => void;
  setJobStreamsThrottledElsewhere: (throttled: boolean) => void;
  setJobStreamFailing: (sessionId: string, failing: boolean) => void;
  setNotifyOnJobComplete: (enabled: boolean) => void;
  /** Set the session id only if there is not one already, returning whichever id now wins. */
  setSessionIdIfAbsent: (conversationId: string, sessionId: string) => string;
}

/** Apply `fn` to the assistant message with `messageId`, leaving all other state untouched. */
const updateAssistant = (
  state: ChatState,
  conversationId: string,
  messageId: string,
  fn: (m: AssistantMessage) => AssistantMessage,
): Partial<ChatState> => {
  const conversation = state.conversations[conversationId];
  if (!conversation) return {};
  return {
    conversations: {
      ...state.conversations,
      [conversationId]: {
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map((m) =>
          m.id === messageId && m.role === 'assistant' ? fn(m) : m,
        ),
      },
    },
  };
};

/**
 * Minimum messages worth keeping for one conversation on disk; below this, dropping the write and
 * warning is better.
 */
const MIN_PERSISTED_MESSAGES = 10;

/**
 * Persist a settled answer once. When `finalText` is non-empty no reader consults `streamedText`,
 * so it is dropped from the persisted copy (it would otherwise double the size). Aborted or capped
 * turns keep their streamed text, which may be the only copy.
 */
function withoutDuplicateAnswer(m: ChatMessage): ChatMessage {
  if (m.role !== 'assistant' || !m.finalText) return m;
  return m.streamedText ? { ...m, streamedText: '' } : m;
}

/**
 * Shrink a refused payload in two stages, never to nothing: first halve the conversations (keeping
 * at least one), then halve the last conversation's messages (keeping the newest). `null` means it
 * cannot fit; the caller latches `storageWritable` off and warns.
 */
function shedOldest(state: PersistedState): PersistedState | null {
  if (state.order.length > 1) {
    const order = state.order.slice(0, Math.max(1, Math.floor(state.order.length / 2)));
    const conversations: Record<string, Conversation> = {};
    for (const id of order) {
      const conversation = state.conversations[id];
      if (conversation) conversations[id] = conversation;
    }
    return {
      ...state,
      order,
      conversations,
      activeId:
        state.activeId && conversations[state.activeId] ? state.activeId : (order[0] ?? null),
      jobFeed: state.jobFeed.filter(
        (j) => j.conversationId === null || conversations[j.conversationId],
      ),
    };
  }

  const id = state.order[0];
  const only = id ? state.conversations[id] : undefined;
  if (!id || !only || only.messages.length <= MIN_PERSISTED_MESSAGES) return null;

  const keep = Math.max(MIN_PERSISTED_MESSAGES, Math.floor(only.messages.length / 2));
  return {
    ...state,
    conversations: { [id]: { ...only, messages: only.messages.slice(-keep) } },
  };
}

/**
 * `localStorage` plus three things `createJSONStorage` lacks: a refused write sheds and retries, a
 * write that cannot succeed is swallowed (never an unhandled rejection in a send), and the disk
 * write is throttled to `PERSIST_THROTTLE_MS` (the in-memory store is not). `flushChatPersistence`
 * forces the latest value out on `pagehide`/`beforeunload`.
 */
let storageWritable = true;

const PERSIST_THROTTLE_MS = 750;
let scheduledName: string | null = null;
let scheduledValue: StorageValue<PersistedState> | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;

/**
 * How many conversations this browser has been shown to accept, learned from a refusal, so an
 * over-quota tab sheds once rather than on every flush. Per page, not persisted;
 * `MAX_CONVERSATIONS` stays the ceiling.
 */
let learnedConversationCap = MAX_CONVERSATIONS;

/** Apply what we have learned, cheaply, before stringifying anything. */
function withinLearnedCap(state: PersistedState): PersistedState {
  if (state.order.length <= learnedConversationCap) return state;
  const order = state.order.slice(0, learnedConversationCap);
  const conversations: Record<string, Conversation> = {};
  for (const id of order) {
    const conversation = state.conversations[id];
    if (conversation) conversations[id] = conversation;
  }
  return {
    ...state,
    order,
    conversations,
    activeId: state.activeId && conversations[state.activeId] ? state.activeId : (order[0] ?? null),
    jobFeed: state.jobFeed.filter(
      (j) => j.conversationId === null || conversations[j.conversationId],
    ),
  };
}

/**
 * Conversations this tab deleted, so the merge below cannot resurrect them from another tab's copy
 * on disk. In memory, per tab.
 */
const tombstoned = new Set<string>();

/** Record a deliberate removal, so a later merge does not undo it. See `mergeWithStored`. */
export function forgetConversationOnDisk(...ids: string[]): void {
  for (const id of ids) tombstoned.add(id);
}

/**
 * Fold in conversations another tab wrote, so two tabs flushing their whole maps do not erase each
 * other's conversations. Same-id collisions keep the newer `updatedAt`; tombstoned ids are skipped.
 * This is not live cross-tab sync — another tab's conversations appear here only after a reload.
 */
function mergeWithStored(name: string, next: PersistedState): PersistedState {
  let stored: PersistedState | undefined;
  try {
    const raw = localStorage.getItem(name);
    if (!raw) return next;
    stored = (JSON.parse(raw) as StorageValue<PersistedState>).state;
  } catch {
    // Unreadable or not ours to parse. There is nothing to merge, and refusing to write would
    // turn an unreadable neighbour into a total loss of our own history.
    return next;
  }
  if (!stored?.conversations || !Array.isArray(stored.order)) return next;

  /**
   * Newest first by each row's own `receivedAt`, because every caller then slices to its cap: the
   * oldest rows are dropped wherever they came from. Ties favour this tab's rows (see `union`).
   */
  const newestFirst = <T extends { receivedAt: number }>(rows: T[]): T[] =>
    rows.sort((a, b) => b.receivedAt - a.receivedAt);
  /**
   * Fold back the slices a re-fetch cannot replace (`digests`, check-ins, the job feed), whose
   * claims are destructive. Done before the `extra.length === 0` return, since the other tab may
   * have claimed something while conversations are unchanged.
   */
  const union = <T extends { receivedAt: number }>(
    ours: T[],
    theirs: T[] | undefined,
    keyOf: (row: T) => string,
    fresher: (ours: T, theirs: T) => T,
  ): T[] => {
    if (!Array.isArray(theirs) || theirs.length === 0) return ours;
    const known = new Map(ours.map((row) => [keyOf(row), row]));
    const added = theirs.filter((row) => !known.has(keyOf(row)));
    // On a key collision, ours wins for a digest (same content, same finding) but not for a
    // check-in, whose content is a countdown: the fresher copy wins.
    for (const row of theirs) {
      const mine = known.get(keyOf(row));
      if (mine !== undefined) known.set(keyOf(row), fresher(mine, row));
    }
    // `sort` is stable and this tab's rows go first, so ties keep ours (a batch shares one
    // `Date.now()`).
    return newestFirst([...known.values(), ...added]);
  };
  // Fold reader actions too: `seen` is OR-ed; `dismissed` takes the later change, a tie keeps the
  // dismissal. Stored rows are aged on `partialize`'s cutoff first, or a just-dropped row would be
  // written straight back.
  const cutoff = Date.now() - JOB_FEED_MAX_AGE_MS;
  const jobFeed = union(
    next.jobFeed,
    Array.isArray(stored.jobFeed) ? stored.jobFeed.filter((j) => j.receivedAt > cutoff) : [],
    (j) => j.event.job_id,
    (mine, theirs) => {
      const mineAt = mine.dismissedChangedAt ?? 0;
      const theirsAt = theirs.dismissedChangedAt ?? 0;
      const decided = mineAt === theirsAt ? null : mineAt > theirsAt ? mine : theirs;
      return {
        ...mine,
        seen: mine.seen || theirs.seen,
        dismissed: decided ? decided.dismissed : mine.dismissed || theirs.dismissed,
        dismissedChangedAt: Math.max(mineAt, theirsAt),
      };
    },
  ).slice(0, MAX_JOB_FEED);
  // Same identity as `addDigests`, so a row both tabs claimed folds to one; dismissal is OR-ed.
  const digests = union(
    next.digests ?? [],
    Array.isArray(stored.digests) ? stored.digests.filter((d) => d.receivedAt > cutoff) : [],
    (d) => `${d.query}\u0000${d.noteIds.join(',')}`,
    (mine, theirs) => (theirs.dismissed && !mine.dismissed ? { ...mine, dismissed: true } : mine),
  ).slice(0, MAX_DIGESTS);
  // Keyed by request id; both sides aged out first so a dropped stale countdown is not written
  // back.
  const checkIns = union(
    next.checkIns ?? [],
    (stored.checkIns ?? []).filter((c) => checkInFreshAt(c) > cutoff),
    checkInKey,
    // The fresher countdown wins, but `dismissCheckIn` does not move `refreshedAt`, so a dismissal
    // is carried across whichever copy that picks — nothing un-dismisses a check-in.
    (mine, theirs) => {
      const winner = theirs.refreshedAt > mine.refreshedAt ? theirs : mine;
      return { ...winner, dismissed: mine.dismissed || theirs.dismissed };
    },
  ).slice(0, MAX_CHECK_INS);
  const carried: PersistedState = { ...next, jobFeed, digests, checkIns };

  const extra = stored.order.filter((id) => {
    if (tombstoned.has(id)) return false;
    const theirs = stored.conversations[id];
    if (!theirs) return false;
    const ours = next.conversations[id];
    return !ours || theirs.updatedAt > ours.updatedAt;
  });
  if (extra.length === 0) return carried;

  const conversations = { ...next.conversations };
  for (const id of extra) conversations[id] = stored.conversations[id] as Conversation;
  return {
    ...carried,
    conversations,
    order: [...next.order, ...extra.filter((id) => !next.order.includes(id))],
    drafts: {
      ...Object.fromEntries(extra.map((id) => [id, stored.drafts?.[id] ?? ''])),
      ...next.drafts,
    },
  };
}

function writeChatStorageNow(name: string, value: StorageValue<PersistedState>): void {
  if (!storageWritable) return;
  const merged = mergeWithStored(name, value.state);
  /** How many conversations this write *wanted* to keep, before the learned cap trimmed it. */
  const wanted = merged.order.length;
  let state: PersistedState | null = withinLearnedCap(merged);
  /**
   * Whether this write had to shed to land. Only a refusal teaches anything about the quota; a
   * success may just be a small payload.
   */
  let shed = false;
  while (state) {
    try {
      localStorage.setItem(name, JSON.stringify({ ...value, state }));
      // Never to zero: a cap of nothing is the empty-state bug again by another route.
      if (shed) {
        learnedConversationCap = Math.max(1, Math.min(learnedConversationCap, state.order.length));
      } else if (wanted > learnedConversationCap && learnedConversationCap < MAX_CONVERSATIONS) {
        // Probe the cap back up by one after a successful write, so deleting an oversized
        // conversation lets the tab persist more again. One step, because truncation happens before
        // the write and a success proves only the cap itself fits. Only when `wanted > cap`, so an
        // empty store never probes.
        learnedConversationCap += 1;
      }
      return;
    } catch {
      shed = true;
      state = shedOldest(state);
    }
  }
  storageWritable = false;
  console.warn('chemclaw3: local history could not be saved (storage is full or unavailable).');
}

/** Force the most recently coalesced write out immediately, bypassing the throttle window. */
export function flushChatPersistence(): void {
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  if (scheduledName === null || scheduledValue === null) return;
  const name = scheduledName;
  const value = scheduledValue;
  scheduledName = null;
  scheduledValue = null;
  lastWriteAt = Date.now();
  writeChatStorageNow(name, value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushChatPersistence);
  window.addEventListener('beforeunload', flushChatPersistence);
  window.addEventListener('pagehide', abandonTurnOnUnload);
}

/**
 * Cancel the running turn when the page is discarded (`pagehide` with `persisted: false`). A
 * disconnect only detaches, so otherwise the turn runs to completion holding an admission permit. A
 * back/forward-cache entry (`persisted: true`) is left alone; a reload is indistinguishable from a
 * close here and is cancelled too. In-app route changes are not affected.
 */
function abandonTurnOnUnload(event: PageTransitionEvent): void {
  if (event.persisted) return;
  useChatStore.getState().streaming?.abandon();
}

const chatStorage: PersistStorage<PersistedState> = {
  getItem(name) {
    try {
      const raw = localStorage.getItem(name);
      return raw === null ? null : (JSON.parse(raw) as StorageValue<PersistedState>);
    } catch {
      // Unreadable (private mode, denied storage, or corrupt JSON) reads as "nothing stored",
      // which is a clean first-run rather than a boot failure.
      return null;
    }
  },

  setItem(name, value) {
    // Latched off after a write that could not land even with a single conversation in it. That
    // is storage being denied rather than full — shedding cannot help.
    if (!storageWritable) return;
    scheduledName = name;
    scheduledValue = value;
    const elapsed = Date.now() - lastWriteAt;
    if (elapsed >= PERSIST_THROTTLE_MS) {
      flushChatPersistence();
      return;
    }
    if (throttleTimer === null) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        flushChatPersistence();
      }, PERSIST_THROTTLE_MS - elapsed);
    }
  },

  removeItem(name) {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to do and nothing to report: the value we wanted gone is already unreachable.
    }
  },
};

/**
 * Forget every conversation, in memory and on disk — the other half of sign-out, since transcripts
 * live in `localStorage` while MSAL's credential is in `sessionStorage`. `clearAll` first (it
 * writes through persist), then remove the key. Also used by "Reset app".
 */
export function forgetLocalHistory(): void {
  useChatStore.getState().clearAll();
  useChatStore.persist.clearStorage();
}

/**
 * The persisted-history key base. The full key is per account (`<base>.<oid>`, `'anon'` before
 * sign-in), so a shared workstation never rehydrates the previous chemist's conversations. The base
 * is frozen: changing it wipes everyone's history.
 */
export const CHAT_STORAGE_BASE = 'chemclaw3.chat.v2';

/** The persisted-history key for a given account `oid` (`'anon'` before one is known). */
export function chatStorageKey(oid: string | null | undefined): string {
  return `${CHAT_STORAGE_BASE}.${oid ?? 'anon'}`;
}

/**
 * Point the persisted store at an account's slot and load it — the other half of `skipHydration:
 * true`. Called by the auth bootstrap once the `oid` is known; a no-op when the slot is already
 * loaded.
 */
let hydratedName: string | null = null;

export function hydrateChatForAccount(oid: string | null | undefined): void {
  const name = chatStorageKey(oid);
  // Read each slot once: a second `rehydrate()` would replace live, not-yet-flushed state with the
  // throttled disk value. The viewer is set before that guard.
  if (useChatStore.getState().viewer !== (oid ?? null))
    useChatStore.setState({ viewer: oid ?? null });
  if (hydratedName === name) return;
  if (useChatStore.persist.getOptions().name !== name) {
    useChatStore.persist.setOptions({ name });
  }
  hydratedName = name;
  void useChatStore.persist.rehydrate();
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      viewer: null,
      conversations: {},
      order: [],
      activeId: null,
      composerLock: false,
      banner: null,
      drafts: {},
      digests: [],
      checkIns: [],
      checkInClaim: 'pending',
      sessionProfiles: {},
      jobFeed: [],
      jobStreamsThrottled: false,
      jobStreamsThrottledElsewhere: false,
      jobStreamsFailing: [],
      awaiting: [],
      awaitingRevision: 0,
      notifyOnJobComplete: false,
      streaming: null,

      // Neither clears `composerLock`: the lock and the `streaming` slot are global (one turn at a
      // time), and clearing it on a switch would let a second turn orphan the first.
      createConversation() {
        const conversation = newConversation();
        set((s) => ({
          conversations: { ...s.conversations, [conversation.id]: conversation },
          order: [conversation.id, ...s.order],
          activeId: conversation.id,
          banner: null,
        }));
        return conversation.id;
      },

      selectConversation(id) {
        if (!get().conversations[id]) return;
        set({ activeId: id, banner: null });
      },

      deleteConversation(id) {
        // Stop a turn belonging to the deleted conversation through `stop()` (server stop, then
        // abort), not `abort()`: a disconnect only detaches, so the turn would keep running.
        const streaming = get().streaming;
        const wasStreamingThis = streaming?.conversationId === id;
        if (wasStreamingThis) streaming?.stop();

        // The entity index is keyed by conversation and goes with it.
        useEntityStore.getState().forget(id);
        // And a tombstone, so the cross-tab merge in `writeChatStorageNow` cannot bring it back
        // from a copy another tab left on disk.
        forgetConversationOnDisk(id);

        set((s) => {
          const { [id]: _removed, ...rest } = s.conversations;
          const { [id]: _draft, ...drafts } = s.drafts;
          // Drop the conversation's profile choice too, or the map grows without bound.
          const { [id]: _profile, ...sessionProfiles } = s.sessionProfiles;
          const order = s.order.filter((x) => x !== id);
          return {
            conversations: rest,
            drafts,
            sessionProfiles,
            order,
            activeId: s.activeId === id ? (order[0] ?? null) : s.activeId,
            // Unlock the composer: the turn it waited on can no longer report back.
            ...(wasStreamingThis
              ? { streaming: null, composerLock: false as const, banner: null }
              : {}),
          };
        });
      },

      clearAll() {
        // Reset leaves nothing running: stop any in-flight turn on the server first.
        get().streaming?.stop();
        // Same reason as `deleteConversation`: every conversation these indexes describe is about
        // to stop existing.
        useEntityStore.getState().clear();
        forgetConversationOnDisk(...get().order);
        set(() => {
          const fresh = newConversation();
          return {
            conversations: { [fresh.id]: fresh },
            order: [fresh.id],
            activeId: fresh.id,
            drafts: {},
            // Reset content keys explicitly: zustand merges a partial, so an unnamed key (digests,
            // profiles) would survive a sign-out on a shared workstation.
            digests: [],
            // Content too, and the most personal of the three: a check-in holds the previous
            // chemist's own subject line, their reason for asking, and who they are waiting on.
            checkIns: [],
            // `checkInClaim` is kept: the claim runs once per page, so resetting it to `pending`
            // would never clear.
            sessionProfiles: {},
            jobStreamsThrottled: false,
            jobStreamsThrottledElsewhere: false,
            jobStreamsFailing: [],
            awaiting: [],
            awaitingRevision: 0,
            composerLock: false,
            banner: null,
            jobFeed: [],
            streaming: null,
          };
        });
      },

      setSessionId(conversationId, sessionId, contextLost = false) {
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...conversation,
                sessionId,
                contextLost: conversation.contextLost || contextLost,
              },
            },
          };
        });
      },

      hydrateTranscript(conversationId, messages) {
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation || messages.length === 0) return {};
          // Enforce the empty-conversation precondition inside the write: a transcript arriving
          // after a send has started must not replace the new turn.
          if (conversation.messages.length !== 0) return {};
          // Title the conversation from its first question; `GET /sessions` gives no title for
          // older sessions. Only for an empty conversation, so a typed-into conversation keeps its
          // name.
          const first = messages.find(isUser);
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...conversation,
                ...(first ? { title: titleFrom(first.text) } : {}),
                messages,
              },
            },
          };
        });
      },

      mergeRemoteTranscript(conversationId, remote) {
        let changed = false;
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation || remote.length === 0) return {};
          const merged = mergeTranscript(conversation.messages, remote);
          if (!merged) return {};
          changed = true;
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...conversation, updatedAt: Date.now(), messages: merged },
            },
          };
        });
        return changed;
      },

      startWatchedTurn(conversationId) {
        const message: AssistantMessage = { ...newAssistantMessage(), watched: true };
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...conversation,
                messages: [...conversation.messages, message],
              },
            },
          };
        });
        return message.id;
      },

      dropWatchedTurns(conversationId) {
        let dropped = false;
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          const kept = conversation.messages.filter((m) => !(m.role === 'assistant' && m.watched));
          if (kept.length === conversation.messages.length) return {};
          dropped = true;
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...conversation, messages: kept },
            },
          };
        });
        return dropped;
      },

      setMembership(conversationId, membership) {
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          // No write when nothing changed, to avoid re-rendering on every panel open and listing.
          const held = conversation.membership;
          const unchanged =
            held && membership ? held.owner === membership.owner : !held && !membership;
          if (unchanged) return {};
          const { membership: _previous, ...rest } = conversation;
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: membership ? { ...rest, membership } : rest,
            },
          };
        });
      },

      attachPlan(conversationId, todos, planHash, awaitingApproval = false, scope = null, author) {
        // Restore the session's current plan after a reload (the transcript stores messages, not
        // the plan), on the newest assistant message. Also restore the approval card when
        // `PlanStatus.approved` is false, since the transcript carries no signals.
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation || todos.length === 0) return {};
          const index = conversation.messages.findLastIndex((m) => m.role === 'assistant');
          if (index < 0) return {};
          const target = conversation.messages[index];
          if (!target || target.role !== 'assistant') return {};
          const messages = conversation.messages.slice();
          // Never a second card: rehydrate can run more than once.
          const already = target.trace.some((e) => e.kind === 'approval_request');
          const trace =
            awaitingApproval && !already
              ? [
                  ...target.trace,
                  {
                    id: `${target.id}-approval`,
                    at: Date.now(),
                    kind: 'approval_request' as const,
                    // Our own wording: this card is derived from the plan route, not from a prompt
                    // the service sent.
                    approval: {
                      prompt:
                        // "a decision", not "your": in a shared conversation the plan may be
                        // another member's.
                        'This plan is still waiting for a decision, so the agent cannot carry ' +
                        'out its state-changing steps yet.',
                    },
                  },
                ]
              : target.trace;
          messages[index] = {
            ...target,
            latestPlan: todos,
            latestPlanHash: planHash,
            // Never inherited: a scope belongs to the revision it was read for. Unknown stays
            // `null` and the card fetches it.
            latestPlanScope: scope,
            // Only when read: absent means this browser's own turn; `null` means no recorded author
            // (the owner decides).
            ...(author !== undefined ? { latestPlanAuthor: author } : {}),
            trace,
          };
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...conversation, messages },
            },
          };
        });
      },

      appendUserMessage(conversationId, text) {
        const id = uid();
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          const isFirst = conversation.messages.length === 0;
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...conversation,
                title: isFirst ? titleFrom(text) : conversation.title,
                updatedAt: Date.now(),
                messages: [
                  ...conversation.messages,
                  { id, role: 'user' as const, text, at: Date.now() },
                ],
              },
            },
          };
        });
        return id;
      },

      startAssistantMessage(conversationId) {
        const message = newAssistantMessage();
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation) return {};
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: {
                ...conversation,
                updatedAt: Date.now(),
                messages: [...conversation.messages, message],
              },
            },
          };
        });
        return message.id;
      },

      appendTokens(conversationId, messageId, text) {
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            streamedText: m.streamedText + text,
          })),
        );
      },

      applyEvent(conversationId, messageId, event) {
        // A place in the line ends the moment anything but another place arrives: that is the
        // turn having started. Cleared here, once, rather than in every branch below.
        if (event.type !== 'queued' || event.ticket === null) {
          const held = get().conversations[conversationId]?.messages.find(
            (m) => m.id === messageId,
          );
          if (held?.role === 'assistant' && held.queuePlace) {
            set((s) =>
              updateAssistant(s, conversationId, messageId, (m) => ({ ...m, queuePlace: null })),
            );
          }
        }

        if (event.type === 'token') {
          get().appendTokens(conversationId, messageId, event.text);
          return;
        }

        if (event.type === 'answer') {
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              // Replace, never append: answer.text already contains every token.
              finalText: event.text,
              confidence: event.confidence,
              unsupportedClaims: event.unsupported_claims,
              reviewRequired: event.review_required,
              verifiedBy: event.verified_by,
              // `checksRun` separates "checked and fine" from "nobody checked".
              checksRun: event.checks_run,
              challenged: event.challenged,
              reviewHoldId: event.review_hold_id,
            })),
          );
          return;
        }

        if (event.type === 'tool_queued') {
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              trace: markQueued(m.trace, event.tool, {
                state: event.state,
                waiting: event.waiting ?? null,
                jobId: event.job_id,
              }),
            })),
          );
          return;
        }

        if (event.type === 'queued') {
          // Not a trace row. A ticket is a place in a shared conversation's line; no ticket is the
          // process's admission wait (`QueuedEvent`).
          const { ticket, position } = event;
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) =>
              ticket === null
                ? { ...m, queued: true }
                : { ...m, queuePlace: { ticket, position: position ?? 0 } },
            ),
          );
          return;
        }

        if (event.type === 'capability_degraded') {
          // Not a trace row: it qualifies the whole answer, not one step of it, and it arrives
          // before the first token precisely so the reader sees it above the text.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              degradedConnectors: event.connectors,
            })),
          );
          return;
        }

        if (event.type === 'error') {
          // The only `error` codes that reach here share their turn with an answer
          // (`PARTIAL_ANSWER_CODES` in `api/streamTurn.ts`), so they mark the answer partial rather
          // than failing the message.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              partialReason: event.message,
            })),
          );
          return;
        }

        if (event.type === 'tool_result') {
          // Closes the existing `tool_call` row; the result ref rides on it so the full-result
          // affordance sits beside the preview.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              // An empty ref means "not stored", so it is omitted rather than stored empty.
              trace: closeToolCall(m.trace, event.tool, {
                result: event.preview,
                ...(event.result_ref ? { resultRef: event.result_ref } : {}),
                // The model read a cut; the ref opens what the tool actually returned.
                ...(event.result_cut ? { resultCut: true } : {}),
                // Omitted rather than stored empty, the same rule the ref takes: absent means "the
                // service did not send the result with the event", and a block then fetches it.
                ...(event.result_inline ? { resultInline: event.result_inline } : {}),
                // Named figures, kept beside `numbers`: the grounding check reads one, surfaces the
                // other.
                ...(event.values?.length ? { values: event.values } : {}),
                // Kept whole: `provenance.ts` checks the answer's figures against this list.
                numbers: event.numbers,
              }),
            })),
          );
          return;
        }

        const entry = traceEntryFor(event);
        if (!entry) return;

        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => {
            // A failure closes its call's row and adds its own row with the reason; job endings
            // likewise close the launch row.
            let base = m.trace;
            if (event.type === 'tool_failed') {
              base = closeToolCall(base, event.tool, { failed: true });
            } else if (event.type === 'job_completed' || event.type === 'job_failed') {
              base = settleJob(base, event.job_id);
            }
            // One sweep is one row: evidence sources are merged rather than appended.
            const folded = event.type === 'evidence_source' ? foldIntoSweep(base, entry) : null;
            return {
              ...m,
              trace: (folded ?? [...base, entry]).slice(-MAX_TRACE_ENTRIES),
              latestPlan: event.type === 'plan' ? event.todos : m.latestPlan,
              // The hash of the plan as rendered, so the approval binds to exactly what was shown.
              latestPlanHash: event.type === 'plan' ? event.plan_hash : m.latestPlanHash,
              // The scope travels with its hash. An older service sends none; `null` means "fetch
              // it", never "none".
              latestPlanScope:
                event.type === 'plan'
                  ? event.scope.length > 0
                    ? event.scope
                    : null
                  : m.latestPlanScope,
            };
          }),
        );
      },

      setCorrelationId(conversationId, messageId, correlationId) {
        if (!correlationId) return;
        set((s) => updateAssistant(s, conversationId, messageId, (m) => ({ ...m, correlationId })));
      },

      setTurnStalled(conversationId, messageId, stalled) {
        set((s) => updateAssistant(s, conversationId, messageId, (m) => ({ ...m, stalled })));
      },

      finishTurn(conversationId, messageId, status) {
        // `endedAt` is stamped on every ending; `stalled` and `interruptedByReload` are cleared,
        // since a settled turn is neither (a leftover flag would re-run recovery on every boot).
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status,
            endedAt: Date.now(),
            stalled: false,
            interruptedByReload: false,
          })),
        );
      },

      withdrawTurn(conversationId, messageId, reason) {
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status: 'aborted',
            endedAt: Date.now(),
            stalled: false,
            interruptedByReload: false,
            queuePlace: null,
            withdrawn: reason,
          })),
        );
      },

      failTurn(conversationId, messageId, error) {
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status: 'error',
            endedAt: Date.now(),
            stalled: false,
            // Same rule as `finishTurn`: a turn that ended is no longer interrupted.
            interruptedByReload: false,
            error,
          })),
        );
      },

      giveUpOnInterruptedTurn(conversationId, messageId, why) {
        set((s) => {
          const message = s.conversations[conversationId]?.messages.find((m) => m.id === messageId);
          if (!message || message.role !== 'assistant' || !message.interruptedByReload) return {};
          return updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            interruptedByReload: false,
            ...(why
              ? { status: 'aborted' as const, error: { kind: 'stream' as const, message: why } }
              : {}),
          }));
        });
      },

      followInterruptedTurn(conversationId, messageId, following) {
        set((s) => {
          const message = s.conversations[conversationId]?.messages.find((m) => m.id === messageId);
          if (!message || message.role !== 'assistant' || !message.interruptedByReload) return {};
          return updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status: following ? ('streaming' as const) : ('aborted' as const),
            stalled: false,
            error: following
              ? null
              : { kind: 'stream' as const, message: 'Interrupted by a page reload.' },
          }));
        });
      },

      setComposerLock(composerLock) {
        set({ composerLock });
      },
      setDraft(conversationId, text) {
        set((s) => ({ drafts: { ...s.drafts, [conversationId]: text } }));
      },
      setSessionProfile(conversationId, profile) {
        set((s) => ({ sessionProfiles: { ...s.sessionProfiles, [conversationId]: profile } }));
      },

      setBanner(banner) {
        set({ banner });
      },
      setStreaming(streaming) {
        set({ streaming });
      },
      pushJobFinished(event, sessionId) {
        set((s) => {
          const existing = s.jobFeed.find((j) => j.event.job_id === event.job_id);
          // Delivery is at-least-once: keep the original item so a reconnect does not move an old
          // card to the front.
          if (existing) return {};
          const conversation = Object.values(s.conversations).find(
            (c) => c.sessionId === sessionId,
          );
          const item: JobFeedItem = {
            event,
            sessionId,
            conversationId: conversation?.id ?? null,
            receivedAt: Date.now(),
            seen: false,
            dismissed: false,
          };
          return { jobFeed: [item, ...s.jobFeed].slice(0, MAX_JOB_FEED) };
        });
      },

      noteAwaiting(event) {
        set((s) => {
          if (event.state !== 'waiting') {
            const rest = s.awaiting.filter((id) => id !== event.request_id);
            // Same identity when nothing was removed, to avoid re-renders and inbox re-reads.
            return rest.length === s.awaiting.length
              ? {}
              : { awaiting: rest, awaitingRevision: s.awaitingRevision + 1 };
          }
          if (s.awaiting.includes(event.request_id)) return {};
          return {
            awaitingRevision: s.awaitingRevision + 1,
            awaiting: [...s.awaiting, event.request_id],
          };
        });
      },

      syncAwaiting(requestIds) {
        set((s) => {
          // Compare before writing: this runs on every inbox read and usually changes nothing.
          const same =
            requestIds.length === s.awaiting.length &&
            requestIds.every((id, i) => id === s.awaiting[i]);
          return same ? {} : { awaiting: requestIds };
        });
      },

      restoreJobItem(jobId) {
        set((s) => ({
          jobFeed: s.jobFeed.map((j) =>
            j.event.job_id === jobId
              ? { ...j, dismissed: false, dismissedChangedAt: Date.now() }
              : j,
          ),
        }));
      },

      markJobsSeen() {
        set((s) => {
          if (s.jobFeed.every((j) => j.seen)) return {};
          return { jobFeed: s.jobFeed.map((j) => (j.seen ? j : { ...j, seen: true })) };
        });
      },

      setJobStreamsThrottled(throttled) {
        if (get().jobStreamsThrottled === throttled) return;
        set({ jobStreamsThrottled: throttled });
      },

      setJobStreamsThrottledElsewhere(throttled) {
        if (get().jobStreamsThrottledElsewhere === throttled) return;
        set({ jobStreamsThrottledElsewhere: throttled });
      },

      setJobStreamFailing(sessionId, failing) {
        const current = get().jobStreamsFailing;
        const known = current.includes(sessionId);
        if (failing === known) return;
        set({
          jobStreamsFailing: failing
            ? [...current, sessionId]
            : current.filter((id) => id !== sessionId),
        });
      },

      setNotifyOnJobComplete(enabled) {
        set({ notifyOnJobComplete: enabled });
      },

      setSessionIdIfAbsent(conversationId, sessionId) {
        // Compare-and-set, returning the winner, so two racing warms cannot leave the store on a
        // session the turn is not using.
        const existing = get().conversations[conversationId]?.sessionId;
        if (existing) return existing;
        get().setSessionId(conversationId, sessionId);
        return get().conversations[conversationId]?.sessionId ?? sessionId;
      },

      adoptFork(parentId, sessionId) {
        const parent = get().conversations[parentId];
        if (!parent) return null;
        const branch: Conversation = {
          ...newConversation(),
          sessionId,
          title: `${parent.title} (branch)`,
          // Without in-flight messages: a fork is taken from a settled thread.
          messages: parent.messages.filter(
            (m) => !(m.role === 'assistant' && m.status === 'streaming'),
          ),
          // The service holds the authoritative copy, so the transcript rehydrate is what
          // reconciles the two if they differ.
          sessionOrigin: 'server',
        };
        set((s) => ({
          conversations: { ...s.conversations, [branch.id]: branch },
          order: [branch.id, ...s.order],
          activeId: branch.id,
        }));
        return branch.id;
      },

      addDigests(claimed) {
        if (claimed.length === 0) return;
        set((s) => {
          const key = (query: string, ids: string[]): string => `${query}\u0000${ids.join(',')}`;
          const known = new Set(s.digests.map((d) => key(d.query, d.noteIds)));
          const additions = claimed
            .filter((d) => !known.has(key(d.query, d.note_ids)))
            .map((d) => ({
              query: d.query,
              noteIds: d.note_ids,
              disputed: d.disputed,
              headlines: d.headlines,
              receivedAt: Date.now(),
              dismissed: false,
            }));
          return additions.length > 0
            ? { digests: [...additions, ...s.digests].slice(0, MAX_DIGESTS) }
            : {};
        });
      },

      dismissDigest(index) {
        // A flag, not a delete: the service's copy was consumed, so this card is the only one.
        set((s) => ({
          digests: s.digests.map((d, i) => (i === index ? { ...d, dismissed: true } : d)),
        }));
      },

      addCheckIns(claimed) {
        set((s) => {
          const known = new Map(s.checkIns.map((c) => [checkInKey(c), c]));
          const fresh: string[] = [];
          const now = Date.now();
          for (const row of claimed) {
            const card = {
              requestId: row.request_id,
              subject: row.subject,
              rationale: row.rationale,
            };
            const key = checkInKey(card);
            const held = known.get(key);
            known.set(key, {
              ...card,
              kind: row.kind,
              askedOf: row.asked_of,
              openDays: row.open_days,
              daysLeft: row.days_left,
              sessionId: row.session_id,
              // Taken from the newest row: it is the one true about now.
              truncated: row.truncated,
              // A refresh keeps the original position and arrival time.
              receivedAt: held?.receivedAt ?? now,
              // Re-stamped every time: decides which copy carries the newer countdown in
              // `mergeWithStored`.
              refreshedAt: now,
              dismissed: held?.dismissed ?? false,
            });
            // Written before re-reading, so a request appearing twice in one claim folds into one
            // card.
            if (!held) fresh.push(key);
          }
          const card = (id: string): CheckInCard => known.get(id) as CheckInCard;
          return {
            checkIns: [...fresh.map(card), ...s.checkIns.map((c) => card(checkInKey(c)))].slice(
              0,
              MAX_CHECK_INS,
            ),
            checkInClaim: 'ready' as const,
          };
        });
      },

      failCheckInClaim() {
        // Deliberately does not touch `checkIns`: cards claimed by an earlier page are still the
        // only copy of what they say, and a failed claim is no evidence about them.
        set({ checkInClaim: 'failed' });
      },

      markCheckInsAbsent() {
        set({ checkInClaim: 'absent' as const });
      },

      dismissCheckIn(key) {
        // A flag, not a delete (see `dismissDigest`), and by `checkInKey`, since id-less rows share
        // an empty id.
        set((s) => ({
          checkIns: s.checkIns.map((c) => (checkInKey(c) === key ? { ...c, dismissed: true } : c)),
        }));
      },

      dismissJobItem(jobId) {
        // A flag, not a delete. The feed is durable now, so an unguarded click on a 24px control
        // would otherwise be a permanent deletion of the only copy — the backend's is consumed.
        set((s) => ({
          jobFeed: s.jobFeed.map((j) =>
            j.event.job_id === jobId
              ? { ...j, dismissed: true, seen: true, dismissedChangedAt: Date.now() }
              : j,
          ),
        }));
      },
    }),
    {
      // The base key (`chemclaw3.chat.v2`) is frozen: bumping it wipes everyone's history. Schema
      // changes go through `version` + `migrate`. The full key is per account (`chatStorageKey`),
      // starting on `'anon'` and re-pointed by `hydrateChatForAccount`.
      name: chatStorageKey(null),
      version: CHAT_PERSIST_VERSION,
      storage: chatStorage,

      // No auto-load: the account's slot is unknown until auth resolves. Tests can call
      // `useChatStore.persist.rehydrate()`.
      skipHydration: true,

      migrate: migratePersisted,

      partialize: (state) => {
        // Keep only the newest conversations, and never persist a message still marked
        // 'streaming' — there is no resume endpoint, so on reload it would hang forever.
        const order = state.order.slice(0, MAX_CONVERSATIONS);
        const conversations: Record<string, Conversation> = {};
        for (const id of order) {
          const conversation = state.conversations[id];
          if (!conversation) continue;
          conversations[id] = {
            ...conversation,
            messages: conversation.messages
              // Never persist a watched turn: it would come back as an interrupted turn of this
              // browser's own.
              .filter((m) => !(m.role === 'assistant' && m.watched))
              .slice(-MAX_PERSISTED_MESSAGES)
              .map((m) =>
                m.role === 'assistant' && m.status === 'streaming'
                  ? {
                      ...m,
                      status: 'aborted' as const,
                      // Tells the next boot to look for this turn's answer on the server. See
                      // `AssistantMessage.interruptedByReload`.
                      interruptedByReload: true,
                      error: {
                        kind: 'stream' as ApiErrorKind,
                        message: 'Interrupted by a page reload.',
                      },
                    }
                  : m,
              )
              .map(withoutDuplicateAnswer),
          };
        }

        // The job feed is dropped with its conversation and aged out.
        const cutoff = Date.now() - JOB_FEED_MAX_AGE_MS;
        const jobFeed = state.jobFeed.filter(
          (j) =>
            j.receivedAt > cutoff && (j.conversationId === null || conversations[j.conversationId]),
        );

        // `sessionId` is persisted; a dead one is recreated on 404. Drafts are kept only for
        // conversations that survived the trim.
        const drafts: Record<string, string> = {};
        for (const [id, text] of Object.entries(state.drafts)) {
          if (text && conversations[id]) drafts[id] = text;
        }

        return {
          conversations,
          order,
          activeId: state.activeId,
          drafts,
          jobFeed,
          // Aged out like the job feed; never dropped for being unread (the claim cannot be
          // repeated).
          digests: state.digests.filter((d) => d.receivedAt > cutoff),
          // Aged on the countdown's freshness (`checkInFreshAt`): a week-old countdown is wrong,
          // not just old.
          checkIns: state.checkIns.filter((c) => checkInFreshAt(c) > cutoff),
          notifyOnJobComplete: state.notifyOnJobComplete,
        };
      },
    },
  ),
);
