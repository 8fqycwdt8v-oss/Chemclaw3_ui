/**
 * The conversation store.
 *
 * Zustand rather than `useReducer` + Context because the streaming loop lives outside React and
 * fires an event per token. With a reducer we would have to thread `dispatch` through the turn
 * orchestrator via a ref and then memoise the entire component tree to stop it re-rendering on
 * every token. `getState()`/`setState()` from plain TypeScript is exactly what this needs, and
 * selector-scoped subscriptions keep the composer and sidebar out of the per-token render path.
 */

import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { ChemclawEvent, JobTerminalEvent } from '../../shared/events.ts';
import { useEntityStore } from '../chem/entities.ts';
import type { ApiErrorKind } from '../api/errors.ts';
import type {
  AssistantMessage,
  Banner,
  ChatMessage,
  ComposerLock,
  Conversation,
  TraceEntry,
  UserMessage,
} from './types.ts';

/**
 * One finished job, plus what the wire event does not carry.
 *
 * The event has a job id and an outcome and nothing else — no session, no timestamp. The consumer
 * knows which stream it opened, so the association is attached at that boundary rather than by
 * inventing fields on the shared contract.
 *
 * `event` is the terminal union, not just the completion: a job that fails after the turn ends is
 * exactly as much news as one that succeeds, and it arrives on the same stream. Widening this
 * needed no persist migration — every item already on disk is a `job_completed`, which is still a
 * member of the union — but anything reading it must now branch on `event.type` rather than
 * assuming a `summary`.
 */
export interface JobFeedItem {
  event: JobTerminalEvent;
  sessionId: string;
  conversationId: string | null;
  /** When WE saw it. The backend sends no completion time, so the UI must not imply one. */
  receivedAt: number;
  seen: boolean;
  dismissed: boolean;
}

/** Exactly the slice `partialize` writes to localStorage, and what `migrate` must return. */
interface PersistedState {
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
  jobFeed: JobFeedItem[];
  notifyOnJobComplete: boolean;
}

/**
 * One migration step. Each takes the shape the previous version wrote and returns the next, so
 * `migrate` can compose however many the reader has skipped. See the note on `migrate` below.
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
 * Bring whatever is on disk up to the current shape.
 *
 * A chain of steps rather than one function with an early return, so each bump only has to
 * describe its own delta and the next one composes on top. The shape this replaced —
 * `if (version >= 2) return persisted` — quietly stopped applying to anything once v2 was the
 * floor, which is exactly the bug you get the first time you add a field afterwards.
 *
 * Unknown or older-than-v1 state falls back to a clean slate rather than guessing.
 *
 *  v1 -> v2  no new fields. Repairs state the old code could persist but the new code assumes
 *            away: a message left mid-stream would rehydrate as 'streaming' and spin forever,
 *            because there is no resume endpoint.
 *  v2 -> v3  adds the durable job feed and the notification preference, and makes
 *            `sessionOrigin` explicit. Everything already on disk was created locally, so 'local'
 *            is the honest default — 'server' would send the transcript rehydrate off to
 *            GET /messages for conversations that never had a remote copy.
 *
 * Exported because it is the only part of the persist config that can be wrong in a way nobody
 * notices until an upgrade lands on a real machine.
 */
export function migratePersisted(persisted: unknown, version: number): PersistedState {
  const steps: ((s: Partial<PersistedState>) => Partial<PersistedState>)[] = [];
  if (version < 2) steps.push(migrateV1toV2);
  if (version < 3) steps.push(migrateV2toV3);

  const state = persisted as Partial<PersistedState> | undefined;
  if (!state?.conversations || !state.order)
    return {
      conversations: {},
      order: [],
      activeId: null,
      jobFeed: [],
      notifyOnJobComplete: false,
    };

  return steps.reduce<Partial<PersistedState>>((acc, step) => step(acc), state) as PersistedState;
}

/** Keep persisted state bounded — see `partialize` below. */
const MAX_CONVERSATIONS = 30;
/**
 * The most recent messages of any one conversation that are written to disk.
 *
 * `messages` was the one collection here with no bound at all, while `order`, `trace` and
 * `jobFeed` all had one — so a single long-lived conversation could carry the whole persisted
 * payload past the browser's quota on its own. Generous rather than tight: the in-memory
 * conversation keeps everything for the session, and this only decides what survives a reload.
 */
const MAX_PERSISTED_MESSAGES = 200;
const MAX_JOB_FEED = 50;
/** A completion older than this is history, not news. Bounds the persisted feed's size too. */
const JOB_FEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
    endedAt: null,
    correlationId: '',
    stalled: false,
    error: null,
  };
}

/**
 * Close the open `tool_call` row for `tool` with how it ended, returning the updated trace.
 *
 * Both endings come through here, because a call is announced at issue now (backend D-159) and an
 * open row means "still running" — so a `tool_failed` that left its row open would read as running
 * forever. `tool_failed` still appends its own row afterwards; this only stops the claim.
 *
 * Neither event carries a call id, so the match is "the oldest still-open row for this tool" —
 * first issued, first answered. Two concurrent calls to the *same* tool returning out of order
 * would pair the previews the wrong way round; nothing on the wire can say otherwise, and the
 * alternative (a row per result) makes every reader do the same pairing by eye. An ending whose
 * call has already been dropped by `MAX_TRACE_ENTRIES` is discarded with it.
 */
function closeToolCall(
  trace: TraceEntry[],
  tool: string,
  ending:
    | {
        result: string;
        resultRef?: string;
        resultInline?: string;
        numbers?: number[];
        values?: { label: string; value: number; unit: string }[];
      }
    | { failed: true },
): TraceEntry[] {
  // Our clock, at the moment the ending reached this process. Nothing on the wire carries a tool
  // duration, so this is the only honest one available — and it is the wait the reader had.
  const endedAt = Date.now();
  const index = trace.findIndex(
    (entry) =>
      entry.kind === 'tool_call' &&
      entry.toolCall?.tool === tool &&
      entry.toolCall.result === undefined &&
      !entry.toolCall.failed,
  );
  const target = trace[index];
  if (index === -1 || !target?.toolCall) return trace;
  const updated: TraceEntry = { ...target, toolCall: { ...target.toolCall, ...ending, endedAt } };
  return [...trace.slice(0, index), updated, ...trace.slice(index + 1)];
}

/**
 * Mark a `job_started` row as ended, whichever way it ended.
 *
 * The job-shaped sibling of `closeToolCall`, and it exists for the sharper version of the same
 * problem. A launch row carries the badge "runs asynchronously"; before this, nothing ever took
 * that badge off, so a job that failed an hour ago still read as in flight. Matched on the job id
 * rather than on issue order — unlike a tool call, a job has an id on the wire, so there is no
 * pairing to guess at.
 *
 * A launch row already dropped by `MAX_TRACE_ENTRIES`, or a completion for a job launched in a
 * different turn, simply finds nothing and leaves the trace alone.
 */
/**
 * Fold one source's report into the sweep already standing, when there is one.
 *
 * A sweep arrives as one event per source, and both the reading and the cost say it is one step:
 * the rail draws "graph 6 · lexical failed" as one line, and a row per source spends the trace's
 * bounded `MAX_TRACE_ENTRIES` budget on retrieval — a retrieval-heavy turn evicting its own early
 * tool calls, and the result blocks that hang off them.
 *
 * Consecutive is the whole test, and it is the right one: the events of one `gather_evidence` call
 * arrive together, and anything between them ends the sweep. Returns `null` when this event starts
 * a new one, which is the caller's cue to append rather than merge.
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
        toolFailure: { tool: event.tool, message: event.message, reason: event.reason ?? null },
      };
    // Every source, not only the failures. This used to keep the raised ones and drop the rest,
    // on the argument that a source asked and silent "belongs in an evidence summary, not in a
    // trace of what went wrong" — which was right about the trace it was written against, and is
    // what the rail now IS: one row per sweep reading `lexical failed · graph 6 · eln 0`, where a
    // dark source and a broken one sit side by side and are told apart by name. Dropping the
    // successes here made that row unbuildable, and left "which sources were even asked?"
    // answerable only by reading the service's logs.
    case 'evidence_source': {
      const reported = {
        source: event.source,
        chunks: event.chunks,
        failed: event.failed === true,
      };
      return {
        ...base,
        kind: 'evidence_source',
        // A sweep of one. Every entry is born a sweep so that `foldIntoSweep` has something to
        // merge INTO and something to merge FROM without a second shape: the first source of a
        // run stands as a one-source sweep, and each one after it is folded in.
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
    case 'note_proposed':
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
      return { ...base, kind: 'handoff', handoff: { to: event.to, reason: event.reason } };
    default:
      return null;
  }
}

export interface ChatState {
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
  composerLock: ComposerLock;
  banner: Banner | null;
  /** Unsent text, keyed by conversation. Component state leaked across conversation switches:
   *  the composer does not unmount when `conversationId` changes, so a draft typed in one could
   *  be sent into another. */
  drafts: Record<string, string>;
  /**
   * The agent profile a not-yet-created session should be minted on, keyed by conversation.
   *
   * Not persisted, and it does not need to be: it only has an effect until the session exists,
   * and once it does the choice is fixed on the service side and the picker is gone. Keyed by
   * conversation for the same reason `drafts` is — the composer does not unmount when the active
   * conversation changes, so component state would leak the choice across a switch.
   */
  sessionProfiles: Record<string, string>;
  /** Cross-turn job endings — successes and failures — from `GET /sessions/{id}/events`.
   *  Persisted since v3. */
  jobFeed: JobFeedItem[];
  /** True once the backend has told us twice that we are over its stream cap. */
  jobStreamsThrottled: boolean;
  /**
   * Sessions whose job push-back stream has failed to connect repeatedly.
   *
   * A list rather than a flag, because the streams are per session and a single boolean would
   * flap: one dead session would clear the moment another delivered a frame, which is how the
   * indicator would end up describing neither. Not persisted — it is a statement about the network
   * right now, and a reload re-establishes every stream anyway.
   */
  jobStreamsFailing: string[];
  /** Opt-in, and deliberately separate from `Notification.permission` — a browser-level
   *  revocation must read as "blocked", not as "off". */
  notifyOnJobComplete: boolean;
  streaming: {
    conversationId: string;
    messageId: string;
    abort: AbortController;
    /**
     * Stop the turn on the server, then abort the local stream. Built by the send path, which
     * is the one place that holds the auth provider — the backend detaches on disconnect now,
     * so aborting the fetch alone would leave the turn running (and the session 409-busy) for
     * its whole remaining duration.
     */
    stop: () => void;
    /**
     * The same cancellation, sent while this document is being discarded.
     *
     * Separate from `stop` because the unload path can do exactly one thing — get a `keepalive`
     * request onto the wire with a token it already has — and none of the things `stop` does
     * after that (abort the stream, await the outcome, tell the reader) survive the navigation
     * anyway. See its docstring in `src/state/sendMessage.ts`.
     */
    abandon: () => void;
  } | null;

  createConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
  setSessionId: (conversationId: string, sessionId: string, contextLost?: boolean) => void;
  hydrateTranscript: (conversationId: string, messages: ChatMessage[]) => void;
  attachPlan: (
    conversationId: string,
    todos: string[],
    planHash: string,
    awaitingApproval?: boolean,
  ) => void;

  appendUserMessage: (conversationId: string, text: string) => string;
  startAssistantMessage: (conversationId: string) => string;
  appendTokens: (conversationId: string, messageId: string, text: string) => void;
  applyEvent: (conversationId: string, messageId: string, event: ChemclawEvent) => void;
  /** Record the service's id for this turn, so a successful answer is findable in its logs too. */
  setCorrelationId: (conversationId: string, messageId: string, correlationId: string) => void;
  /** The stream has gone quiet, or come back. Never ends the turn — see `AssistantMessage.stalled`. */
  setTurnStalled: (conversationId: string, messageId: string, stalled: boolean) => void;
  finishTurn: (conversationId: string, messageId: string, status: 'done' | 'aborted') => void;
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
  dismissJobItem: (jobId: string) => void;
  restoreJobItem: (jobId: string) => void;
  markJobsSeen: () => void;
  setJobStreamsThrottled: (throttled: boolean) => void;
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
 * Drop the oldest half of the persisted conversations, so a payload that was refused can be
 * retried as a smaller one. Returns `null` when there is nothing left to drop.
 */
function shedOldest(state: PersistedState): PersistedState | null {
  if (state.order.length === 0) return null;
  const order = state.order.slice(0, Math.floor(state.order.length / 2));
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
 * `localStorage`, with the three things `createJSONStorage(() => localStorage)` does not do.
 *
 * `persist` re-serialises the whole slice on EVERY store write — one per animation-frame token
 * flush, for as long as an answer is streaming — and hands the failure straight back to the
 * action that caused it. `appendUserMessage` runs before `sendMessage`'s try/catch, so a
 * `QuotaExceededError` there left the turn as an unhandled rejection: no bubble, no answer, no
 * banner, no lock. Send did nothing, for ever, because a reload does not empty the store that is
 * full.
 *
 * So: a refused write sheds the oldest conversations and tries again, a write that cannot succeed
 * at all is swallowed the way `prefsStore` already swallows its own, and the actual
 * `JSON.stringify` + `localStorage.setItem` is throttled to once every `PERSIST_THROTTLE_MS`
 * rather than once per frame — a full slice of history is up to a few hundred KB, and stringifying
 * it 60 times a second is main-thread work competing with the token render it is trying not to
 * jank. The in-memory store itself is never throttled, only the disk write; `flushChatPersistence`
 * forces the latest value out immediately, called on `pagehide`/`beforeunload` so a closed tab
 * never loses more than one throttle window's worth of history.
 */
let storageWritable = true;

const PERSIST_THROTTLE_MS = 750;
let scheduledName: string | null = null;
let scheduledValue: StorageValue<PersistedState> | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;

function writeChatStorageNow(name: string, value: StorageValue<PersistedState>): void {
  if (!storageWritable) return;
  let state: PersistedState | null = value.state;
  while (state) {
    try {
      localStorage.setItem(name, JSON.stringify({ ...value, state }));
      return;
    } catch {
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
 * Cancel a turn the reader is walking away from.
 *
 * The two handlers above save local state and neither cancels anything, so closing the tab,
 * reloading, or navigating away left the turn running on the service — a disconnect only
 * *detaches* (`D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`), so it ran to completion holding
 * one of eight admission permits for up to 600 s, for an answer nobody was going to read.
 *
 * **`event.persisted` is the whole decision, and it is the honest version of "gone for good".**
 * A `pagehide` with `persisted: true` is the page going into the back/forward cache: the document,
 * this store and the in-flight `fetch` are all frozen and may be resumed intact, so cancelling
 * there would destroy a turn the reader is about to come back to. With `persisted: false` the
 * document is being discarded, and nothing in this app resumes a turn across that — a reloaded tab
 * rehydrates a `streaming` message as failed (there is no resume endpoint) and picks the answer up
 * only from a later transcript read. The browser cannot tell a reload from a close at unload time,
 * and `PerformanceNavigationTiming` only says so on the *next* load, so a reload is cancelled too.
 * That is the deliberate half of the trade: the answer would still have landed in the transcript,
 * against which a chemist who reloads because the turn felt stuck is exactly the case that
 * otherwise comes back to a 409 from the turn they were trying to escape.
 *
 * An in-app route change is not a `pagehide` at all, so navigating to `/jobs` mid-turn is
 * untouched.
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
 * Forget every conversation, in memory and on disk.
 *
 * Sign-out's other half. MSAL caches the *credential* in `sessionStorage`, which dies with the
 * tab; the transcripts live here, in `localStorage`, under one key that is not partitioned by
 * account — so signing out removed the credential and left the data it was protecting for the
 * next person to use the browser profile.
 *
 * It lives beside the store rather than in the auth provider because both halves are the store's
 * own: `clearAll` is what stops the previous account's conversations being on screen if the
 * sign-out redirect is slow or blocked, and `persist.clearStorage` is what stops them coming back
 * on the next load. Ordered, too: `clearAll` writes a fresh state through the persist middleware,
 * so removing the key has to come second.
 */
export function forgetLocalHistory(): void {
  useChatStore.getState().clearAll();
  useChatStore.persist.clearStorage();
}

/**
 * The persisted-history key, partitioned by account.
 *
 * `chemclaw3.chat.v2` is frozen as the *base* — see the persist config below for why bumping it is
 * a wipe — but the transcripts under it belong to whoever was signed in when they were written, and
 * that identity was never in the key. On a shared analytical-development workstation the store
 * rehydrated the previous chemist's conversations before the next one's identity was known, because
 * one global key served everybody and it was cleared only on an explicit sign-out. Scoping the key
 * by the Entra object id (`oid`) makes each account's history its own storage slot; `'anon'` is the
 * pre-sign-in slot, and dev's shared `dev-user` principal gets its own by the same rule.
 */
export const CHAT_STORAGE_BASE = 'chemclaw3.chat.v2';

/** The persisted-history key for a given account `oid` (`'anon'` before one is known). */
export function chatStorageKey(oid: string | null | undefined): string {
  return `${CHAT_STORAGE_BASE}.${oid ?? 'anon'}`;
}

/**
 * Point the persisted store at an account's own slot and load it — the account-aware other half of
 * `skipHydration: true`.
 *
 * Rehydration is deferred (`skipHydration`) precisely so it cannot happen before identity is known;
 * the auth bootstrap calls this once the provider — and therefore the `oid` — has resolved. Re-keying
 * before the read is what stops one account's transcript being served to the next, and it is a no-op
 * when the slot is already correct so a re-render cannot re-read history needlessly.
 */
let hydratedName: string | null = null;

export function hydrateChatForAccount(oid: string | null | undefined): void {
  const name = chatStorageKey(oid);
  // Once per account, not once per caller. The auth bootstrap can run this on every mount (a test
  // remounting `AuthGate`, StrictMode's double-invoke), and a second `rehydrate()` is not
  // harmless: `rehydrate` reads the *throttled* on-disk value and `set(..., replace)`s it over
  // memory, so a re-read after the store has moved on (a freshly created conversation not yet
  // flushed) would clobber live state with a stale snapshot. Reading the slot once, when the
  // account first becomes known, is both sufficient and what the app actually wants.
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
      conversations: {},
      order: [],
      activeId: null,
      composerLock: false,
      banner: null,
      drafts: {},
      sessionProfiles: {},
      jobFeed: [],
      jobStreamsThrottled: false,
      jobStreamsFailing: [],
      notifyOnJobComplete: false,
      streaming: null,

      // Neither of these clears `composerLock`, and that is the fix rather than an omission.
      // The lock and the `streaming` slot are single, global, app-wide things — one turn at a
      // time — while `Composer` derives its own blocking per conversation. Clearing the lock on
      // a conversation change therefore unblocked a composer whose turn was still running: a
      // second turn started, overwrote the one `streaming` slot, and left the first turn's
      // `AbortController` unreachable, so Stop could no longer release the backend's turn lease
      // or its admission permit. The banner still clears, because it belongs to the view.
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
        // A turn belonging to the conversation being deleted has to be stopped here, not left to
        // finish into a conversation that no longer exists. Aborting also releases the backend's
        // per-session turn lock, which is the whole reason Stop propagates a disconnect.
        const streaming = get().streaming;
        const wasStreamingThis = streaming?.conversationId === id;
        if (wasStreamingThis) streaming?.abort.abort();

        // The subject index goes with the conversation. It is keyed by conversation id and read
        // by nobody else, so leaving it behind would be a rail for a transcript that no longer
        // exists.
        useEntityStore.getState().forget(id);

        set((s) => {
          const { [id]: _removed, ...rest } = s.conversations;
          const { [id]: _draft, ...drafts } = s.drafts;
          const order = s.order.filter((x) => x !== id);
          return {
            conversations: rest,
            drafts,
            order,
            activeId: s.activeId === id ? (order[0] ?? null) : s.activeId,
            // Without this, deleting mid-turn leaves the composer locked with nothing to unlock
            // it: the turn it was waiting on can no longer report back.
            ...(wasStreamingThis
              ? { streaming: null, composerLock: false as const, banner: null }
              : {}),
          };
        });
      },

      clearAll() {
        // "Reset app" is the escape hatch from a poisoned state, so it has to leave nothing
        // behind — including an in-flight turn that would otherwise write into a conversation
        // this just deleted.
        get().streaming?.abort.abort();
        // Same reason as `deleteConversation`: every conversation these indexes describe is about
        // to stop existing.
        useEntityStore.getState().clear();
        set(() => {
          const fresh = newConversation();
          return {
            conversations: { [fresh.id]: fresh },
            order: [fresh.id],
            activeId: fresh.id,
            drafts: {},
            jobStreamsThrottled: false,
            jobStreamsFailing: [],
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
          // The precondition the caller believes it is enforcing, enforced where it cannot race.
          // The rehydrate effect starts only for an empty conversation and cancels itself when
          // the message count changes — but that cancellation is an effect cleanup, so it runs on
          // React's next render, while `sendMessage` appends synchronously. A transcript that
          // resolved inside that window replaced the turn that had just started, and every later
          // token was dropped in silence because `updateAssistant` matches on an id that is no
          // longer in the array.
          if (conversation.messages.length !== 0) return {};
          // Name it from what was actually asked in it.
          //
          // `GET /sessions` returns `{session_id, created_at}` and no title — the server mints a
          // session before anyone has spoken and never revisits the row — so every conversation
          // restored from another device landed in the sidebar as "Earlier conversation". A week
          // of history was a column of identical rows distinguished only by a date.
          //
          // Only when this conversation is empty, which is not a formality: it is the same
          // precondition the rehydrate effect runs under (`messageCount === 0`), so a title
          // replaced here can only ever be the placeholder from `newConversation()` or the
          // sidebar's stub. A conversation someone has typed into keeps the name it earned.
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

      attachPlan(conversationId, todos, planHash, awaitingApproval = false) {
        // The session's current plan, read back after a reload. `latestPlan` is stream-only state
        // — the transcript stores the messages, not the plan — so a rehydrated conversation lost
        // its checklist while the session, per `GET /sessions/{id}/plan`, was still proposing one.
        // Attached to the newest assistant message because that is where the live stream would
        // have left it: the latest plan belongs to the latest turn.
        //
        // **`awaitingApproval` restores the decision, not just the checklist.** The card is built
        // from an `approval_request` trace entry, and a reload rebuilds a conversation from the
        // stored transcript — which carries messages and tool calls and no signals at all. So the
        // plan came back and the Approve button did not, while the gate went on refusing every
        // state-changing call: the only way out was to send another message purely to make the
        // service re-emit the event. The same read that restores the checklist already answers
        // this (`PlanStatus.approved`); it was being fetched and thrown away.
        set((s) => {
          const conversation = s.conversations[conversationId];
          if (!conversation || todos.length === 0) return {};
          const index = conversation.messages.findLastIndex((m) => m.role === 'assistant');
          if (index < 0) return {};
          const target = conversation.messages[index];
          if (!target || target.role !== 'assistant') return {};
          const messages = conversation.messages.slice();
          // Never a second card: a rehydrate can run more than once for one conversation (the
          // effect re-fires on `messageCount`), and appending each time would stack Approve
          // buttons on one message.
          const already = target.trace.some((e) => e.kind === 'approval_request');
          const trace =
            awaitingApproval && !already
              ? [
                  ...target.trace,
                  {
                    id: `${target.id}-approval`,
                    at: Date.now(),
                    kind: 'approval_request' as const,
                    // The surface's own wording, and deliberately so: this card is derived from
                    // the plan route's `approved: false`, not from a prompt the service sent, and
                    // quoting the service's sentence would claim an event that never arrived.
                    approval: {
                      prompt:
                        'This plan is still waiting for your decision, so the agent cannot carry ' +
                        'out its state-changing steps yet.',
                    },
                  },
                ]
              : target.trace;
          messages[index] = { ...target, latestPlan: todos, latestPlanHash: planHash, trace };
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
            })),
          );
          return;
        }

        if (event.type === 'queued') {
          // Not a trace row: the turn has not done anything yet — that is the whole message.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({ ...m, queued: true })),
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
          // The only `error`s that reach here: `streamTurn` throws on every other code, and these
          // arrive BEFORE the answer they qualify (the backend names `loop_cap_reached` and
          // `spend_cap_reached` as the codes that share their turn with an answer — a runaway
          // guard of iterations or of spend). So this marks the answer partial rather than failing
          // the message — `failTurn` is still what a real failure calls. The membership itself is
          // `PARTIAL_ANSWER_CODES` in `api/streamTurn.ts`, which is the one place it stays true.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              partialReason: event.message,
            })),
          );
          return;
        }

        if (event.type === 'tool_result') {
          // Not its own row: it closes the `tool_call` row already in the trace. The result ref
          // rides along on that row so the "see the full result" affordance sits next to the
          // preview it completes, rather than in a second row saying the same thing.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              // The ref is omitted rather than stored empty. The backend guarantees "" means
              // "not stored" and nothing else, so collapsing it to absent leaves exactly one
              // thing for a reader to check before offering to fetch it.
              trace: closeToolCall(m.trace, event.tool, {
                result: event.preview,
                ...(event.result_ref ? { resultRef: event.result_ref } : {}),
                // Omitted rather than stored empty, the same rule the ref takes: absent means "the
                // service did not send the result with the event", and a block then fetches it.
                ...(event.result_inline ? { resultInline: event.result_inline } : {}),
                // The named figures, when the result was structured enough to have names. Kept
                // beside `numbers` rather than instead of it — the grounding check reads one and
                // the surfaces read the other.
                ...(event.values?.length ? { values: event.values } : {}),
                // Kept whole. This is the untruncated list beside a truncated preview, and it is
                // the only structured chemistry the stream carries — `provenance.ts` checks the
                // answer's figures against it, so dropping it here is what made every figure in
                // an answer uncheckable.
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
            // A failure closes its call's row *and* adds its own: the row stops claiming the
            // call is running, the new row carries the reason. Both job endings do the same to
            // the launch row, which otherwise keeps its "runs asynchronously" badge forever.
            let base = m.trace;
            if (event.type === 'tool_failed') {
              base = closeToolCall(base, event.tool, { failed: true });
            } else if (event.type === 'job_completed' || event.type === 'job_failed') {
              base = settleJob(base, event.job_id);
            }
            // One sweep is one row. `gather_evidence` asks every source at once and the service
            // reports each separately, so this is a *merge* rather than an append — both because
            // that is how a reader reads them and because a row per source spends the bounded
            // trace on retrieval, evicting the early tool calls of a retrieval-heavy turn.
            const folded = event.type === 'evidence_source' ? foldIntoSweep(base, entry) : null;
            return {
              ...m,
              trace: (folded ?? [...base, entry]).slice(-MAX_TRACE_ENTRIES),
              latestPlan: event.type === 'plan' ? event.todos : m.latestPlan,
              // The hash of the plan as rendered, so the approval card can bind a decision to
              // exactly what was shown without a second round trip that races the next revision.
              latestPlanHash: event.type === 'plan' ? event.plan_hash : m.latestPlanHash,
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
        // `endedAt` is stamped on every ending, not just the successful one: an aborted turn took
        // as long as it took, and the summary line has no other way to say so. `stalled` is
        // cleared because the flag describes a stream that is still open and silent, and leaving
        // it set would put "no activity" beside a finished answer for ever.
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status,
            endedAt: Date.now(),
            stalled: false,
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
            error,
          })),
        );
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
          // Re-delivery is expected: the stream reconnects with backoff and delivery is
          // at-least-once. Keep the ORIGINAL item — replacing it would move a three-day-old card
          // to the front of a persisted feed on every reconnect.
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

      restoreJobItem(jobId) {
        set((s) => ({
          jobFeed: s.jobFeed.map((j) =>
            j.event.job_id === jobId ? { ...j, dismissed: false } : j,
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
        // Compare-and-set, returning the winner. Two warms racing would otherwise mint two backend
        // sessions and leave the store pointing at the one the in-flight turn is NOT using —
        // silent context loss with nothing to flag it. The loser is an orphan that ages out of the
        // backend's LRU.
        const existing = get().conversations[conversationId]?.sessionId;
        if (existing) return existing;
        get().setSessionId(conversationId, sessionId);
        return get().conversations[conversationId]?.sessionId ?? sessionId;
      },

      dismissJobItem(jobId) {
        // A flag, not a delete. The feed is durable now, so an unguarded click on a 24px control
        // would otherwise be a permanent deletion of the only copy — the backend's is consumed.
        set((s) => ({
          jobFeed: s.jobFeed.map((j) =>
            j.event.job_id === jobId ? { ...j, dismissed: true, seen: true } : j,
          ),
        }));
      },
    }),
    {
      // Bumped to v2 to force a clean slate on iPhone/mobile browsers that kept serving the old
      // v1 persisted state (poisoned sessions) after the recent fixes.
      //
      // The base KEY (`chemclaw3.chat.v2`) is frozen from here on. Schema changes go through
      // `version` + `migrate` below: bumping the base key is a silent wipe of everyone's local
      // history, which is only ever acceptable as the emergency it was the first time.
      //
      // The full key is per-account (`chemclaw3.chat.v2.<oid>`; see `chatStorageKey`). It starts on
      // the `'anon'` slot and is re-pointed to the signed-in account's slot by
      // `hydrateChatForAccount`, which the auth bootstrap calls once identity is known. Paired with
      // `skipHydration` below: nothing is read off disk until that call, so one chemist's transcript
      // is never rehydrated into the next chemist's session on a shared workstation.
      name: chatStorageKey(null),
      version: 3,
      storage: chatStorage,

      // Do NOT auto-load on store creation: which account's slot to read is not known until the
      // auth provider resolves. `hydrateChatForAccount` performs the deferred read against the
      // right slot. (A test that needs persisted state can call `useChatStore.persist.rehydrate()`.)
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
            messages: conversation.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) =>
              m.role === 'assistant' && m.status === 'streaming'
                ? {
                    ...m,
                    status: 'aborted' as const,
                    error: {
                      kind: 'stream' as ApiErrorKind,
                      message: 'Interrupted by a page reload.',
                    },
                  }
                : m,
            ),
          };
        }

        // The feed is durable now, but bounded twice: dropped with the conversation it belongs to
        // (so `MAX_CONVERSATIONS` trimming cannot leave orphan cards), and aged out, without which
        // it would only ever grow.
        const cutoff = Date.now() - JOB_FEED_MAX_AGE_MS;
        const jobFeed = state.jobFeed.filter(
          (j) =>
            j.receivedAt > cutoff && (j.conversationId === null || conversations[j.conversationId]),
        );

        // sessionId IS persisted: it may well still be alive after a reload, and if it is not,
        // the 404 path recreates it transparently.
        return {
          conversations,
          order,
          activeId: state.activeId,
          jobFeed,
          notifyOnJobComplete: state.notifyOnJobComplete,
        };
      },
    },
  ),
);
