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
  const stop = (): void => {
    // Server first, then socket: the backend detaches on disconnect
    // (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop), so aborting the fetch alone would
    // leave the turn running — and the session 409-busy — for its whole remaining duration.
    // Fire-and-forget: the abort below is what the UI reacts to, and a stop that raced the
    // turn's own completion resolves `false` harmlessly.
    const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
    if (sessionId) void api.stopTurn(sessionId, () => auth.getAccessToken()).catch(() => undefined);
    abort.abort();
  };
  store.setStreaming({ conversationId, messageId, abort, stop });
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
        useChatStore.getState().setComposerLock(false);
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

    // The signal, not only the error kind: a Stop pressed just as the server ends the stream
    // surfaces as a `stream` error with the abort already set, and that is a stop, not a drop —
    // recovering it would poll for an answer the user just cancelled.
    if (apiError.kind === 'aborted' || abort.signal.aborted) {
      useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
      useChatStore.getState().setComposerLock(false);
      announceStatus('Stopped before the answer was complete.');
      return;
    }

    // An accidental drop is not a stop: the backend detaches and the turn runs to completion
    // server-side (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop), so a broken stream is a
    // *recoverable* state — the answer will land in the session transcript. Poll it back rather
    // than surfacing a dead-end banner for work that is still happening.
    if (apiError.kind === 'stream' || apiError.kind === 'network') {
      const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
      if (sessionId) {
        useChatStore.getState().setBanner({
          kind: 'info',
          text: 'Connection lost — the turn is still running on the server; recovering the answer…',
        });
        announceStatus('Connection lost; waiting for the server to finish the turn.');
        const recovered = await recoverDetachedAnswer(sessionId, opts.text, abort.signal, auth);
        if (recovered !== null) {
          useChatStore.getState().applyEvent(conversationId, messageId, {
            type: 'answer',
            text: recovered,
            confidence: null,
            unsupported_claims: [],
            review_required: false,
            verified_by: null,
          });
          useChatStore.getState().finishTurn(conversationId, messageId, 'done');
          useChatStore.getState().setComposerLock(false);
          useChatStore.getState().setBanner(null);
          announceStatus(describeAnswer(recovered));
          return;
        }
        if (abort.signal.aborted) {
          useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
          useChatStore.getState().setComposerLock(false);
          useChatStore.getState().setBanner(null);
          announceStatus('Stopped before the answer was complete.');
          return;
        }
      }
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

    // 429 is terminal — the budget does not replenish on a retry, so leave the composer locked
    // and say so. Everything else releases the composer and surfaces a banner.
    if (apiError.kind === 'budget_exhausted') {
      useChatStore.getState().setComposerLock('budget_exhausted');
      useChatStore.getState().setBanner({ kind: 'error', text });
      return;
    }

    useChatStore.getState().setComposerLock(false);
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
 * Read a detached turn's answer back from the transcript, or `null` when it never appears.
 *
 * The detached turn writes its exchange to `session_messages` at its true end, so the recovery
 * signal is an assistant entry following the last transcript entry that carries this turn's own
 * question. Bounded — the server's turn deadline is 600 s, and polling much past it would wait
 * on a turn that can no longer exist — and abandoned early if the user presses Stop, whose
 * `stop()` both cancels the server turn and flips this signal.
 */
async function recoverDetachedAnswer(
  sessionId: string,
  question: string,
  signal: AbortSignal,
  auth: AuthProvider,
): Promise<string | null> {
  const deadline = Date.now() + 630_000;
  while (Date.now() < deadline && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    let transcript;
    try {
      transcript = await api.getMessages(sessionId, () => auth.getAccessToken());
    } catch {
      continue; // the network that dropped the stream may still be flapping — keep trying
    }
    const asked = transcript.map((m) => (m.role === 'user' ? m.text : null)).lastIndexOf(question);
    if (asked === -1) continue; // the turn has not committed its exchange yet
    const answer = transcript
      .slice(asked + 1)
      .find((m) => m.role === 'assistant' && m.text.trim() !== '');
    if (answer) return answer.text;
  }
  return null;
}

/**
 * Stop the in-flight turn.
 *
 * Two acts now, in order: `POST /sessions/{id}/turn/stop` cancels the turn on the server, and
 * aborting the fetch closes the local stream. The socket close alone used to be the whole stop —
 * the backend read any disconnect as cancellation — but a disconnect only *detaches* now
 * (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop), so without the explicit request the turn
 * would run on and the next message would 409 until it finished.
 */
export function stopStreaming(): void {
  const { streaming } = useChatStore.getState();
  streaming?.stop();
}

/**
 * Abandon the current server session and start a fresh one for the same conversation.
 *
 * The escape hatch from a stuck 409. The backend has a cancel endpoint now
 * (`stopStreaming` uses it), so this is for the narrower case it cannot reach: a turn wedged on
 * a *different* front-door replica, whose pump only that process can cancel. Marks the
 * conversation context-lost.
 */
export async function resetSession(conversationId: string, auth: AuthProvider): Promise<void> {
  const { session_id } = await api.createSession(auth, profileFor(conversationId));
  useChatStore.getState().setSessionId(conversationId, session_id, true);
  useChatStore.getState().setComposerLock(false);
  useChatStore.getState().setBanner(null);
}
