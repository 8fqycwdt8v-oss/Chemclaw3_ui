/**
 * The turn orchestrator: everything that happens between pressing Send and the answer settling.
 *
 * Lives outside React deliberately — it is a sequence, not a render concern, and it drives the
 * store directly via `getState()`.
 */

import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { streamTurn } from '../api/streamTurn.ts';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from './chatStore.ts';

export interface SendOptions {
  conversationId: string;
  text: string;
  dryRun?: boolean;
  auth: AuthProvider;
}

/** Ensure the conversation has a live server session, creating one if needed. */
async function ensureSession(conversationId: string, auth: AuthProvider): Promise<string> {
  const store = useChatStore.getState();
  const existing = store.conversations[conversationId]?.sessionId;
  if (existing) return existing;

  // The profile is fixed for a session's life, so it is chosen once — here — and carried along
  // when a session has to be replaced, or a conversation would silently change agent underneath
  // its own transcript.
  const profile = store.conversations[conversationId]?.profile ?? null;
  const { session_id } = await api.createSession(() => auth.getAccessToken(), profile);
  useChatStore.getState().setSessionId(conversationId, session_id);
  return session_id;
}

/**
 * Batch token events to one store write per animation frame.
 *
 * At ~60 fps this is invisible to the user but turns a 2000-token answer from 2000 renders into
 * roughly 100. The flush is exposed so non-token events can force ordering: the backend emits a
 * turn's tokens before the tool calls of the same update, so a trace entry landing ahead of its
 * pending text would misrepresent what happened.
 */
function createTokenBatcher(conversationId: string, messageId: string) {
  let pending = '';
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (!pending) return;
    // Cleared BEFORE the store write, not after.
    //
    // zustand's persist middleware patches setState as "apply the update, then write to storage",
    // so by the time `localStorage.setItem` can throw — a QuotaExceededError, which a long
    // conversation makes entirely reachable — the tokens are already in the store. Clearing
    // afterwards meant the throw skipped the reset and left `pending` intact, so every subsequent
    // flush re-appended everything already flushed and the answer grew quadratically.
    const text = pending;
    pending = '';
    useChatStore.getState().appendTokens(conversationId, messageId, text);
  };

  return {
    push(text: string): void {
      pending += text;
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    },
    flush,
  };
}

export async function sendMessage(opts: SendOptions): Promise<void> {
  const { conversationId, text, dryRun, auth } = opts;
  const store = useChatStore.getState();

  if (store.composerLock) return;
  if (!text.trim()) return;

  store.appendUserMessage(conversationId, text);
  const messageId = store.startAssistantMessage(conversationId);

  const abort = new AbortController();
  store.setStreaming({ conversationId, messageId, abort });
  store.setComposerLock('turn_in_flight');
  store.setBanner(null);

  const batcher = createTokenBatcher(conversationId, messageId);

  const runOnce = async (sessionId: string): Promise<void> => {
    await streamTurn({
      sessionId,
      message: text,
      dryRun,
      signal: abort.signal,
      getToken: () => auth.getAccessToken(),
      onEvent(event) {
        if (event.type === 'token') {
          batcher.push(event.text);
          return;
        }
        batcher.flush();
        useChatStore.getState().applyEvent(conversationId, messageId, event);
      },
    });
    batcher.flush();
  };

  // Guards a single recovery attempt each. Booleans, not a loop: retrying a turn costs real
  // money and can collide with the backend's per-session lock, so recovery must be bounded and
  // obviously so.
  let recreatedSession = false;
  let reauthed = false;

  try {
    for (;;) {
      const sessionId = await ensureSession(conversationId, auth);
      try {
        await runOnce(sessionId);
        useChatStore.getState().finishTurn(conversationId, messageId, 'done');
        useChatStore.getState().setComposerLock(false);
        return;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;

        // The session handle is dead: unknown, someone else's, or evicted from the backend's
        // live-session LRU. Mint a new one and replay the message exactly once. The transcript
        // belongs to the local conversation, so nothing visible is lost — but the AGENT has
        // lost its context, and we mark that rather than pretending continuity.
        if (err.kind === 'session_not_found' && !recreatedSession) {
          recreatedSession = true;
          const recreateProfile =
            useChatStore.getState().conversations[conversationId]?.profile ?? null;
          const { session_id } = await api.createSession(
            () => auth.getAccessToken(),
            recreateProfile,
          );
          useChatStore.getState().setSessionId(conversationId, session_id, true);
          continue;
        }

        // Token expired mid-flight. Re-authenticate once; if that needs an interactive redirect
        // the provider returns false and navigation is already under way.
        if (err.kind === 'unauthorized' && !reauthed) {
          reauthed = true;
          const recovered = await auth.handleUnauthorized();
          if (recovered) continue;
        }

        throw err;
      }
    }
  } catch (err) {
    const apiError =
      err instanceof ApiError
        ? err
        : new ApiError('stream', err instanceof Error ? err.message : 'The turn failed.');

    batcher.flush();

    if (apiError.kind === 'aborted') {
      useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
      useChatStore.getState().setComposerLock(false);
      return;
    }

    useChatStore.getState().failTurn(conversationId, messageId, {
      kind: apiError.kind,
      message: apiError.message,
      // Carried through to the error card. The correlation id is the key the backend's audit
      // trail is indexed on and the only place it reaches a client — so dropping it here, on
      // the failure path, was the difference between a reportable failure and an unreportable
      // one. It survived only on the non-terminal notice path, i.e. the cases that are not
      // failures.
      ...(apiError.code ? { code: apiError.code } : {}),
      ...(apiError.correlationId ? { correlationId: apiError.correlationId } : {}),
    });

    // 429 is terminal — the budget does not replenish on a retry, so leave the composer locked
    // and say so. Everything else releases the composer and surfaces a banner.
    if (apiError.kind === 'budget_exhausted') {
      useChatStore.getState().setComposerLock('budget_exhausted');
      useChatStore.getState().setBanner({ kind: 'error', text: apiError.message });
      return;
    }

    useChatStore.getState().setComposerLock(false);
    useChatStore.getState().setBanner({
      kind: 'error',
      text: apiError.message,
      action:
        apiError.kind === 'unauthorized'
          ? 'reauth'
          : apiError.kind === 'turn_in_flight' || apiError.kind === 'session_not_found'
            ? 'reset'
            : apiError.retryable
              ? 'retry'
              : undefined,
    });
  } finally {
    const streaming = useChatStore.getState().streaming;
    if (streaming?.messageId === messageId) useChatStore.getState().setStreaming(null);
  }
}

/**
 * Stop the in-flight turn.
 *
 * Aborting the fetch cancels the response body, which closes the socket to the BFF, which
 * destroys its upstream request, which FastAPI sees as a client disconnect — releasing the
 * session's turn slot. That chain is why the next message does not come back 409.
 */
export function stopStreaming(): void {
  const { streaming } = useChatStore.getState();
  streaming?.abort.abort();
}

/**
 * Abandon the current server session and start a fresh one for the same conversation.
 *
 * The escape hatch from a stuck 409: the backend has no cancel endpoint, so if a turn is wedged
 * server-side the only way forward is a new session. Marks the conversation context-lost.
 */
export async function resetSession(conversationId: string, auth: AuthProvider): Promise<void> {
  const profile = useChatStore.getState().conversations[conversationId]?.profile ?? null;
  const { session_id } = await api.createSession(() => auth.getAccessToken(), profile);
  useChatStore.getState().setSessionId(conversationId, session_id, true);
  useChatStore.getState().setComposerLock(false);
  useChatStore.getState().setBanner(null);
}
