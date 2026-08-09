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
  failTurn: (conversationId: string, messageId: string, error: AssistantMessage['error']) => void;

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

/**
 * The live storage key.
 *
 * `chemclaw3.chat.v2`, and it stays there. A previous attempt at this "fixed" the orphaned-blob
 * problem by renaming the key to `chemclaw3.chat` — which is the same mistake one hop along, and a
 * worse one: zustand's `hydrate()` reads `storage.getItem(options.name)` and nothing else, so
 * renaming the key does not migrate anything, it hides it. Every existing conversation would have
 * vanished from the sidebar while still occupying the origin's quota.
 *
 * Schema evolution belongs in `version`, which is what it is for. The key is an address.
 */
export const STORAGE_KEY = 'chemclaw3.chat.v2';

/**
 * Keys this app has written under previously, newest first.
 *
 * `chemclaw3.chat` is the short-lived name introduced and reverted on this branch; `.v1` predates
 * it. `adoptLegacyBlob()` promotes the newest of these into `STORAGE_KEY` when the live key is
 * empty, so a user who ran any build gets their history back exactly once. After that they are
 * removed — a migration that leaves the source in place is how the quota filled up the first time.
 */
export const LEGACY_KEYS = ['chemclaw3.chat', 'chemclaw3.chat.v1'] as const;

/**
 * localStorage, with a one-time read-through to whatever key this app used to write.
 *
 * The adoption happens on READ rather than at import, and that is the whole design. zustand's
 * `hydrate()` calls `storage.getItem(options.name)` and consults nothing else, so a blob under any
 * other name is invisible to it — which is exactly how the previous key rename lost everyone's
 * history. Answering that single `getItem` with the legacy blob is the only place a rename can be
 * repaired, and it means adoption cannot be defeated by module-evaluation order.
 *
 * The legacy entry is removed as it is adopted: a migration that leaves its source behind is what
 * filled the origin's quota the first time.
 */
const chatStorage = createJSONStorage(() => ({
  getItem: (name: string): string | null => {
    const live = localStorage.getItem(name);
    if (live !== null) {
      // The live key wins; anything under an old name is now dead weight.
      for (const key of LEGACY_KEYS) localStorage.removeItem(key);
      return live;
    }
    for (const key of LEGACY_KEYS) {
      const blob = localStorage.getItem(key);
      if (blob === null) continue;
      localStorage.removeItem(key);
      return blob;
    }
    return null;
  },
  setItem: (name: string, value: string): void => localStorage.setItem(name, value),
  removeItem: (name: string): void => localStorage.removeItem(name),
}));

interface PersistedChat {
  conversations: Record<string, unknown>;
  order: string[];
  activeId: string | null;
}

/**
 * Remove every key this app has ever written. Safe to call when storage is unavailable.
 *
 * Note what this cannot do on its own: the persist middleware writes the store back on the very
 * next `set`, so calling this and then mutating state re-creates the live key. Callers that need
 * the data gone for good reload immediately afterwards (`main.tsx`), and callers that only need
 * the OLD data gone rely on the subsequent write being a fresh slate (`clearAll`).
 */
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

/**
 * Keep `order` within `MAX_CONVERSATIONS`, dropping the oldest — but never one that is busy.
 *
 * Two things this has to get right, both learned the hard way.
 *
 * A bare `order.slice(0, MAX)` in `createConversation` looked like a fix and was a worse bug:
 * `Sidebar` appends server-listed sessions to the tail unbounded, so `order` routinely exceeds the
 * cap, and the next "New conversation" click deleted the tail *immediately* — mid-session, with no
 * warning. Losing a conversation on reload is bad; losing one while the user is looking at the
 * list is worse.
 *
 * And the dropped ids must leave `conversations` too. Truncating only `order` left the objects
 * unreachable but resident, so a long session grew monotonically while the sidebar showed nothing.
 *
 * A conversation with a live turn is never dropped. Its stream writes into the store by id, so
 * evicting it would leave a turn spending budget on something nothing can render.
 */
function trimOrder(
  order: string[],
  conversations: Record<string, Conversation>,
  streamingId: string | null,
): { order: string[]; conversations: Record<string, Conversation> } {
  if (order.length <= MAX_CONVERSATIONS) return { order, conversations };

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of order) {
    if (kept.length < MAX_CONVERSATIONS || id === streamingId) kept.push(id);
    else dropped.push(id);
  }
  if (dropped.length === 0) return { order: kept, conversations };

  const next = { ...conversations };
  for (const id of dropped) delete next[id];
  return { order: kept, conversations: next };
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
        set((s) => {
          const { order, conversations } = trimOrder(
            [conversation.id, ...s.order],
            { ...s.conversations, [conversation.id]: conversation },
            s.streaming?.conversationId ?? null,
          );
          return {
            conversations,
            order,
            activeId: conversation.id,
            composerLock: s.composerLock === 'budget_exhausted' ? s.composerLock : false,
            banner: s.composerLock === 'budget_exhausted' ? s.banner : null,
          };
        });
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
        // The persist middleware writes on the `set` below, so this cannot leave the live key
        // empty — what it does is remove the legacy keys and guarantee the next write is a fresh
        // slate rather than the old transcripts.
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
            // Cleared, not merely hidden. `TurnNoticePill` suppresses itself once the status is
            // 'error', but that left `notice` in state for any other reader to find — and the
            // suppression is not ordering-guaranteed either, so the pill could flash before the
            // error card replaced it. A failed turn has one story.
            notice: null,
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
      storage: chatStorage,

      /**
       * Cheap: a slice and a record of existing references, O(conversations) rather than
       * O(messages).
       *
       * This used to `.map()` every message of every persisted conversation to demote a still-
       * streaming message to 'aborted'. zustand computes `partialize` eagerly on EVERY setState,
       * and tokens flush once per animation frame — so that walk ran ~60 times a second over the
       * whole history, ahead of a synchronous `localStorage.setItem` of the same.
       *
       * The demotion moved to `merge`, which runs on every load — and it belongs at load time
       * anyway: writing 'aborted' at save time meant the persisted copy briefly lied about a turn
       * that was still running, and then got rewritten a frame later. (It was first moved to
       * `migrate`, which zustand only calls on a version mismatch, so it ran on no loads at all.)
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
       * Bring a stored blob into the current shape — on EVERY load.
       *
       * `merge` rather than `migrate`, and the distinction is the bug that made this necessary.
       * zustand calls `migrate` only when the stored version differs from the configured one, so a
       * per-load invariant placed there runs on exactly zero normal loads. The demotion below is
       * such an invariant: a message left marked `streaming` by a reload must be retired every
       * time it is read, not once when a version number happens to change.
       *
       * `merge` is called on every hydration with whatever `migrate` produced (or the raw state),
       * which makes it the correct home for both the shape-tolerance and the demotion.
       */
      merge: (persisted, current) => {
        const state = persisted as Partial<PersistedChat> | undefined;
        if (!state) return current;

        const conversations: Record<string, Conversation> = {};
        for (const [id, raw] of Object.entries(state.conversations ?? {})) {
          const conversation = coerceConversation(raw);
          if (conversation) conversations[id] = conversation;
        }
        // An id in `order` naming no surviving conversation would render as a blank row.
        const order = (state.order ?? []).filter((id) => conversations[id] !== undefined);

        return {
          ...current,
          conversations,
          order,
          activeId: state.activeId && conversations[state.activeId] ? state.activeId : null,
        };
      },

      /**
       * Version steps.
       *
       * Deliberately thin: `merge` above already normalises every field on every load, so a new
       * optional field on `AssistantMessage` needs no version bump and no step here. This exists
       * for changes `coerceConversation` cannot express as a default — a renamed field, a
       * restructured shape — and must still be present, because zustand logs an error and drops
       * the state entirely if a version mismatch finds no `migrate`.
       */
      migrate: (persisted) => persisted,
    },
  ),
);
