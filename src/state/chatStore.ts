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
    trace: [],
    latestPlan: null,
    error: null,
  };
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
            })),
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

        const entry = traceEntryFor(event);
        if (!entry) return;

        set((s) =>
          updateAssistant(s, conversationId, messageId, (m) => ({
            ...m,
            trace: [...m.trace, entry].slice(-MAX_TRACE_ENTRIES),
            latestPlan: event.type === 'plan' ? event.todos : m.latestPlan,
          })),
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
      name: 'chemclaw3.chat.v2',
      version: 1,
      storage: createJSONStorage(() => localStorage),

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
