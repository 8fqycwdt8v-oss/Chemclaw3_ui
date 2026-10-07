/**
 * The turn orchestrator: everything between pressing Send and the answer settling. Lives outside
 * React (a sequence, not a render concern) and drives the store via `getState()`.
 */

import type { ExhibitRef } from '../../shared/exhibitConstants.ts';
import { draftArrived, draftToolFailed, draftsEnded, exhibitArrived } from './exhibitEvents.ts';
import { useExhibitPane } from './exhibitPane.ts';
import { api } from '../api/client.ts';
import type { TranscriptMessage } from '../api/client.ts';
import { config } from '../env.ts';
import { prefetchMarkdown } from '../components/LazyMarkdown.tsx';
import { ApiError } from '../api/errors.ts';
import { streamTurn, TURN_STALL_MS } from '../api/streamTurn.ts';
import type { AuthProvider } from '../auth/types.ts';
import type { Banner, ChatMessage, ComposerLock } from './types.ts';
import { useChatStore } from './chatStore.ts';
import { useEntityStore } from '../chem/entities.ts';
import { announceStatus, describeAnswer } from './announce.ts';
import { logger } from '../lib/logger.ts';
import { backoff } from '../lib/backoff.ts';
import { linePlace } from './turnActivity.ts';
import { endedError, endingOfTurn } from './transcript.ts';
import type { UnansweredEnding } from './transcript.ts';

/**
 * Told when Stop was pressed and the server never confirmed it: the turn may still be running and
 * holding the session, so the next message may get a 409.
 */
const STOP_UNCONFIRMED =
  'Stopped here, but the server did not confirm it. The turn may still be running, so the next ' +
  'message may be refused until it finishes.';

/**
 * A 403 on `POST /sessions/{id}/turn/stop`: in a shared conversation only the sender or owner may
 * stop a turn.
 */
const STOP_REFUSED =
  'Stopped watching here, but the service did not cancel the turn: in a shared conversation only ' +
  'the person who sent a message, or the conversation’s owner, can stop its turn.';

/** How long the announcement waits for the stop request before saying the ordinary thing. */
const STOP_CONFIRM_TIMEOUT_MS = 2_000;

/** What the bubble says about a message its own sender took back out of the line. */
const WITHDRAWN_BY_YOU =
  'You withdrew this message before it ran. Your question is back in the box.';

/**
 * How many times one turn reattaches after `stream_lagged`; past this the transcript read is
 * cheaper.
 */
const MAX_REATTACH = 2;

/** The stop a `pagehide` sends: `keepalive` to outlive the page, and the reason that makes it wait
 *  for a reload (see `abandon`). */
const UNLOAD_STOP = { keepalive: true, reason: 'unload' } as const;

/**
 * How long a reloaded page reads the transcript for a turn it could not follow live because another
 * turn (or an unnamed one) is running — so this turn is over and its answer is written or never
 * will be. Not used for a watch 404, which only speaks for one replica; that gets the full poll.
 */
const RELOAD_RECOVERY_MS = 20_000;

/** What the bubble says when a reload cost the answer for good — said, rather than left as an
 *  "interrupted" that implies it may still come. */
const RELOAD_LOST =
  'Interrupted by a page reload, and its answer could not be recovered from the server. Ask again to get one.';

/**
 * A Stop request's outcome, or `'pending'` after `STOP_CONFIRM_TIMEOUT_MS`, so an unresponsive
 * service cannot hang the turn.
 */
async function settledWithin<T>(pending: Promise<T>): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending,
    new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), STOP_CONFIRM_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

export interface SendOptions {
  conversationId: string;
  text: string;
  dryRun?: boolean;
  auth: AuthProvider;
  /** Artefacts handed to the agent with this message — the composer's `@artefact` chips. */
  exhibitRefs?: readonly ExhibitRef[];
}

/**
 * Sessions being minted, per conversation. Module scope (a Promise is not serialisable, and the
 * composer and send path must share it); survives StrictMode's double-invoke.
 */
const sessionsInFlight = new Map<string, Promise<string>>();

/**
 * The chosen agent profile for this conversation, read at every mint so a replacement session keeps
 * it.
 */
const profileFor = (conversationId: string): string | undefined =>
  useChatStore.getState().sessionProfiles[conversationId];

/**
 * Ensure the conversation has a live session, awaiting a warm already in flight so two creates
 * never race.
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
 * Mint the session while the user is still typing, so the first send is one round trip. Failures
 * are silent; `ensureSession` retries on send.
 */
export function warmSession(conversationId: string, auth: AuthProvider): void {
  if (!config.warmSessions) return;
  if (useChatStore.getState().conversations[conversationId]?.sessionId) return;
  void ensureSession(conversationId, auth).catch(() => undefined);
}

/**
 * Batch token events to one store write per animation frame. `flush` lets non-token events keep
 * ordering (tokens precede tool calls of the same update).
 */
export function createTokenBatcher(conversationId: string, messageId: string) {
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

  // Snapshot the newest held answer before this turn's writes, so detach recovery can tell this
  // turn's answer from one already there (`recoverDetachedAnswer`).
  const heldAnswer = newestHeldAnswer(store.conversations[conversationId]?.messages ?? []);

  const abort = new AbortController();

  /**
   * The bearer this turn's request carried, so `abandon()` can stop the turn without acquiring a
   * token during unload. Updated on every attempt.
   */
  let lastToken: string | null = null;

  /** When Send was pressed (client-side timing the service cannot see). */
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let answeredAt: number | null = null;
  /** The service's id for this turn, for the log lines below and for the store. */
  let correlationId = '';
  /** Frames this build could not use. One is forward compatibility; every one is a version skew. */
  const dropped = { malformed: 0, unknown: 0, types: new Set<string>() };
  /**
   * What the explicit Stop reported, awaited before telling the reader. A missing route (`false`)
   * or a 5xx must not be reported as "stopped".
   */
  let stopOutcome: Promise<'stopped' | 'unconfirmed' | 'refused' | 'withdrawn'> | null = null;

  /**
   * Whether Stop chose to withdraw a queued message; only then does settling wait on the service's
   * answer.
   */
  let withdrawing = false;

  /** This message's place in a shared conversation's line, read when Stop is pressed. */
  const placeInLine = (): { ticket: number; position: number } | null => {
    const message = useChatStore
      .getState()
      .conversations[conversationId]?.messages.find((m) => m.id === messageId);
    return message?.role === 'assistant' ? (message.queuePlace ?? null) : null;
  };

  /** Assigned inside the try, and read by the catch and finally below. */
  let messageId = '';

  /**
   * Whether the service accepted this turn (POST answered 2xx). Detach recovery is gated on this,
   * not on the error kind: a failure before the stream existed (e.g. a local storage write
   * throwing) is wrapped as `stream` but has nothing to recover.
   */
  let turnAccepted = false;

  const stop = (): void => {
    // Server first, then socket: a disconnect only detaches, so aborting alone would leave the turn
    // running.
    const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
    const place = placeInLine();
    if (sessionId && place) {
      withdrawing = true;
      // Still waiting: withdraw the ticket. A 404 is the message having started in the race, and
      // then it *is* this person's running turn, so the ordinary stop below is the right fallback.
      stopOutcome = api
        .withdrawQueued(sessionId, place.ticket, () => auth.getAccessToken())
        .then(async (withdrawn) => {
          if (withdrawn) return 'withdrawn' as const;
          return (await api.stopTurn(sessionId, () => auth.getAccessToken()))
            ? ('stopped' as const)
            : ('unconfirmed' as const);
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.kind === 'forbidden') return 'refused' as const;
          logger.error('turn.withdraw_failed', {
            sessionId,
            kind: err instanceof ApiError ? err.kind : 'unknown',
            status: err instanceof ApiError ? err.status : undefined,
          });
          return 'unconfirmed' as const;
        });
    } else if (sessionId) {
      stopOutcome = api
        .stopTurn(sessionId, () => auth.getAccessToken())
        .then((stopped) => {
          if (stopped) return 'stopped' as const;
          // `false`: nothing to stop (finished in the race, or the route is missing). Not a
          // confirmation.
          logger.warn('turn.stop_not_confirmed', { sessionId });
          return 'unconfirmed' as const;
        })
        .catch((err: unknown) => {
          // A member stopping someone else's turn is refused by rule, not a fault.
          if (err instanceof ApiError && err.kind === 'forbidden') return 'refused' as const;
          logger.error('turn.stop_failed', {
            sessionId,
            kind: err instanceof ApiError ? err.kind : 'unknown',
            status: err instanceof ApiError ? err.status : undefined,
          });
          return 'unconfirmed' as const;
        });
    }
    // The local half of Stop happens immediately, whatever the server says.
    abort.abort();
  };

  /**
   * Stop the turn as the document unloads. Differs from `stop()`:
   *
   * - `keepalive`, since an ordinary `fetch` from `pagehide` dies with the page.
   * - A token already in hand (`lastToken`): a silent MSAL refresh is impossible during unload, and
   *   a bare getter declines the 401 retry.
   * - Nothing local: no abort, banner or await.
   * - `reason: 'unload'`: a reload is also a `pagehide`, so the service defers the stop and drops
   *   it if `resumeInterruptedTurn` reattaches.
   */
  const abandon = (): void => {
    const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
    if (!sessionId) return;
    // A message still waiting in a shared line is withdrawn, not stopped (the running turn is
    // someone else's). A 404 means it already started, so fall back to stop. Best effort.
    const place = placeInLine();
    if (place) {
      void api
        .withdrawQueued(sessionId, place.ticket, () => Promise.resolve(lastToken), {
          keepalive: true,
        })
        .then((withdrawn) =>
          withdrawn
            ? undefined
            : api.stopTurn(sessionId, () => Promise.resolve(lastToken), UNLOAD_STOP),
        )
        .catch(() => {
          // Nothing to report to and nobody to report it: the page is unloading.
        });
      return;
    }
    void api
      .stopTurn(sessionId, () => Promise.resolve(lastToken), UNLOAD_STOP)
      .catch(() => {
        // Nothing to report to and nobody to report it: the page is unloading.
      });
  };

  const warnStopUnconfirmed = (): void => {
    showBanner({ kind: 'warn', text: STOP_UNCONFIRMED });
    announceStatus('Stopped here; the server did not confirm the turn was cancelled.');
  };

  /**
   * Say what Stop achieved, for both stop paths. The wait is bounded (`settledWithin`), since an
   * unresponsive server is one of the states being reported.
   */
  const announceStop = async (): Promise<void> => {
    if (!stopOutcome) {
      announceStatus('Stopped before the answer was complete.');
      return;
    }
    const pending = stopOutcome;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), STOP_CONFIRM_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);

    if (outcome === 'unconfirmed') {
      warnStopUnconfirmed();
      return;
    }
    if (outcome === 'withdrawn') {
      announceStatus('Withdrawn before it ran.');
      return;
    }
    if (outcome === 'refused') {
      showBanner({ kind: 'warn', text: STOP_REFUSED });
      announceStatus('Stopped here; the service refused to cancel a turn that is not yours.');
      return;
    }
    announceStatus('Stopped before the answer was complete.');
    // Still in flight: whatever it eventually says, say it then rather than blocking on it.
    if (outcome === 'pending') {
      void pending.then((late) => {
        if (late === 'unconfirmed') warnStopUnconfirmed();
        if (late === 'refused') showBanner({ kind: 'warn', text: STOP_REFUSED });
      });
    }
  };

  /** Whether this turn still owns the single global composer/banner slot. */
  const stillOurs = (): boolean => {
    const streaming = useChatStore.getState().streaming;
    return !streaming || streaming.messageId === messageId;
  };

  /**
   * Put the question and its `@artefact` chips back in the composer, only if both are empty
   * (anything typed since is newer).
   */
  const restoreDraft = (): void => {
    if (!useChatStore.getState().drafts[conversationId]) {
      useChatStore.getState().setDraft(conversationId, opts.text);
    }
    if (opts.exhibitRefs?.length) {
      useExhibitPane.getState().restoreRefs(conversationId, opts.exhibitRefs);
    }
  };

  /** Set the composer lock only while this turn still owns it. */
  const releaseComposer = (lock: ComposerLock): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setComposerLock(lock);
  };

  /**
   * Write the banner only while this turn still owns the slot, so a stale turn's recovery cannot
   * paint over a newer turn.
   */
  const showBanner = (banner: Banner | null): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setBanner(banner);
  };

  /**
   * Release the composer and clear the banner for a turn ending without one, only while this turn
   * owns them (a long recovery poll can wake after a newer turn started).
   */
  const releaseTurn = (): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setComposerLock(false);
    useChatStore.getState().setBanner(null);
  };

  /**
   * Settle this turn as ended by the service without an answer (e.g. `interrupted` when the process
   * died). The bubble offers Retry; the question is not also put back in the draft.
   */
  const settleUnanswered = (ending: UnansweredEnding): void => {
    batcher?.flush();
    const error = endedError(ending);
    if (!error) {
      useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
      releaseTurn();
      return;
    }
    useChatStore.getState().failTurn(conversationId, messageId, error);
    releaseComposer(false);
    // No reference in the banner: the turn's id is on the bubble's trace footer already.
    showBanner({ kind: 'warn', text: error.message });
  };

  /**
   * Whether the next attempt follows the running turn instead of sending: set after
   * `stream_lagged`.
   */
  let watching = false;
  let reattached = 0;
  /** The session a draft arrived on, so the turn's end can discard the ones that never landed. */
  let draftSession: string | null = null;

  const runOnce = async (sessionId: string): Promise<void> => {
    // Reset per attempt, except on a reattach (same accepted turn).
    if (!watching) turnAccepted = false;
    await streamTurn({
      sessionId,
      message: text,
      dryRun,
      exhibitRefs: opts.exhibitRefs ?? [],
      watch: watching,
      signal: abort.signal,
      getToken: async () => {
        lastToken = await auth.getAccessToken();
        return lastToken;
      },
      onAccepted() {
        turnAccepted = true;
      },
      onCorrelationId(id) {
        // Kept for the trace panel, the logger context and the banner.
        correlationId = id;
        logger.setContext({ correlationId: id });
        useChatStore.getState().setCorrelationId(conversationId, messageId, id);
      },
      onStall(stalled) {
        useChatStore.getState().setTurnStalled(conversationId, messageId, stalled);
        if (stalled) logger.warn('turn.stalled', { sessionId, afterMs: TURN_STALL_MS });
        else logger.info('turn.resumed', { sessionId });
      },
      onFrameDropped(drop) {
        if (drop.reason === 'malformed') dropped.malformed += 1;
        else dropped.unknown += 1;
        if (drop.type) dropped.types.add(drop.type);
      },
      onEvent(event) {
        // A draft document goes only to the draft store; it is not a trace row and does not flush
        // tokens.
        if (event.type === 'exhibit_draft') {
          draftSession = sessionId;
          draftArrived(sessionId, event);
          return;
        }
        if (event.type === 'token') {
          // The first sign the chain is moving, and the client half of a measurement the service
          // cannot take: it knows when it started generating, not when the bytes reached a browser.
          firstTokenAt ??= Date.now();
          // Only unattributed tokens are part of the answer; attributed ones are a subagent's
          // working notes.
          if (!event.agent) batcher?.push(event.text);
          return;
        }
        batcher?.flush();
        if (event.type === 'answer') answeredAt = Date.now();
        // The one event that says why the model routed around a broken tool. It is rendered in
        // the trace panel — one click away — and until now it reached nobody outside this tab.
        if (event.type === 'tool_failed') {
          logger.warn('tool.failed', {
            tool: event.tool,
            // A plan-gate refusal is the control working, not a fault, and the two must not read
            // the same in a log any more than they do on screen.
            reason: event.reason ?? 'error',
            ...(event.agent ? { agent: event.agent } : {}),
          });
        }
        // A queued turn is the one state a listener cannot infer from silence: nothing is
        // running yet, and without this the wait is indistinguishable from a hang.
        if (event.type === 'queued') {
          announceStatus(
            event.ticket === null
              ? 'Waiting for a free slot on the server.'
              : `${linePlace(event.position ?? 0)}.`,
          );
        }
        useChatStore.getState().applyEvent(conversationId, messageId, event);
        // Refetch the session's artefacts and, for one the agent just created, open the pane on it
        // — unless the reader closed the pane during this turn (`useExhibitPane.autoOpen`).
        if (event.type === 'exhibit') exhibitArrived(sessionId, event);
        // A refused `create_exhibit`/`revise_exhibit` takes its draft with it, so a retry's text is
        // never shown under the refused call's draft.
        if (event.type === 'tool_failed') draftToolFailed(sessionId, event);
        // Index the conversation's entities asynchronously (RDKit canonicalisation), keyed by this
        // conversation even if the reader switched away.
        void useEntityStore.getState().ingest(conversationId, messageId, event);
      },
    });
    batcher?.flush();
  };

  // One recovery attempt each: retrying a turn costs money and can hit the session lock.
  let recreatedSession = false;
  let reauthed = false;

  /** Created with the message id, so it cannot exist before the message it batches into does. */
  let batcher: ReturnType<typeof createTokenBatcher> | null = null;

  try {
    // The setup writes run inside the try, so a throw (e.g. quota) reaches the catch instead of
    // becoming an unhandled rejection.
    logger.setContext({ correlationId: '', sessionId: '' });
    store.appendUserMessage(conversationId, text);
    messageId = store.startAssistantMessage(conversationId);
    store.setStreaming({ conversationId, messageId, abort, stop, abandon });
    store.setComposerLock('turn_in_flight');
    store.setBanner(null);
    // A new question re-arms the artefact pane's auto-open.
    useExhibitPane.getState().turnStarted();
    batcher = createTokenBatcher(conversationId, messageId);

    for (;;) {
      const sessionId = await ensureSession(conversationId, auth);
      logger.setContext({ sessionId });
      try {
        await runOnce(sessionId);
        useChatStore.getState().finishTurn(conversationId, messageId, 'done');
        releaseComposer(false);
        // The reconnecting notice, once the view it promised has delivered the answer.
        if (watching) showBanner(null);
        // Announced, not focused: moving focus here would interrupt a listener mid-sentence.
        // The answer carries tabIndex={-1} so they can navigate to it when ready.
        announceStatus(describeAnswer(answerText(conversationId, messageId)));
        return;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;

        // The view fell behind and was cut off; the turn runs on. Reattach a bounded number of
        // times.
        if (err.kind === 'stream_lagged' && reattached < MAX_REATTACH) {
          reattached += 1;
          watching = true;
          batcher?.flush();
          showBanner({
            kind: 'info',
            text: 'This browser fell behind the answer; reconnecting to the turn, which is still running…',
          });
          announceStatus('Fell behind the answer; reconnecting.');
          continue;
        }
        // A reattach 404: the turn ended or runs on another replica. Recover from the transcript;
        // never replace the session.
        if (watching && err.kind === 'session_not_found') {
          throw new ApiError(
            'stream',
            'The turn was no longer streaming when this browser reconnected.',
            undefined,
            { correlationId: err.correlationId },
          );
        }

        // The session is dead (unknown, not ours, or evicted): mint a new one and replay once,
        // marking the context lost. Not in a conversation somebody else owns — there a 404 means
        // this person was removed.
        if (
          err.kind === 'session_not_found' &&
          useChatStore.getState().conversations[conversationId]?.membership
        ) {
          throw new ApiError(
            'session_not_found',
            'You no longer have access to this shared conversation — its owner may have removed you. Nothing was sent.',
            404,
          );
        }
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

    batcher?.flush();

    // Check the signal too: a Stop racing the end of the stream is a stop, not a drop.
    if (apiError.kind === 'aborted' || abort.signal.aborted) {
      // Whether a Stop withdrew the message is known only once the service answers.
      if (withdrawing && stopOutcome && (await settledWithin(stopOutcome)) === 'withdrawn') {
        useChatStore.getState().withdrawTurn(conversationId, messageId, WITHDRAWN_BY_YOU);
        restoreDraft();
        releaseComposer(false);
        announceStatus('Withdrawn before it ran.');
        return;
      }
      useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
      releaseComposer(false);
      await announceStop();
      return;
    }

    // The followed turn died with its process (410 `turn_interrupted`): nothing to poll for; offer
    // the question again.
    if (apiError.kind === 'turn_interrupted') {
      settleUnanswered('interrupted');
      return;
    }

    // Withdrawn from the line by someone else: not a failure. Say why and put the question back.
    if (apiError.kind === 'queue_cancelled') {
      useChatStore.getState().withdrawTurn(conversationId, messageId, apiError.message);
      restoreDraft();
      releaseComposer(false);
      showBanner({ kind: 'info', text: `${apiError.message} Your question is back in the box.` });
      logger.info('turn.queue_cancelled', {});
      return;
    }

    // A dropped stream is recoverable: the turn runs on and its answer lands in the transcript.
    //
    // - `network`: `fetch` rejected; whether the request was received is unknowable, so always
    //   poll.
    // - `stream`: only a real claim when a stream existed (`turnAccepted`).
    // - `stream_lagged`: the service says the turn runs on and reattaches are spent.
    const mayStillBeRunning =
      apiError.kind === 'network' ||
      (turnAccepted && (apiError.kind === 'stream' || apiError.kind === 'stream_lagged'));
    if (mayStillBeRunning) {
      const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
      if (sessionId) {
        showBanner({
          kind: 'info',
          text: 'Connection lost — the turn is still running on the server; recovering the answer…',
        });
        announceStatus('Connection lost; waiting for the server to finish the turn.');
        const recovered = await recoverDetachedAnswer(
          sessionId,
          opts.text,
          heldAnswer,
          correlationId,
          abort.signal,
          auth,
        );
        if (recovered !== null && typeof recovered !== 'string') {
          settleUnanswered(recovered.ended);
          return;
        }
        if (recovered !== null) {
          useChatStore.getState().applyEvent(conversationId, messageId, {
            type: 'answer',
            text: recovered,
            confidence: null,
            unsupported_claims: [],
            review_required: false,
            verified_by: null,
            // A recovered answer had no second-pass review.
            challenged: false,
            review_hold_id: null,
            checks_run: [], // a transcript rebuilt locally had no gate run on it, which is what empty means
          });
          useChatStore.getState().finishTurn(conversationId, messageId, 'done');
          releaseTurn();
          announceStatus(describeAnswer(recovered));
          return;
        }
        if (abort.signal.aborted) {
          useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
          releaseTurn();
          await announceStop();
          return;
        }
      }
    }

    // Failures are NOT announced here. `failTurn` raises a banner that already carries
    // `role="alert"`, and a second polite announcement of the same sentence reads it twice.

    logger.error('turn.failed', {
      kind: apiError.kind,
      ...(apiError.status ? { status: apiError.status } : {}),
      retryable: apiError.retryable,
    });

    useChatStore
      .getState()
      .failTurn(conversationId, messageId, { kind: apiError.kind, message: apiError.message });

    // The service's id for the failed turn, appended to the banner so it can be quoted to support.
    // The error's own id wins over the turn's.
    const reference = apiError.correlationId || correlationId;
    const text = reference ? `${apiError.message} (reference ${reference})` : apiError.message;

    // Put the question back in the composer (only into an empty draft).
    restoreDraft();

    // A rate limit: keep the composer open and count down the service's `Retry-After`. Never
    // auto-resend.
    if (apiError.kind === 'rate_limited') {
      releaseComposer(false);
      const seconds = Math.ceil(apiError.retryAfterSeconds);
      // No readable `Retry-After`: say "try again shortly" rather than "in 0 s".
      const banner: Banner =
        seconds > 0
          ? { kind: 'warn', text: `${text} Try again in ${seconds} s.`, retryAfterSeconds: seconds }
          : { kind: 'warn', text: `${text} Try again shortly.` };
      showBanner(banner);
      return;
    }

    // The shared line could not take this message: wait, rather than reset or retry. An uncoded 409
    // still lands on `turn_in_flight`.
    if (apiError.kind === 'queue_full' || apiError.kind === 'already_waiting') {
      releaseComposer(false);
      showBanner({
        kind: 'warn',
        // The service's `already_waiting` sentence already names its remedy (withdraw or wait);
        // its `queue_full` one says only that the line is full, and ends without a stop.
        text:
          apiError.kind === 'queue_full'
            ? `${apiError.message.replace(/[.\s]*$/, '')}. Send it again once the line moves.` +
              (reference ? ` (reference ${reference})` : '')
            : text,
      });
      return;
    }

    // A non-retryable `budget_exhausted` is terminal: keep the composer locked. A shed turn is
    // `at_capacity` and offers Retry; the `retryable` check handles older services.
    if (apiError.kind === 'budget_exhausted' && !apiError.retryable) {
      releaseComposer('budget_exhausted');
      showBanner({ kind: 'error', text });
      return;
    }

    releaseComposer(false);
    // In someone else's conversation, a fresh session would leave it; advise waiting instead.
    const member = Boolean(useChatStore.getState().conversations[conversationId]?.membership);
    showBanner({
      kind: 'error',
      text,
      action:
        apiError.kind === 'unauthorized'
          ? 'reauth'
          : member && apiError.kind === 'turn_in_flight'
            ? 'retry'
            : member && apiError.kind === 'session_not_found'
              ? undefined
              : apiError.kind === 'turn_in_flight' ||
                  apiError.kind === 'session_not_found' ||
                  apiError.kind === 'context_length'
                ? 'reset'
                : apiError.retryable
                  ? 'retry'
                  : undefined,
    });
  } finally {
    const streaming = useChatStore.getState().streaming;
    if (streaming?.messageId === messageId) useChatStore.getState().setStreaming(null);
    // However the turn ended — answered, stopped, failed, recovered — a draft whose `exhibit` frame
    // never came is not a document anybody has, and it leaves the pane now.
    if (draftSession) draftsEnded(draftSession);

    // Client-side turn timing (send, first byte, settled), to compare with the service's span.
    const settled = useChatStore
      .getState()
      .conversations[conversationId]?.messages.find((m) => m.id === messageId);
    logger.info('turn.timing', {
      outcome: settled?.role === 'assistant' ? settled.status : 'unstarted',
      firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      answerMs: answeredAt === null ? null : answeredAt - startedAt,
      totalMs: Date.now() - startedAt,
    });

    // Dropped frames are logged so "one bad frame" and "cannot read a newer service" are
    // distinguishable.
    if (dropped.malformed > 0 || dropped.unknown > 0) {
      logger.warn('stream.frames_dropped', {
        malformed: dropped.malformed,
        unknown: dropped.unknown,
        types: [...dropped.types],
      });
    }
  }
}

/** A turn detach recovery found ended rather than answered (failed, stopped or interrupted). */
export interface TurnEnded {
  ended: UnansweredEnding;
}

/**
 * Read a detached turn's answer back from the transcript, or `null` when it never appears, or `{
 * ended }` when its question says it never will. Bounded by the server's 600 s turn deadline (or
 * `budgetMs`) and abandoned on Stop.
 *
 * Matched by turn identity (`correlation_id`) when the service stamps rows. Otherwise by position:
 * the service writes a turn's exchange once, at the end, and runs one turn at a time, so this
 * turn's pair is the last one once it differs from `heldAnswer` (the newest answer already held). A
 * single anchor rather than a count, because local history may be trimmed.
 *
 * Polling backs off with jitter (`src/lib/backoff.ts`) so clients recovering from a backend restart
 * do not all poll in lockstep.
 */
export async function recoverDetachedAnswer(
  sessionId: string,
  question: string,
  heldAnswer: string | null,
  correlationId: string,
  signal: AbortSignal,
  auth: AuthProvider,
  budgetMs = 630_000,
): Promise<string | TurnEnded | null> {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  /**
   * The answer this turn's own must differ from. `null` means unknown, so the first read becomes
   * the anchor. Without turn ids, an answer that landed before the first read, or one identical to
   * the held answer, cannot be found (`tests/detachRecoveryLimits.test.ts`).
   */
  let held = heldAnswer;
  while (Date.now() < deadline && !signal.aborted) {
    attempt += 1;
    await backoff(attempt, signal);
    // Re-check after the wait: a long backoff can end past the deadline.
    if (signal.aborted || Date.now() >= deadline) return null;
    let transcript;
    try {
      transcript = await api.getMessages(sessionId, () => auth.getAccessToken());
    } catch (err) {
      // Keep trying through a flapping network, and log it.
      logger.debug('recovery.poll_failed', {
        kind: err instanceof ApiError ? err.kind : 'unknown',
      });
      continue;
    }
    const own = correlationId ? answerOfTurn(transcript, correlationId) : null;
    if (own !== null) return own;
    // A dead process writes no answer; its question is marked `interrupted`. Matched by identity
    // only.
    const ended = correlationId ? endingOfTurn(transcript, correlationId) : null;
    if (ended !== null) return { ended };
    const newest = newestExchange(transcript);
    if (held === null) {
      // Anchor on the first read when the client had none; an empty transcript anchors on `''`.
      held = newest?.answer ?? '';
      continue;
    }
    if (!newest || newest.question !== question) continue; // not this turn's exchange
    // Stamped with another turn's id, it is that turn's answer however its text reads — the retry
    // of a question whose aborted first attempt stored an answer is exactly this.
    if (correlationId && typeof newest.turn === 'string' && newest.turn !== correlationId) continue;
    if (newest.answer !== held) return newest.answer;
    // The last pair is still the one we already hold, so the service has not written this turn's.
  }
  return null;
}

/**
 * The answer the turn `correlationId` stored, or `null`. Newest first; empty answers are skipped.
 */
function answerOfTurn(transcript: TranscriptMessage[], correlationId: string): string | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i];
    if (entry?.role === 'assistant' && entry.correlation_id === correlationId && entry.text.trim())
      return entry.text;
  }
  return null;
}

/**
 * The newest question-and-answer pair in a transcript, or `null`. Searched from the end; empty
 * assistant entries and `system` entries are skipped. `turn` is the answer's `correlation_id` as
 * sent.
 */
function newestExchange(
  transcript: TranscriptMessage[],
): { question: string; answer: string; turn: string | null | undefined } | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const answer = transcript[i];
    if (!answer || answer.role !== 'assistant' || answer.text.trim() === '') continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const asked = transcript[j];
      if (asked?.role === 'user')
        return { question: asked.text, answer: answer.text, turn: answer.correlation_id };
    }
    return null; // an answer to nothing: not a pair, and not something to bind a turn to
  }
  return null;
}

/**
 * The newest answer this client holds, as detach recovery's anchor: `''` for a conversation's first
 * turn, `null` when the newest turn left no answer here (the service may hold one). Only
 * `finalText` counts; a partial stream is a prefix.
 */
function newestHeldAnswer(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const answer = message.finalText ?? '';
    return answer.trim() ? answer : null;
  }
  return '';
}

/**
 * Find the answer a reload interrupted. A disconnect detaches rather than cancels, so the turn
 * usually runs on. Scoped to the conversation on screen and its newest turn.
 *
 * First follow the turn live via `GET /sessions/{id}/turn/stream`, which also cancels the deferred
 * unload stop — but only if the running turn is this one. Then read the transcript: briefly
 * (`RELOAD_RECOVERY_MS`) when another turn is running, or the full poll after a 404 or a dropped
 * follow.
 */
export function resumeInterruptedTurn(
  conversationId: string,
  auth: AuthProvider,
): (() => void) | undefined {
  const conversation = useChatStore.getState().conversations[conversationId];
  const sessionId = conversation?.sessionId;
  if (!conversation || !sessionId) return undefined;

  const index = conversation.messages.findLastIndex(
    (m) => m.role === 'assistant' && m.interruptedByReload,
  );
  if (index < 1) return undefined;
  const message = conversation.messages[index];
  const question = conversation.messages[index - 1];
  if (!message || message.role !== 'assistant') return undefined;
  if (!question || question.role !== 'user') return undefined;
  // Already being followed — this effect re-runs when the reader switches back to a conversation
  // whose follow kept going, and a second reader of the same turn would be a second bubble writer.
  if (useChatStore.getState().streaming?.messageId === message.id) return undefined;

  // What the conversation held when the turn started, so a repeated question does not get the
  // earlier answer.
  const heldAnswer = newestHeldAnswer(conversation.messages.slice(0, index - 1));

  const abort = new AbortController();
  const messageId = message.id;
  const turnId = message.correlationId ?? '';
  // Follow live only when the turn is identifiable, is the newest, and the streaming slot is free.
  const newest = index === conversation.messages.length - 1;
  const followable = turnId !== '' && newest && useChatStore.getState().streaming === null;
  void (async () => {
    // Not followed: a newer turn in this conversation means this one is over (`'gone'`); otherwise
    // nothing is known about it, and the live path's whole poll is the honest wait.
    const followed = followable
      ? await followReloadedTurn(conversationId, sessionId, messageId, turnId, auth)
      : newest
        ? 'dropped'
        : 'gone';
    if (followed === 'settled') return;
    const recovered = await recoverDetachedAnswer(
      sessionId,
      question.text,
      heldAnswer,
      turnId,
      abort.signal,
      auth,
      followed === 'gone' ? RELOAD_RECOVERY_MS : undefined,
    );
    if (abort.signal.aborted) return;
    if (recovered !== null && typeof recovered !== 'string') {
      const store = useChatStore.getState();
      const current = store.conversations[conversationId]?.messages.find((m) => m.id === messageId);
      if (!current || current.role !== 'assistant' || !current.interruptedByReload) return;
      // Settled as the live path does, without a banner.
      const error = endedError(recovered.ended);
      if (error) store.failTurn(conversationId, messageId, error);
      else store.finishTurn(conversationId, messageId, 'aborted');
      return;
    }
    if (recovered === null) {
      // Recovery found nothing: clear the flag so later loads do not re-poll, only if no newer turn
      // took its place.
      useChatStore.getState().giveUpOnInterruptedTurn(conversationId, messageId, RELOAD_LOST);
      return;
    }
    const store = useChatStore.getState();
    // Still the same interrupted message? A turn started in the meantime owns this conversation,
    // and writing an old answer under it is the shape of defect `releaseTurn` above exists for.
    const current = store.conversations[conversationId]?.messages.find((m) => m.id === messageId);
    if (!current || current.role !== 'assistant' || !current.interruptedByReload) return;
    store.applyEvent(conversationId, messageId, {
      type: 'answer',
      text: recovered,
      confidence: null,
      unsupported_claims: [],
      review_required: false,
      verified_by: null,
      // A recovered answer had no second-pass review.
      challenged: false,
      review_hold_id: null,
      checks_run: [], // a transcript rebuilt locally had no gate run on it, which is what empty means
    });
    store.finishTurn(conversationId, messageId, 'done');
    announceStatus(describeAnswer(recovered));
  })();

  // The transcript poll stops with the conversation; a live follow runs on like any turn.
  return () => abort.abort();
}

/**
 * Follow a reload-interrupted turn through `GET /sessions/{id}/turn/stream`. `'settled'` when the
 * bubble is final; `'gone'` when the running turn is not this one; `'dropped'` when it may still
 * run elsewhere (404 or broken view). While following it holds the streaming slot and lock like any
 * turn. Tokens are not appended (the view replays nothing); the final `answer` is the whole text.
 */
async function followReloadedTurn(
  conversationId: string,
  sessionId: string,
  messageId: string,
  turnId: string,
  auth: AuthProvider,
): Promise<'settled' | 'gone' | 'dropped'> {
  const store = useChatStore.getState();
  const follow = new AbortController();
  let lastToken: string | null = null;
  let stopped = false;
  let someoneElses = false;
  const stop = (): void => {
    stopped = true;
    void api
      .stopTurn(sessionId, () => auth.getAccessToken())
      .catch((err: unknown) => {
        logger.warn('turn.stop_failed', { kind: err instanceof ApiError ? err.kind : 'unknown' });
      });
    follow.abort();
  };
  const abandon = (): void => {
    void api
      .stopTurn(sessionId, () => Promise.resolve(lastToken), UNLOAD_STOP)
      .catch(() => {
        // Nothing to report to and nobody to report it: the page is unloading.
      });
  };
  const ours = (): boolean => useChatStore.getState().streaming?.messageId === messageId;

  store.followInterruptedTurn(conversationId, messageId, true);
  store.setStreaming({ conversationId, messageId, abort: follow, stop, abandon });
  store.setComposerLock('turn_in_flight');
  try {
    await streamTurn({
      sessionId,
      message: '',
      watch: true,
      signal: follow.signal,
      getToken: async () => {
        lastToken = await auth.getAccessToken();
        return lastToken;
      },
      onWatching(running) {
        // Another participant's turn, or a service too old to say whose: not this bubble's to show.
        if (running === turnId) return;
        someoneElses = true;
        follow.abort();
      },
      onEvent(event) {
        // Nothing after an abort: a frame already buffered when the turn turned out to be somebody
        // else's is still theirs.
        if (event.type === 'token' || follow.signal.aborted) return;
        useChatStore.getState().applyEvent(conversationId, messageId, event);
        if (event.type === 'exhibit') exhibitArrived(sessionId, event);
        void useEntityStore.getState().ingest(conversationId, messageId, event);
      },
    });
    // An answer read out of a buffer after the abort is still somebody else's turn's.
    if (someoneElses) {
      useChatStore.getState().followInterruptedTurn(conversationId, messageId, false);
      return 'gone';
    }
    useChatStore.getState().finishTurn(conversationId, messageId, 'done');
    announceStatus(describeAnswer(answerText(conversationId, messageId)));
    return 'settled';
  } catch (err) {
    const kind = err instanceof ApiError ? err.kind : 'stream';
    if (stopped) {
      useChatStore.getState().finishTurn(conversationId, messageId, 'aborted');
      announceStatus('Stopped before the answer was complete.');
      return 'settled';
    }
    useChatStore.getState().followInterruptedTurn(conversationId, messageId, false);
    if (someoneElses) return 'gone';
    // No turn on the replica that answered: ended in the gap, or running on another one — whose
    // answer still lands in the transcript, so this gets the full poll (see `RELOAD_RECOVERY_MS`).
    if (kind === 'session_not_found') return 'dropped';
    // Aborted from outside — the conversation deleted, the store cleared: nobody is waiting.
    if (follow.signal.aborted) return 'settled';
    if (
      kind === 'network' ||
      kind === 'stream' ||
      kind === 'stream_lagged' ||
      kind === 'rate_limited' ||
      kind === 'unauthorized' ||
      kind === 'token_unavailable'
    )
      return 'dropped';
    // The turn itself ended in an error, which the stream said: that is its outcome.
    useChatStore.getState().failTurn(conversationId, messageId, {
      kind,
      message: err instanceof Error ? err.message : 'The turn failed.',
    });
    return 'settled';
  } finally {
    if (ours()) {
      useChatStore.getState().setStreaming(null);
      useChatStore.getState().setComposerLock(false);
    }
  }
}

/**
 * Stop the in-flight turn: `POST /sessions/{id}/turn/stop`, then abort the local stream (a
 * disconnect alone only detaches).
 */
export function stopStreaming(): void {
  const { streaming } = useChatStore.getState();
  streaming?.stop();
}

/**
 * Abandon the server session and start a fresh one for the same conversation — for a turn wedged on
 * another replica that `stopStreaming` cannot reach. Marks the conversation context-lost.
 */
export async function resetSession(conversationId: string, auth: AuthProvider): Promise<void> {
  const { session_id } = await api.createSession(auth, profileFor(conversationId));
  useChatStore.getState().setSessionId(conversationId, session_id, true);
  useChatStore.getState().setComposerLock(false);
  useChatStore.getState().setBanner(null);
}
