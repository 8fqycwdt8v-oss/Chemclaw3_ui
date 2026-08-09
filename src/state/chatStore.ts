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
import type { ChemclawEvent, JobCompletedEvent, JobFailedEvent } from '../../shared/events.ts';
import type { ApiErrorKind } from '../api/errors.ts';
import type {
  AssistantMessage,
  Banner,
  ChatMessage,
  ComposerLock,
  Conversation,
  TraceEntry,
  TurnStatus,
} from './types.ts';

/** Keep persisted state bounded — see `partialize` below. */
const MAX_CONVERSATIONS = 30;
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
    profile: null,
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
    contextLost: false,
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
    notice: null,
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
  ending: { result: string; noteIds?: string[]; numbers?: number[] } | { failed: true },
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
    case 'job_failed':
      return {
        ...base,
        kind: 'job_failed',
        job: { jobId: event.job_id, reason: event.reason },
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
  /**
   * Cross-turn job outcomes from `GET /sessions/{id}/events`. Not persisted.
   *
   * Both outcomes, not just completions — a failed job is exactly the case a chemist cannot
   * discover any other way, since the promise "job started" was already made on the turn stream.
   */
  jobFeed: (JobCompletedEvent | JobFailedEvent)[];
  streaming: { conversationId: string; messageId: string; abort: AbortController } | null;

  createConversation: (profile?: string | null) => string;
  setProfile: (conversationId: string, profile: string | null) => void;
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
  setStreaming: (s: ChatState['streaming']) => void;
  pushJobEvent: (event: JobCompletedEvent | JobFailedEvent) => void;
  dismissJobEvent: (jobId: string) => void;
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

/** The live storage key. Versioned by `version`, not by the key — see the store config below. */
export const STORAGE_KEY = 'chemclaw3.chat';

/**
 * Keys this app has ever persisted under.
 *
 * Both legacy names are removed rather than migrated. The v1 blob was abandoned precisely because
 * it was poisoned (`d7e85d8`), and v2 exists only because that abandonment was done by renaming
 * the key; carrying either forward would reintroduce the state the rename was trying to escape.
 * They are deleted rather than left, because a user who resets to clear their work should not
 * still have it on disk.
 */
export const LEGACY_KEYS = ['chemclaw3.chat.v1', 'chemclaw3.chat.v2'] as const;

interface PersistedChat {
  conversations: Record<string, unknown>;
  order: string[];
  activeId: string | null;
}

/** Remove every key this app has ever written. Safe to call when storage is unavailable. */
export function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // A private-mode browser can refuse storage entirely; there is nothing to clean up there.
  }
}

/**
 * Coerce one stored conversation into the current shape, or `null` if it is unusable.
 *
 * Field-tolerant on purpose: a stored message missing a field added later gets that field's
 * default rather than failing the load. Without this, every addition to `AssistantMessage` would
 * need its own migration step, and the pressure would be to skip the bump and ship a store whose
 * shape does not match its type.
 */
function coerceConversation(raw: unknown): Conversation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;

  const messages: ChatMessage[] = [];
  for (const item of Array.isArray(o.messages) ? o.messages : []) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string') continue;
    if (m.role === 'user') {
      messages.push({
        id: m.id,
        role: 'user',
        text: typeof m.text === 'string' ? m.text : '',
        at: typeof m.at === 'number' ? m.at : Date.now(),
      });
      continue;
    }
    if (m.role !== 'assistant') continue;
    // A message still marked 'streaming' cannot be resumed — there is no endpoint for it — so it
    // is retired here, at load, rather than being written to disk as a lie about a live turn.
    const status = m.status === 'streaming' ? 'aborted' : (m.status as TurnStatus) || 'done';
    messages.push({
      id: m.id,
      role: 'assistant',
      at: typeof m.at === 'number' ? m.at : Date.now(),
      status,
      streamedText: typeof m.streamedText === 'string' ? m.streamedText : '',
      finalText: typeof m.finalText === 'string' ? m.finalText : null,
      confidence: typeof m.confidence === 'number' ? m.confidence : null,
      unsupportedClaims: Array.isArray(m.unsupportedClaims) ? m.unsupportedClaims.map(String) : [],
      reviewRequired: m.reviewRequired === true,
      verifiedBy:
        m.verifiedBy === 'judge' || m.verifiedBy === 'citation-gate' ? m.verifiedBy : null,
      degradedConnectors: Array.isArray(m.degradedConnectors)
        ? m.degradedConnectors.map(String)
        : [],
      queued: m.queued === true,
      trace: Array.isArray(m.trace) ? (m.trace as TraceEntry[]) : [],
      latestPlan: Array.isArray(m.latestPlan) ? m.latestPlan.map(String) : null,
      notice: null,
      error:
        m.status === 'streaming'
          ? { kind: 'stream' as ApiErrorKind, message: 'Interrupted by a page reload.' }
          : ((m.error as AssistantMessage['error']) ?? null),
    });
  }

  return {
    id: o.id,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    profile: typeof o.profile === 'string' ? o.profile : null,
    title: typeof o.title === 'string' ? o.title : 'New conversation',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
    messages,
    contextLost: o.contextLost === true,
  };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: {},
      order: [],
      activeId: null,
      composerLock: false,
      banner: null,
      jobFeed: [],
      streaming: null,

      createConversation(profile = null) {
        const conversation = { ...newConversation(), profile };
        set((s) => ({
          conversations: { ...s.conversations, [conversation.id]: conversation },
          // Trimmed in memory too, not only when persisting. `MAX_CONVERSATIONS` was enforced
          // solely in `partialize`, so conversation 31 was shown in the sidebar, worked in, and
          // then silently gone on reload — with no warning at any point.
          order: [conversation.id, ...s.order].slice(0, MAX_CONVERSATIONS),
          activeId: conversation.id,
          composerLock: s.composerLock === 'budget_exhausted' ? s.composerLock : false,
          banner: s.composerLock === 'budget_exhausted' ? s.banner : null,
        }));
        return conversation.id;
      },

      setProfile(conversationId, profile) {
        set((s) => {
          const conversation = s.conversations[conversationId];
          // Only before a session exists: after that the backend has already fixed it.
          if (!conversation || conversation.sessionId) return {};
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...conversation, profile },
            },
          };
        });
      },

      selectConversation(id) {
        if (!get().conversations[id]) return;
        set((s) => ({
          activeId: id,
          // A `budget_exhausted` lock is a property of the deployment, not of one conversation —
          // the budget is per-session AND per-user — so switching conversations must not clear it.
          // `turn_in_flight` is cleared, because the turn it refers to belongs to the conversation
          // being navigated away from; `Composer` still blocks on the global `streaming` while
          // that turn runs.
          composerLock: s.composerLock === 'budget_exhausted' ? s.composerLock : false,
          banner: s.composerLock === 'budget_exhausted' ? s.banner : null,
        }));
      },

      deleteConversation(id) {
        // Same reasoning as `clearAll`: deleting the conversation a turn is streaming into must
        // stop the turn, not merely stop showing it.
        const streaming = get().streaming;
        if (streaming?.conversationId === id) streaming.abort.abort();
        set((s) => {
          const { [id]: _removed, ...rest } = s.conversations;
          const order = s.order.filter((x) => x !== id);
          return {
            conversations: rest,
            order,
            activeId: s.activeId === id ? (order[0] ?? null) : s.activeId,
          };
        });
      },

      clearAll() {
        // Abort an in-flight turn before dropping the reference to its controller.
        //
        // "Reset app" used to set `streaming: null` and walk away, which dropped the
        // AbortController on the floor: the fetch kept running, kept spending the turn budget,
        // kept holding the session's turn lock — and `stopStreaming` could no longer reach it, so
        // there was no way to stop it short of closing the tab.
        get().streaming?.abort.abort();
        // Removes the legacy keys too, so a reset actually clears what is on disk.
        clearPersisted();
        set(() => {
          const fresh = newConversation();
          return {
            conversations: { [fresh.id]: fresh },
            order: [fresh.id],
            activeId: fresh.id,
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

        if (event.type === 'error') {
          // Recorded, never a trace row. `streamTurn` no longer throws on an error frame — a
          // non-terminal one (`loop_cap_reached`, `empty_answer`) is followed by the answer it
          // qualifies — so this is where that qualification lands. A terminal error also passes
          // through here and is then overwritten by `failTurn`, which is the right precedence:
          // a turn that failed should read as failed, not as an answer with a caveat.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              notice: {
                code: event.code,
                message: event.message,
                retryable: event.retryable,
                correlationId: event.correlation_id,
              },
            })),
          );
          return;
        }

        if (event.type === 'tool_result') {
          // Not its own row: it closes the `tool_call` row already in the trace.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              trace: closeToolCall(m.trace, event.tool, {
                result: event.preview,
                noteIds: event.note_ids,
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
            // call is running, the new row carries the reason.
            const base =
              event.type === 'tool_failed'
                ? closeToolCall(m.trace, event.tool, { failed: true })
                : m.trace;
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
      setBanner(banner) {
        set({ banner });
      },
      setStreaming(streaming) {
        set({ streaming });
      },
      pushJobEvent(event) {
        // Newest first, and deduplicated by job id: the push-back stream reconnects with backoff
        // and an at-least-once delivery can repeat a completion, which would otherwise stack up as
        // two identical cards.
        set((s) => ({
          jobFeed: [event, ...s.jobFeed.filter((j) => j.job_id !== event.job_id)].slice(0, 50),
        }));
      },
      dismissJobEvent(jobId) {
        set((s) => ({ jobFeed: s.jobFeed.filter((j) => j.job_id !== jobId) }));
      },
    }),
    {
      /**
       * A stable key, with schema evolution carried by `version` where it belongs.
       *
       * The key used to be versioned instead — it went `chemclaw3.chat.v1` -> `.v2` to force a
       * clean slate — and that is why the old blob is still on people's disks. zustand's migration
       * machinery only ever looks inside the blob at the *current* name, so for a v1 user there
       * was no v2 blob, `migrate` was never called, and megabytes of transcripts sat in the same
       * origin's quota forever: invisible to `clearAll`, and surviving "Reset app". For a tool
       * adjacent to GxP work, a reset that visibly clears your work while leaving it on disk is
       * the wrong answer twice over.
       *
       * `clearPersisted` below removes every key this app has ever used, and is called from
       * `clearAll`.
       */
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),

      /**
       * Cheap: a slice and a record of existing references, O(conversations) rather than
       * O(messages).
       *
       * This used to `.map()` every message of every persisted conversation to demote a still-
       * streaming message to 'aborted'. zustand computes `partialize` eagerly on EVERY setState,
       * and tokens flush once per animation frame — so that walk ran ~60 times a second over the
       * whole history, ahead of a synchronous `localStorage.setItem` of the same.
       *
       * The demotion moved to `migrate`, where it is also more correct: it belongs at load time.
       * Writing 'aborted' at save time meant the persisted copy briefly lied about a turn that was
       * still running, and then got rewritten a frame later.
       */
      partialize: (state) => ({
        conversations: Object.fromEntries(
          state.order
            .slice(0, MAX_CONVERSATIONS)
            .map((id) => [id, state.conversations[id]])
            .filter((entry): entry is [string, Conversation] => entry[1] !== undefined),
        ),
        order: state.order.slice(0, MAX_CONVERSATIONS),
        // sessionId IS persisted: it may well still be alive after a reload, and if it is not,
        // the 404 path recreates it transparently.
        activeId: state.activeId,
      }),

      /**
       * Bring a stored blob up to the current shape.
       *
       * Every conversation goes through `coerceConversation`, which fills defaults for anything
       * missing. That is what makes adding a field to `AssistantMessage` a non-event for stored
       * data — no version bump, no second migration — and it is also where a message left marked
       * 'streaming' by a reload is retired, since there is no resume endpoint and it would
       * otherwise hang forever.
       */
      migrate: (persisted) => {
        const state = persisted as Partial<PersistedChat> | undefined;
        if (!state) return { conversations: {}, order: [], activeId: null };
        const conversations: Record<string, Conversation> = {};
        for (const [id, raw] of Object.entries(state.conversations ?? {})) {
          const conversation = coerceConversation(raw);
          if (conversation) conversations[id] = conversation;
        }
        const order = (state.order ?? []).filter((id) => conversations[id] !== undefined);
        return {
          conversations,
          order,
          activeId: state.activeId && conversations[state.activeId] ? state.activeId : null,
        };
      },
    },
  ),
);
