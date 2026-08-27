/**
 * The turn orchestrator: everything that happens between pressing Send and the answer settling.
 *
 * Lives outside React deliberately — it is a sequence, not a render concern, and it drives the
 * store directly via `getState()`.
 */

import { api } from '../api/client.ts';
import { config } from '../env.ts';
import { prefetchMarkdown } from '../components/LazyMarkdown.tsx';
import { ApiError } from '../api/errors.ts';
import { streamTurn } from '../api/streamTurn.ts';
import type { AuthProvider } from '../auth/types.ts';
import type { ComposerLock } from './types.ts';
import { useChatStore } from './chatStore.ts';
import { useEntityStore } from '../chem/entities.ts';
import { announceStatus, describeAnswer } from './announce.ts';

export interface SendOptions {
  conversationId: string;
  text: string;
  dryRun?: boolean;
  auth: AuthProvider;
}

/**
 * Sessions being minted right now, keyed by conversation.
 *
 * Module scope, not the store (a Promise is not serialisable, and `clearAll` would drop it
 * mid-flight) and not a ref (the composer's keystroke and the send path are different callers that
 * must share). It also survives StrictMode's double-invoke, which is the bug this defends.
 */
const sessionsInFlight = new Map<string, Promise<string>>();

/**
 * The agent profile this conversation's session should be minted on, if one was chosen.
 *
 * Read at every mint rather than once, and that is the point: a session is replaced on
 * `session_not_found` recovery and by `resetSession`, and a replacement that silently dropped
 * the profile would move the conversation onto a different agent without saying so.
 */
const profileFor = (conversationId: string): string | undefined =>
  useChatStore.getState().sessionProfiles[conversationId];

/**
 * Ensure the conversation has a live server session, creating one if needed.
 *
 * Shared by the send path and by `warmSession`, so a warm already in flight is awaited rather than
 * raced. Two concurrent creates would otherwise mint two backend sessions and leave the store
 * pointing at the one the in-flight turn is NOT using — context lost with nothing to flag it.
 */
async function ensureSession(conversationId: string, auth: AuthProvider): Promise<string> {
  const existing = useChatStore.getState().conversations[conversationId]?.sessionId;
  if (existing) return existing;

  const pending = sessionsInFlight.get(conversationId);
  if (pending) return pending;

  const creating = api
    .createSession(auth, profileFor(conversationId))
    // Compare-and-set: whoever gets there first wins, and both callers are told the winner. A
    // loser's session is an orphan that ages out of the backend's LRU.
    .then(({ session_id }) =>
      useChatStore.getState().setSessionIdIfAbsent(conversationId, session_id),
    )
    .finally(() => sessionsInFlight.delete(conversationId));

  sessionsInFlight.set(conversationId, creating);
  return creating;
}

/**
 * Mint the session ahead of the first send.
 *
 * The first message otherwise costs two sequential round-trips — `POST /sessions`, then
 * `POST /messages` — with the user's bubble and a spinner already on screen for both. Doing the
 * first one while they are still typing hides it entirely.
 *
 * Failure is deliberately silent: this is speculative, and `ensureSession` will try again for
 * real when they actually send.
 */
export function warmSession(conversationId: string, auth: AuthProvider): void {
  if (!config.warmSessions) return;
  if (useChatStore.getState().conversations[conversationId]?.sessionId) return;
  void ensureSession(conversationId, auth).catch(() => undefined);
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
    useChatStore.getState().appendTokens(conversationId, messageId, pending);
    pending = '';
  };

  return {
    push(text: string): void {
      // The answer will need the markdown chunk the moment it settles. Fetching it now, in
      // parallel with the rest of the stream, is what keeps the Suspense fallback off screen.
      prefetchMarkdown();
      pending += text;
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    },
    flush,
  };
}

/** The settled answer, read back for the completion announcement. */
function answerText(conversationId: string, messageId: string): string {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') return '';
  return message.finalText ?? message.streamedText;
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

  /**
   * Set the composer lock, but only while this turn is still the one the app is waiting on.
   *
   * The lock is a single global slot, and so is `streaming`. An older turn finishing must not
   * unlock a composer that a newer one owns — `finishTurn` and `setStreaming` are already keyed
   * on `messageId` for exactly that reason, and this was the one write that was not.
   */
  const releaseComposer = (lock: ComposerLock): void => {
    const streaming = useChatStore.getState().streaming;
    if (streaming && streaming.messageId !== messageId) return;
    useChatStore.getState().setComposerLock(lock);
  };

  const runOnce = async (sessionId: string): Promise<void> => {
    await streamTurn({
      sessionId,
      message: text,
      dryRun,
      signal: abort.signal,
      getToken: () => auth.getAccessToken(),
      onEvent(event) {
        if (event.type === 'token') {
          // Unattributed tokens only, which is the backend's own rule for this stream: a token
          // carrying an `agent` is a subagent's working prose, and concatenating it splices
          // another agent's notes into the answer a chemist reads. Invisible most of the time
          // because the root-only `answer` event replaces the render — and not invisible at all
          // when the turn is stopped, times out, or hits the loop cap, where the streamed text is
          // what is kept and persisted.
          if (!event.agent) batcher.push(event.text);
          return;
        }
        batcher.flush();
        // A queued turn is the one state a listener cannot infer from silence: nothing is
        // running yet, and without this the wait is indistinguishable from a hang.
        if (event.type === 'queued') announceStatus('Waiting for a free slot on the server.');
        useChatStore.getState().applyEvent(conversationId, messageId, event);
        // The conversation's subject index. Fire-and-forget: ingestion canonicalises through
        // RDKit, so it is asynchronous, and the transcript must not wait on a WASM call to render
        // the event it has already applied. Named with this conversation's id rather than the
        // store's idea of the active one — the rail and the transcript have to describe the same
        // conversation even when the reader has switched away mid-turn.
        void useEntityStore.getState().ingest(conversationId, messageId, event);
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
        releaseComposer(false);
        // Announced, not focused: moving focus here would interrupt a listener mid-sentence.
        // The answer carries tabIndex={-1} so they can navigate to it when ready.
        announceStatus(describeAnswer(answerText(conversationId, messageId)));
        return;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;

        // The session handle is dead: unknown, someone else's, or evicted from the backend's
        // live-session LRU. Mint a new one and replay the message exactly once. The transcript
        // belongs to the local conversation, so nothing visible is lost — but the AGENT has
        // lost its context, and we mark that rather than pretending continuity.
        if (err.kind === 'session_not_found' && !recreatedSession) {
          recreatedSession = true;
          const { session_id } = await api.createSession(auth, profileFor(conversationId));
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
      releaseComposer(false);
      announceStatus('Stopped before the answer was complete.');
      return;
    }

    // Failures are NOT announced here. `failTurn` raises a banner that already carries
    // `role="alert"`, and a second polite announcement of the same sentence reads it twice.

    useChatStore
      .getState()
      .failTurn(conversationId, messageId, { kind: apiError.kind, message: apiError.message });

    // The service's own id for the failed turn, when it sent one. Appended to the banner text
    // rather than given a field of its own: it is the one thing a support conversation needs and
    // nothing in the UI can act on it, so it belongs where it can be selected and copied.
    const text = apiError.correlationId
      ? `${apiError.message} (reference ${apiError.correlationId})`
      : apiError.message;

    // The chemist's question, back where they typed it. `Composer` clears the draft at submit,
    // so before this a failed turn also destroyed the message — the "Retry" on the banner is a
    // rehydrate of the transcript and has never re-sent anything. Only into an empty draft:
    // whatever they have typed since is newer than this.
    if (!useChatStore.getState().drafts[conversationId]) {
      useChatStore.getState().setDraft(conversationId, opts.text);
    }

    // A budget that is genuinely gone is terminal — it does not replenish because somebody
    // pressed a button — so leave the composer locked and say so. A turn the service *shed*
    // carries the same code and `retryable`, and falls through to the ordinary branch below,
    // which already offers Retry.
    if (apiError.kind === 'budget_exhausted' && !apiError.retryable) {
      releaseComposer('budget_exhausted');
      useChatStore.getState().setBanner({ kind: 'error', text });
      return;
    }

    releaseComposer(false);
    useChatStore.getState().setBanner({
      kind: 'error',
      text,
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
  const { session_id } = await api.createSession(auth, profileFor(conversationId));
  useChatStore.getState().setSessionId(conversationId, session_id, true);
  useChatStore.getState().setComposerLock(false);
  useChatStore.getState().setBanner(null);
}
