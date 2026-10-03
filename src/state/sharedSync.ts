/**
 * Keeping an open shared conversation in step with the other people in it (Chemclaw3_ui #130).
 *
 * **What was wrong.** A shared conversation (Chemclaw3 #483) holds more than one person's turns,
 * and this browser only ever learnt about its own. The transcript was read back exactly once —
 * into an *empty* conversation the service had listed — so an owner never saw a member's question,
 * a member saw the conversation as it stood when they first opened it, and nobody saw somebody
 * else's turn while it ran, before or after a reload. The route to follow a running turn
 * (`GET /sessions/{id}/turn/stream`, Chemclaw3 #499) was used only to reattach a turn's own
 * sender.
 *
 * **What this does, for the one conversation on screen, while it is on screen:**
 *
 *  1. **Re-reads the transcript and merges it** (`mergeTranscript`) when the conversation is
 *     opened or the tab comes back into view, when a turn this browser sent ends, when a watched
 *     turn ends, and when the line says a turn it saw running has stopped. A merge never touches a
 *     turn this browser holds — least of all one it is streaming.
 *  2. **Follows somebody else's running turn live.** It reads the session's line
 *     (`GET /sessions/{id}/queue`) every `QUEUE_POLL_MS`, and when a turn is running that is not
 *     this browser's, attaches a watcher and renders the answer as it streams, in a placeholder
 *     the re-read replaces with the stored question and answer, attributed to their sender.
 *
 * **Bounded on purpose.** One watcher per open conversation; none while this browser has its own
 * turn running there (its own stream already carries everything, and a second view would be a
 * stream slot spent on nothing); the poll and the watcher stop when the tab is hidden and when the
 * conversation is closed. A watcher counts toward the per-person stream cap upstream, so a `429` —
 * the turn's watcher cap or this person's stream cap — and a `404` — the turn ended, or runs on
 * another replica — are ordinary states: the watcher stands down for `REFUSED_BACKOFF_MS` and the
 * re-read at the turn's end delivers the exchange anyway. `stream_lagged` reattaches a bounded
 * number of times, as the sender's own stream does.
 *
 * Outside React, like `sendMessage`: it is a sequence with timers and a socket, not a render
 * concern. `useSharedConversationSync` in `App.tsx` decides *whether* a conversation is shared and
 * calls `followSharedConversation`; everything after that is here.
 */

import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { streamTurn } from '../api/streamTurn.ts';
import type { AuthProvider } from '../auth/types.ts';
import { logger } from '../lib/logger.ts';
import { announceStatus } from './announce.ts';
import { useChatStore } from './chatStore.ts';
import { createTokenBatcher } from './sendMessage.ts';
import { transcriptToMessages } from './transcript.ts';

/** How often an open shared conversation asks whether somebody's turn is running. The cost is one
 *  small GET; the delay is how long after a colleague presses Send their turn appears here. */
export const QUEUE_POLL_MS = 5_000;

/** How long the watcher stands down after the service refused it or had nothing to show. */
export const REFUSED_BACKOFF_MS = 15_000;

/** The least time between two re-reads triggered by the window regaining focus. */
const FOCUS_SYNC_MIN_MS = 2_000;

/** How many times one watched turn reattaches after `stream_lagged` — `sendMessage`'s bound. */
const MAX_REATTACH = 2;

/**
 * The re-reads after a watched turn ends, in milliseconds from the first.
 *
 * The answer reaches a watcher as the turn writes it, and the exchange reaches the transcript in
 * the same turn's final write — so the first read may land before that write commits. The
 * placeholder stays (showing the answer) until a read finds the exchange, and is dropped after the
 * last one so a turn that stored nothing — stopped, failed — does not leave a ghost.
 */
const SETTLE_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Follow `conversationId`'s shared session until the returned function is called.
 *
 * The caller has decided the conversation is shared and has a session; this does not re-decide it.
 */
export function followSharedConversation(conversationId: string, auth: AuthProvider): () => void {
  const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState();
  const sessionId = (): string | null => store().conversations[conversationId]?.sessionId ?? null;
  const ownTurnHere = (): boolean => store().streaming?.conversationId === conversationId;
  const visible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden';

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: AbortController | null = null;
  /** What the last read of the line said, so its running → stopped edge can trigger a re-read. */
  let wasRunning = false;
  /** The watcher does not attach before this — set after the service refused it. */
  let quietUntil = 0;
  /** The line route answered 404: an older service, or this person is no longer in the session. */
  let lineGone = false;

  /* ------------------------------------------------------------ the re-read */

  let syncing: Promise<void> | null = null;
  let again = false;

  const readAndMerge = async (): Promise<void> => {
    const sid = sessionId();
    if (!sid) return;
    const held = store().conversations[conversationId];
    // An empty conversation the service listed is `useRemoteTranscript`'s to fill: it reads the
    // plan back before hydrating, and a hydrate from here could win the race and lose the plan.
    if (!held || (held.messages.length === 0 && held.sessionOrigin === 'server')) return;
    let remote: Awaited<ReturnType<typeof api.getMessages>>;
    try {
      remote = await api.getMessages(sid, auth);
    } catch (err) {
      // Not a banner: the conversation on screen is still what this browser knows, and the next
      // trigger — the next turn's end, the next focus — reads again.
      logger.info('shared.sync_failed', { kind: err instanceof ApiError ? err.kind : 'unknown' });
      return;
    }
    if (closed) return;
    const messages = transcriptToMessages(remote);
    if (messages.length === 0) return;
    if ((store().conversations[conversationId]?.messages.length ?? 0) === 0) {
      store().hydrateTranscript(conversationId, messages);
    } else {
      store().mergeRemoteTranscript(conversationId, messages);
    }
  };

  /** One read at a time; a trigger that lands during a read earns exactly one more. */
  const sync = (): Promise<void> => {
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        again = false;
        await readAndMerge();
      } while (again && !closed);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  const hasSettledWatched = (): boolean =>
    (store().conversations[conversationId]?.messages ?? []).some(
      (m) => m.role === 'assistant' && m.watched && m.status !== 'streaming',
    );

  /** Re-read until the exchange a finished watched turn stood for has replaced it. */
  const settleWatched = async (): Promise<void> => {
    for (const delay of SETTLE_DELAYS_MS) {
      await sleep(delay);
      if (closed || watcher) return;
      await sync();
      if (!hasSettledWatched()) return;
    }
    if (!closed && !watcher) store().dropWatchedTurns(conversationId);
  };

  /* ------------------------------------------------------------ the watcher */

  const stopWatching = (): void => {
    watcher?.abort();
    watcher = null;
    store().dropWatchedTurns(conversationId);
  };

  const watch = async (sid: string): Promise<void> => {
    const abort = new AbortController();
    watcher = abort;
    // Held in an object rather than two `let`s: both are assigned inside a callback, and narrowing
    // cannot see that, so after the call a `let` reads as permanently `null`.
    const view: { id: string | null; batcher: ReturnType<typeof createTokenBatcher> | null } = {
      id: null,
      batcher: null,
    };
    let reattached = 0;

    try {
      for (;;) {
        try {
          await streamTurn({
            sessionId: sid,
            message: '',
            watch: true,
            signal: abort.signal,
            getToken: () => auth.getAccessToken(),
            onAccepted() {
              // Opened only once the service has said there is a turn to show: a 404 or a 429
              // must not flash an empty answer into the transcript.
              if (view.id || abort.signal.aborted) return;
              view.id = store().startWatchedTurn(conversationId);
              view.batcher = createTokenBatcher(conversationId, view.id);
              announceStatus(
                'Another person’s turn is running in this conversation; following it.',
              );
            },
            onEvent(event) {
              if (!view.id) return;
              // The sender's rule (`sendMessage`): a token carrying an `agent` is a subagent's
              // working prose, never part of the answer.
              if (event.type === 'token') {
                if (!event.agent) view.batcher?.push(event.text);
                return;
              }
              view.batcher?.flush();
              store().applyEvent(conversationId, view.id, event);
            },
          });
          view.batcher?.flush();
          if (view.id) store().finishTurn(conversationId, view.id, 'done');
          break;
        } catch (err) {
          view.batcher?.flush();
          if (abort.signal.aborted) return;
          if (
            err instanceof ApiError &&
            err.kind === 'stream_lagged' &&
            reattached < MAX_REATTACH
          ) {
            reattached += 1;
            continue;
          }
          // 404 (the turn ended, or runs on another replica), 429 (the turn's watcher cap, or
          // this person's stream cap) and anything else: stand down, and let the re-read at the
          // turn's end deliver what this view could not.
          const wait =
            err instanceof ApiError
              ? Math.max(err.retryAfterSeconds * 1000, REFUSED_BACKOFF_MS)
              : 0;
          quietUntil = Date.now() + (wait || REFUSED_BACKOFF_MS);
          logger.info('shared.watch_ended', {
            kind: err instanceof ApiError ? err.kind : 'unknown',
          });
          if (view.id) store().finishTurn(conversationId, view.id, 'done');
          break;
        }
      }
    } finally {
      if (watcher === abort) watcher = null;
    }
    if (closed) return;
    if (view.id) await settleWatched();
    else void sync();
  };

  /* ------------------------------------------------------------ the line */

  const schedule = (): void => {
    if (closed || lineGone || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, QUEUE_POLL_MS);
  };

  const poll = async (): Promise<void> => {
    if (closed || lineGone || !visible()) return;
    const sid = sessionId();
    if (sid) {
      let line: Awaited<ReturnType<typeof api.getQueue>> | undefined;
      try {
        line = await api.getQueue(sid, auth);
      } catch {
        // A blip: ask again on the next tick.
        line = undefined;
      }
      if (closed) return;
      if (line === null) {
        lineGone = true;
        return;
      }
      if (line) {
        if (line.running && !watcher && !ownTurnHere() && Date.now() >= quietUntil) {
          void watch(sid);
        }
        // A turn this browser saw running has stopped, and it did not follow it (its own, or one
        // it was refused): the transcript has the exchange now.
        if (wasRunning && !line.running && !watcher) void sync();
        wasRunning = line.running;
      }
    }
    schedule();
  };

  /* ------------------------------------------------------------ the triggers */

  const onVisibility = (): void => {
    if (!visible()) {
      // A hidden tab holds no socket and asks nothing. The placeholder goes with the view: the
      // re-read on return brings the exchange, finished or not.
      stopWatching();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return;
    }
    void sync();
    void poll();
  };

  // The window coming back from another application does not change `visibilityState`, and is as
  // much "the conversation was focused" as a tab switch is. Throttled: focus can bounce.
  let lastFocusSync = 0;
  const onFocus = (): void => {
    if (Date.now() - lastFocusSync < FOCUS_SYNC_MIN_MS) return;
    lastFocusSync = Date.now();
    void sync();
  };

  // A turn this browser sent, in this conversation, has ended: other people's turns may have
  // landed around it — before it, while it waited in line.
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    if (
      previous.streaming?.conversationId === conversationId &&
      state.streaming?.conversationId !== conversationId
    ) {
      void sync();
    }
  });

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  void sync();
  void poll();

  return () => {
    closed = true;
    unsubscribe();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    stopWatching();
  };
}
