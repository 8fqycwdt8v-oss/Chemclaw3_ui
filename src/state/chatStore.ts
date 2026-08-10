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
import { persist, createJSONStorage } from 'zustand/middleware';
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
    queued: false,
    trace: [],
    latestPlan: null,
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
  ending: { result: string; resultRef?: string } | { failed: true },
): TraceEntry[] {
  const index = trace.findIndex(
    (entry) =>
      entry.kind === 'tool_call' &&
      entry.toolCall?.tool === tool &&
      entry.toolCall.result === undefined &&
      !entry.toolCall.failed,
  );
  const target = trace[index];
  if (index === -1 || !target?.toolCall) return trace;
  const updated: TraceEntry = { ...target, toolCall: { ...target.toolCall, ...ending } };
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
function settleJob(trace: TraceEntry[], jobId: string): TraceEntry[] {
  const index = trace.findIndex(
    (entry) => entry.kind === 'job_started' && entry.job?.jobId === jobId && !entry.job.settled,
  );
  const target = trace[index];
  if (index === -1 || !target?.job) return trace;
  const updated: TraceEntry = { ...target, job: { ...target.job, settled: true } };
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
        toolCall: { tool: event.tool, arguments: event.arguments },
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
        toolFailure: { tool: event.tool, message: event.message },
      };
    case 'job_started':
      return { ...base, kind: 'job_started', job: { jobId: event.job_id, kind: event.kind } };
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
        approval: { prompt: event.prompt, approvalId: event.approval_id },
      };
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
  /** Opt-in, and deliberately separate from `Notification.permission` — a browser-level
   *  revocation must read as "blocked", not as "off". */
  notifyOnJobComplete: boolean;
  streaming: { conversationId: string; messageId: string; abort: AbortController } | null;

  createConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
  setSessionId: (conversationId: string, sessionId: string, contextLost?: boolean) => void;
  hydrateTranscript: (conversationId: string, messages: ChatMessage[]) => void;

  appendUserMessage: (conversationId: string, text: string) => string;
  startAssistantMessage: (conversationId: string) => string;
  appendTokens: (conversationId: string, messageId: string, text: string) => void;
  applyEvent: (conversationId: string, messageId: string, event: ChemclawEvent) => void;
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
      notifyOnJobComplete: false,
      streaming: null,

      createConversation() {
        const conversation = newConversation();
        set((s) => ({
          conversations: { ...s.conversations, [conversation.id]: conversation },
          order: [conversation.id, ...s.order],
          activeId: conversation.id,
          composerLock: false,
          banner: null,
        }));
        return conversation.id;
      },

      selectConversation(id) {
        if (!get().conversations[id]) return;
        set({ activeId: id, composerLock: false, banner: null });
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
            return {
              ...m,
              trace: [...base, entry].slice(-MAX_TRACE_ENTRIES),
              latestPlan: event.type === 'plan' ? event.todos : m.latestPlan,
            };
          }),
        );
      },

      finishTurn(conversationId, messageId, status) {
        set((s) => updateAssistant(s, conversationId, messageId, (m) => ({ ...m, status })));
      },

      failTurn(conversationId, messageId, error) {
        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            status: 'error',
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
      // The KEY is frozen from here on. Schema changes go through `version` + `migrate` below:
      // bumping the key again is a silent wipe of everyone's local history, which is only ever
      // acceptable as the emergency it was the first time.
      name: 'chemclaw3.chat.v2',
      version: 3,
      storage: createJSONStorage(() => localStorage),

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
            messages: conversation.messages.map((m) =>
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
