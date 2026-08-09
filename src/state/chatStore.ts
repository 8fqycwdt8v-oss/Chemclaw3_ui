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
import type { ChemclawEvent, JobCompletedEvent } from '../../shared/events.ts';
import type { ApiErrorKind } from '../api/errors.ts';
import type {
  AssistantMessage,
  Banner,
  ChatMessage,
  ComposerLock,
  Conversation,
  TraceEntry,
} from './types.ts';

/** Exactly the slice `partialize` writes to localStorage, and what `migrate` must return. */
interface PersistedState {
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
}

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
  ending: { result: string } | { failed: true },
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
  /** Cross-turn job completions from `GET /sessions/{id}/events`. Not persisted. */
  jobFeed: JobCompletedEvent[];
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
  setStreaming: (s: ChatState['streaming']) => void;
  pushJobCompleted: (event: JobCompletedEvent) => void;
  dismissJobCompleted: (jobId: string) => void;
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
      jobFeed: [],
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
        set(() => {
          const fresh = newConversation();
          return {
            conversations: { [fresh.id]: fresh },
            order: [fresh.id],
            activeId: fresh.id,
            drafts: {},
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
          // Not its own row: it closes the `tool_call` row already in the trace.
          set((s) =>
            updateAssistant(s, conversationId, messageId, (m) => ({
              ...m,
              trace: closeToolCall(m.trace, event.tool, { result: event.preview }),
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
      setDraft(conversationId, text) {
        set((s) => ({ drafts: { ...s.drafts, [conversationId]: text } }));
      },

      setBanner(banner) {
        set({ banner });
      },
      setStreaming(streaming) {
        set({ streaming });
      },
      pushJobCompleted(event) {
        // Newest first, and deduplicated by job id: the push-back stream reconnects with backoff
        // and an at-least-once delivery can repeat a completion, which would otherwise stack up as
        // two identical cards.
        set((s) => ({
          jobFeed: [event, ...s.jobFeed.filter((j) => j.job_id !== event.job_id)].slice(0, 50),
        }));
      },
      dismissJobCompleted(jobId) {
        set((s) => ({ jobFeed: s.jobFeed.filter((j) => j.job_id !== jobId) }));
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
      version: 2,
      storage: createJSONStorage(() => localStorage),

      /**
       * v1 -> v2 adds no fields; it exists to establish the upgrade path and to repair state the
       * old code could persist but the new code assumes away. Unknown/older versions fall back to
       * a clean slate rather than guessing.
       */
      migrate: (persisted, version) => {
        if (version >= 2) return persisted as PersistedState;
        const state = persisted as Partial<PersistedState> | undefined;
        if (!state?.conversations || !state.order) return { conversations: {}, order: [], activeId: null };

        // A message left mid-stream by a build that predates the partialize guard would otherwise
        // rehydrate as 'streaming' and spin forever — there is no resume endpoint.
        const conversations: Record<string, Conversation> = {};
        for (const [id, conversation] of Object.entries(state.conversations)) {
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
        const order = state.order.filter((id) => conversations[id]);
        return {
          conversations,
          order,
          activeId: state.activeId && conversations[state.activeId] ? state.activeId : (order[0] ?? null),
        };
      },

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
        // sessionId IS persisted: it may well still be alive after a reload, and if it is not,
        // the 404 path recreates it transparently.
        return { conversations, order, activeId: state.activeId };
      },
    },
  ),
);
