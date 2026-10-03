/**
 * The turn orchestrator: everything that happens between pressing Send and the answer settling.
 *
 * Lives outside React deliberately — it is a sequence, not a render concern, and it drives the
 * store directly via `getState()`.
 */

import type { ExhibitRef } from '../../shared/exhibitConstants.ts';
import { exhibitArrived } from './exhibitEvents.ts';
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

/**
 * What the reader is told when Stop was pressed and the server never confirmed it.
 *
 * The turn keeps running server-side — holding the session's turn lock and spending budget — so
 * the 409 their next message gets is a consequence of this, not a fault of their own. Saying so
 * here is what turns that 409 from "the app is broken" into something they were warned about.
 */
const STOP_UNCONFIRMED =
  'Stopped here, but the server did not confirm it. The turn may still be running, so the next ' +
  'message may be refused until it finishes.';

/**
 * What a 403 on `POST /sessions/{id}/turn/stop` means: in a shared conversation a turn is its
 * sender's to stop, or the owner's (Chemclaw3 #483), so a member cannot cancel somebody else's.
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
 * How many times one turn reattaches after its view was cut off for falling behind
 * (`stream_lagged`). Bounded for `recreatedSession`'s reason: a browser that keeps falling behind
 * will keep being cut off, and past the bound the transcript read below is the cheaper way to the
 * answer.
 */
const MAX_REATTACH = 2;

/** The stop a `pagehide` sends: `keepalive` to outlive the page, and the reason that makes it wait
 *  for a reload (see `abandon`). */
const UNLOAD_STOP = { keepalive: true, reason: 'unload' } as const;

/**
 * How long a reloaded page reads the transcript for a turn it could not follow live.
 *
 * Short on purpose, because by then the turn is over *here*: the watch route answered 404 (no turn
 * running), or named a turn that is not this one (another participant's started since). A turn
 * writes its transcript before it stops counting as running, so its answer is either there now or
 * was never written — a service that stopped the turn on unload is the second case, and waiting the
 * live path's 630 s for it was defect Chemclaw3_ui#131. A few reads cover a write racing the 404.
 */
const RELOAD_RECOVERY_MS = 20_000;

/** What the bubble says when a reload cost the answer for good — said, rather than left as an
 *  "interrupted" that implies it may still come. */
const RELOAD_LOST =
  'Interrupted by a page reload, and its answer could not be recovered from the server. Ask again to get one.';

/**
 * What a Stop's request settled as, or `'pending'` once `STOP_CONFIRM_TIMEOUT_MS` has passed —
 * the bound `announceStop` keeps, for its reason: the service not answering is one of the states
 * being reported, and an unbounded wait would hang the turn on it.
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

  // Snapshotted before `appendUserMessage` — which now runs inside the `try` below — adds this
  // turn's own message, so detach recovery can tell an answer written for this turn from one that
  // was already in the transcript when it started (see `recoverDetachedAnswer`). It stays out here
  // because it is a read: it is the store *writes* that had to move inside the `try`, and this one
  // must happen before them either way.
  const heldAnswer = newestHeldAnswer(store.conversations[conversationId]?.messages ?? []);

  const abort = new AbortController();

  /**
   * The bearer this turn's request actually carried.
   *
   * Kept so `abandon()` below can send the stop without awaiting a token acquisition that may need
   * the network — see its docstring. Refreshed on every attempt, so a replay after a 401 leaves
   * the newer token here rather than the one that was rejected.
   */
  let lastToken: string | null = null;

  /** When Send was pressed. The client half of a turn's timing, which the service cannot see. */
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let answeredAt: number | null = null;
  /** The service's id for this turn, for the log lines below and for the store. */
  let correlationId = '';
  /** Frames this build could not use. One is forward compatibility; every one is a version skew. */
  const dropped = { malformed: 0, unknown: 0, types: new Set<string>() };
  /**
   * What the explicit Stop reported, awaited before the reader is told what happened.
   *
   * `api.stopTurn` resolves `false` when the backend has no such route and THROWS on a 500/503,
   * and both outcomes used to be discarded — after which the user was reliably told "Stopped
   * before the answer was complete" while the turn kept running server-side, kept spending budget
   * and kept the session's turn lock, so their next message came back 409 and was rendered as a
   * "reset the conversation" banner: an app bug to a chemist and nothing at all to an operator.
   */
  let stopOutcome: Promise<'stopped' | 'unconfirmed' | 'refused' | 'withdrawn'> | null = null;

  /**
   * Where this message stands in a shared conversation's line, when it is waiting in one.
   *
   * Read at the moment Stop is pressed, because it decides what Stop *is*: while the message waits,
   * the running turn is somebody else's, and `POST /turn/stop` would either be refused (a member)
   * or cancel a colleague's work (the owner). Withdrawing the ticket is the only stop that reaches
   * this message and nothing else.
   */
  /** Whether Stop chose to withdraw. Only then does the stop's ending wait on the service's answer
   *  before settling the bubble — an ordinary Stop settles at once, as it always has. */
  let withdrawing = false;

  const placeInLine = (): { ticket: number; position: number } | null => {
    const message = useChatStore
      .getState()
      .conversations[conversationId]?.messages.find((m) => m.id === messageId);
    return message?.role === 'assistant' ? (message.queuePlace ?? null) : null;
  };

  /** Assigned inside the try, and read by the catch and finally below. */
  let messageId = '';

  /**
   * Whether the service took this turn — the POST was answered `2xx`.
   *
   * The fact detach recovery is gated on, rather than the error's kind, and it composes with
   * `token_unavailable` rather than duplicating it. That kind (`src/api/errors.ts`) names the one
   * pre-flight failure that has a classification of its own: the auth provider refusing to produce
   * a token. What it cannot name is everything else that fails before the stream exists, because
   * those failures have no kind — the catch below wraps any non-`ApiError` as `stream`, which is
   * documented as "plausibly recoverable by polling the session transcript", and it is not. The
   * five setup writes at the top of the `try` are the live example: `chatStore` records a
   * `QuotaExceededError` from `appendUserMessage`, and with a session already minted that threw a
   * chemist into the banner "Connection lost — the turn is still running on the server; recovering
   * the answer…" with the composer locked, for a turn nothing had sent. Measured on the merged
   * tree with this flag ignored: **630 s** and **210** poll attempts; with it, one tick.
   */
  let turnAccepted = false;

  const stop = (): void => {
    // Server first, then socket: the backend detaches on disconnect
    // (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop), so aborting the fetch alone would
    // leave the turn running — and the session 409-busy — for its whole remaining duration.
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
          // `false` is "there was nothing to stop": the turn finished in the race, or this backend
          // predates the route. Not an error, but not a confirmation either.
          logger.warn('turn.stop_not_confirmed', { sessionId });
          return 'unconfirmed' as const;
        })
        .catch((err: unknown) => {
          // In a shared conversation a turn is its sender's to stop, or the owner's (Chemclaw3
          // #483): a member pressing Stop on a turn that is not theirs is refused, and that is a
          // rule answering rather than a fault — said as such below, not as "unconfirmed".
          if (err instanceof ApiError && err.kind === 'forbidden') return 'refused' as const;
          logger.error('turn.stop_failed', {
            sessionId,
            kind: err instanceof ApiError ? err.kind : 'unknown',
            status: err instanceof ApiError ? err.status : undefined,
          });
          return 'unconfirmed' as const;
        });
    }
    // Unconditional and immediate, whatever the server ends up saying: the local half of Stop —
    // stop rendering, release the composer — is right either way, and waiting on a request that
    // may be the thing that is broken would freeze the one control the user reached for.
    abort.abort();
  };

  /**
   * Stop the turn on the way out of the document — Stop's unload-time half.
   *
   * A closed tab, a reload and a navigation away all *detach* rather than cancel
   * (`D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`), so the turn kept running to completion:
   * one of the front door's `service_max_concurrent_turns` (8 per process), a database connection
   * and an LLM bill, for up to the 600 s wall clock, on work nobody will read. Two abandoned turns
   * per pod is a quarter of its admission capacity. It also compounds — the chemist who reloaded
   * because it felt stuck comes back, re-asks, gets a 409 from the turn that is still running, and
   * reaches for `resetSession`, which mints a second session while the first turn keeps burning.
   *
   * Three things make this different from `stop()` above rather than a call to it:
   *
   *  - **`keepalive`**, because an ordinary `fetch` started from `pagehide` dies with the page.
   *    Same trick, and the same reason, as the log sink's final batch (`src/lib/logger.ts`).
   *  - **A token already in hand.** `auth.getAccessToken()` may need a silent MSAL refresh, and a
   *    refresh is an iframe to `login.microsoftonline.com` — impossible during unload. `lastToken`
   *    is the bearer this turn's own POST went out with, which is by construction at most one turn
   *    old, and passing it as a bare getter also declines the 401 retry: there is nobody left to
   *    recover for.
   *  - **Nothing local.** No abort, no banner, no announcement, no awaiting the outcome. This
   *    document is going away; the only thing worth doing is getting the request onto the wire.
   *  - **`reason: 'unload'`**, because a reload is a `pagehide` too and the browser cannot say
   *    which this is. Sent plain, the stop killed the turn a reloaded page then waited 630 s for
   *    (Chemclaw3_ui#131). With the reason the service holds the stop for a grace window and drops
   *    it when `resumeInterruptedTurn` reattaches; a chemist who really left still frees the
   *    turn's capacity, one window later.
   */
  const abandon = (): void => {
    const sessionId = useChatStore.getState().conversations[conversationId]?.sessionId;
    if (!sessionId) return;
    // A message still waiting in a shared conversation's line is withdrawn, not stopped: the turn
    // running there is somebody else's, and an owner's unload must not cancel it. A detach does
    // not lose a waiting message its place, so leaving it would run a question nobody is reading.
    // A 404 there means the message left the line first — usually because it started, between
    // the service taking the turn and this client hearing about it — so the fallback is the same
    // stop the Composer's Withdraw falls back to. Best effort: the second request leaves after
    // the first one answers, and the page may be gone by then.
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
   * Say what Stop actually achieved.
   *
   * Both stop paths come through here — the one that ends the stream and the one that abandons
   * recovery — so the wording cannot drift between them.
   *
   * The wait is BOUNDED, and that is not a detail: `api.stopTurn` has no timeout of its own, and
   * "the server stopped answering" is one of the states this is trying to report, so an unbounded
   * await would hang the turn's own promise on exactly the failure it exists to describe — leaving
   * `streaming` occupied and the Stop control on screen for ever. Past the bound the reader is told
   * the ordinary thing and the answer, if it ever comes, corrects it.
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

  /**
   * Set the composer lock, but only while this turn is still the one the app is waiting on.
   *
   * The lock is a single global slot, and so is `streaming`. An older turn finishing must not
   * unlock a composer that a newer one owns — `finishTurn` and `setStreaming` are already keyed
   * on `messageId` for exactly that reason, and this was the one write that was not.
   */
  /** Whether this turn still owns the single global composer/banner slot. */
  const stillOurs = (): boolean => {
    const streaming = useChatStore.getState().streaming;
    return !streaming || streaming.messageId === messageId;
  };

  /**
   * The chemist's question, back where they typed it — only into an empty draft, because whatever
   * they have typed since is newer than this.
   *
   * **And the artefacts it carried.** `Composer` clears the `@artefact` chips at submit, as it
   * clears the text, so a refused turn that put only the text back returned a question about "this
   * table" with the table no longer attached — sent again, the agent would be asked about an
   * artefact it was never shown. Same rule as the text: only into an empty set of chips.
   */
  const restoreDraft = (): void => {
    if (!useChatStore.getState().drafts[conversationId]) {
      useChatStore.getState().setDraft(conversationId, opts.text);
    }
    if (opts.exhibitRefs?.length) {
      useExhibitPane.getState().restoreRefs(conversationId, opts.exhibitRefs);
    }
  };

  const releaseComposer = (lock: ComposerLock): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setComposerLock(lock);
  };

  /**
   * Write the banner, but only while this turn still owns it — the same rule as the lock.
   *
   * **The guard was put on the lock and on `releaseTurn`, and every other banner write in this
   * function went straight through.** `releaseTurn` below documents the scenario in full; running
   * it one statement further is the defect: its guarded `setBanner(null)` is immediately followed
   * by `await announceStop()`, which paints "Stopped here, but the server did not confirm it" with
   * no ownership check at all. Measured on turn A abandoned → conversation deleted → turn B sent →
   * A's poll wakes: B's composer stayed correctly locked and B's screen got A's warning.
   *
   * So the banner goes through one guarded door rather than six unguarded ones, because the next
   * failure exit somebody adds here will otherwise be the seventh.
   */
  const showBanner = (banner: Banner | null): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setBanner(banner);
  };

  /**
   * Hand back the composer *and* the banner, for a turn that has ended without one to show.
   *
   * The banner needs the same guard as the lock and did not have it. Both detach-recovery exits
   * below wrote `setComposerLock(false)` and `setBanner(null)` straight through — on the
   * longest-lived path in this file, since `recoverDetachedAnswer` polls for 630 s. Reachable
   * without contrivance: turn A drops and its recovery starts; the chemist deletes A's
   * conversation, which clears `streaming` and the lock; they send turn B; up to three seconds
   * later A's poll wakes, sees the abort, and unlocks **B's** composer and clears **B's** banner
   * while B is still streaming. The `finishTurn`/`applyEvent` calls beside them were always keyed
   * on `messageId`; these two were the pair that was not, which is the same finding
   * `releaseComposer`'s own docstring records about the lock alone.
   */
  const releaseTurn = (): void => {
    if (!stillOurs()) return;
    useChatStore.getState().setComposerLock(false);
    useChatStore.getState().setBanner(null);
  };

  /**
   * Whether the next attempt follows the running turn rather than sending the message: set after
   * the service cut this browser's view off (`stream_lagged`), and the turn it was a view of runs on.
   */
  let watching = false;
  let reattached = 0;

  const runOnce = async (sessionId: string): Promise<void> => {
    // Per attempt: a replay after a 401 or a `session_not_found` starts a new turn, and what the
    // previous attempt got as far as says nothing about this one. A reattach is not a new turn —
    // the one the service already accepted is still running — so it keeps the flag.
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
        // Kept in three places, each for a different reader: the store, so the trace panel can
        // show a reference on a turn that SUCCEEDED; the logger's context, so every subsequent
        // entry from this browser carries it; and here, so the banner below can quote it even
        // when the failure carried none of its own.
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
        if (event.type === 'token') {
          // The first sign the chain is moving, and the client half of a measurement the service
          // cannot take: it knows when it started generating, not when the bytes reached a browser.
          firstTokenAt ??= Date.now();
          // Unattributed tokens only, which is the backend's own rule for this stream: a token
          // carrying an `agent` is a subagent's working prose, and concatenating it splices
          // another agent's notes into the answer a chemist reads. Invisible most of the time
          // because the root-only `answer` event replaces the render — and not invisible at all
          // when the turn is stopped, times out, or hits the loop cap, where the streamed text is
          // what is kept and persisted.
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
        // The conversation's subject index. Fire-and-forget: ingestion canonicalises through
        // RDKit, so it is asynchronous, and the transcript must not wait on a WASM call to render
        // the event it has already applied. Named with this conversation's id rather than the
        // store's idea of the active one — the rail and the transcript have to describe the same
        // conversation even when the reader has switched away mid-turn.
        void useEntityStore.getState().ingest(conversationId, messageId, event);
      },
    });
    batcher?.flush();
  };

  // Guards a single recovery attempt each. Booleans, not a loop: retrying a turn costs real
  // money and can collide with the backend's per-session lock, so recovery must be bounded and
  // obviously so.
  let recreatedSession = false;
  let reauthed = false;

  /** Created with the message id, so it cannot exist before the message it batches into does. */
  let batcher: ReturnType<typeof createTokenBatcher> | null = null;

  try {
    // The turn's five setup writes, INSIDE the try.
    //
    // They ran before it, and `Composer` floats this promise with `void` — no handler, and (until
    // `main.tsx` grew one) no global listener either. So a throw in any of them, which is a real
    // class rather than a hypothetical one (`chatStore` records a `QuotaExceededError` that
    // produced "no bubble, no answer, no banner, no lock — Send did nothing, for ever"), was an
    // unhandled rejection. The storage layer swallowing that one exception fixed the instance;
    // this closes the shape.
    logger.setContext({ correlationId: '', sessionId: '' });
    store.appendUserMessage(conversationId, text);
    messageId = store.startAssistantMessage(conversationId);
    store.setStreaming({ conversationId, messageId, abort, stop, abandon });
    store.setComposerLock('turn_in_flight');
    store.setBanner(null);
    // A new question re-arms the artefact pane's auto-open: a close during the *previous* answer
    // was about that answer.
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

        // The service cut this browser's view of the turn off for falling behind, and the turn
        // runs on (Chemclaw3 #499). Reattach to it rather than read that as the turn failing — a
        // bounded number of times, after which the transcript read below takes over.
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
        // A reattach answered 404: no turn is running here any more. It ended in the gap, or it
        // runs on another replica — both are a turn whose answer lands in the transcript, so this
        // is a dropped stream to recover, never a dead session to replace.
        if (watching && err.kind === 'session_not_found') {
          throw new ApiError(
            'stream',
            'The turn was no longer streaming when this browser reconnected.',
            undefined,
            { correlationId: err.correlationId },
          );
        }

        // The session handle is dead: unknown, someone else's, or evicted from the backend's
        // live-session LRU. Mint a new one and replay the message exactly once. The transcript
        // belongs to the local conversation, so nothing visible is lost — but the AGENT has
        // lost its context, and we mark that rather than pretending continuity.
        //
        // **Not in a conversation somebody else owns** (Chemclaw3 #483). There a 404 means the
        // owner removed this person, and minting a replacement would quietly move their question
        // into a private session of their own — answered with none of the shared context, under a
        // title that still reads as the shared conversation. Say what happened instead.
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

    // The signal, not only the error kind: a Stop pressed just as the server ends the stream
    // surfaces as a `stream` error with the abort already set, and that is a stop, not a drop —
    // recovering it would poll for an answer the user just cancelled.
    if (apiError.kind === 'aborted' || abort.signal.aborted) {
      // A Stop on a message still waiting in line withdrew it, and whether it did is only known
      // once the service answers: a 404 there means it had started, and was stopped instead.
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

    // Withdrawn from a shared conversation's line by somebody else — the owner, the service on
    // the sender's removal, the session's deletion (Chemclaw3 #499). Nothing ran and nothing was
    // spent, so this is not painted as a failed turn: the bubble says why, the question goes back
    // in the box, and the banner is information rather than an error.
    if (apiError.kind === 'queue_cancelled') {
      useChatStore.getState().withdrawTurn(conversationId, messageId, apiError.message);
      restoreDraft();
      releaseComposer(false);
      showBanner({ kind: 'info', text: `${apiError.message} Your question is back in the box.` });
      logger.info('turn.queue_cancelled', {});
      return;
    }

    // An accidental drop is not a stop: the backend detaches and the turn runs to completion
    // server-side (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop), so a broken stream is a
    // *recoverable* state — the answer will land in the session transcript. Poll it back rather
    // than surfacing a dead-end banner for work that is still happening.
    //
    // The two kinds are gated differently because they are different claims, and reading them as
    // one is what sent turns that never existed into a ten-minute poll:
    //
    //  - `network` is `fetch` itself rejecting, which happens as readily *after* the request bytes
    //    are on the wire as before. Whether the service got it is genuinely unknowable from here,
    //    and a dropped Wi-Fi mid-POST is the case detach recovery was built for, so it keeps its
    //    poll unconditionally.
    //  - `stream` is only ever a real claim about a running turn when a stream actually existed.
    //    It is also the kind the catch above stamps on any non-`ApiError`, including one thrown by
    //    this function's own setup writes — for which there is nothing to recover and nothing to
    //    wait for. `turnAccepted` is what tells those apart; see its docstring.
    //  - `stream_lagged` is the service saying so outright: only this view ended, and the
    //    reattaches above are spent.
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
        if (recovered !== null) {
          useChatStore.getState().applyEvent(conversationId, messageId, {
            type: 'answer',
            text: recovered,
            confidence: null,
            unsupported_claims: [],
            review_required: false,
            verified_by: null,
            // A recovered answer was never reviewed by a second pass — this is the transcript
            // being rebuilt, not a fresh turn — so the pair is the service's "nothing happened".
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

    // The service's own id for the failed turn, when it sent one. Appended to the banner text
    // rather than given a field of its own: it is the one thing a support conversation needs and
    // nothing in the UI can act on it, so it belongs where it can be selected and copied.
    // `correlationId` is the turn's, read back from the response header or a frame that carried
    // one; the error's own wins when it has one. Before this, every HTTP-level failure — 401, 409,
    // 422, 429, 503, a network drop, a mid-stream disconnect — printed no reference at all, so the
    // one string a support conversation needs existed on the server and nowhere a chemist could
    // see it.
    const reference = apiError.correlationId || correlationId;
    const text = reference ? `${apiError.message} (reference ${reference})` : apiError.message;

    // The chemist's question, back where they typed it. `Composer` clears the draft at submit,
    // so before this a failed turn also destroyed the message — the "Retry" on the banner is a
    // rehydrate of the transcript and has never re-sent anything. Only into an empty draft:
    // whatever they have typed since is newer than this.
    restoreDraft();

    // A rate limit is a pause with a number on it, and the number is the service's own: the
    // per-principal limiter computes how long until one token refills and sends it as
    // `Retry-After` precisely so a client waits the right amount. So the composer stays open, the
    // question is already back in the draft above, and the banner counts the wait down.
    //
    // Deliberately not an automatic re-send. Nothing in this app has ever re-posted a turn on the
    // user's behalf — the banner's Retry re-reads the transcript — and a client that resends on a
    // timer turns one refused request into a queue of them against the very budget it is waiting
    // on. The countdown says when; the human still presses Send.
    if (apiError.kind === 'rate_limited') {
      releaseComposer(false);
      const seconds = Math.ceil(apiError.retryAfterSeconds);
      // A limiter that sent a `Retry-After` this app could not read is still a limiter, and it
      // arrives here with no number. Saying "try again in 0 s" would be a countdown to now, so
      // the sentence loses the figure rather than gaining a wrong one.
      const banner: Banner =
        seconds > 0
          ? { kind: 'warn', text: `${text} Try again in ${seconds} s.`, retryAfterSeconds: seconds }
          : { kind: 'warn', text: `${text} Try again shortly.` };
      showBanner(banner);
      return;
    }

    // The line could not take this message (Chemclaw3 #503's codes). Neither remedy the 409 used to
    // get applies: "start a fresh session" leaves a conversation whose turn is somebody's real
    // work, and Retry re-reads a transcript this message never entered. The question is already
    // back in the draft; the banner says what to wait for. A service that sends these refusals
    // as a sentence without a code still lands on `turn_in_flight` below, as before.
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

    // A budget that is genuinely gone is terminal — it does not replenish because somebody
    // pressed a button — so leave the composer locked and say so. A turn the service *shed* is a
    // different code now (`at_capacity`, kind `capacity`) and falls through to the ordinary
    // branch below, which offers Retry; the `retryable` guard stays because an older deployment
    // still sends a shed as a retryable `budget_exhausted`, and locking the composer on it would
    // be the same defect one release earlier.
    if (apiError.kind === 'budget_exhausted' && !apiError.retryable) {
      releaseComposer('budget_exhausted');
      showBanner({ kind: 'error', text });
      return;
    }

    releaseComposer(false);
    // In a conversation somebody else owns, "start a fresh session" would leave it: the new session
    // is this person's own and nobody else is in it. A turn in flight there is usually another
    // member's, which ends by itself — so the remedy is to wait and retry, not to reset.
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

    // The client half of the turn's timing. It composes with the service's own turn span, which
    // cannot see any of these three: when the chemist pressed Send, when the first byte reached
    // this browser, and when the answer settled. Together they are what answers "is it the
    // frontend or the backend?" — a question nothing in this app could contribute to before.
    const settled = useChatStore
      .getState()
      .conversations[conversationId]?.messages.find((m) => m.id === messageId);
    logger.info('turn.timing', {
      outcome: settled?.role === 'assistant' ? settled.status : 'unstarted',
      firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      answerMs: answeredAt === null ? null : answeredAt - startedAt,
      totalMs: Date.now() - startedAt,
    });

    // Dropping a malformed or unknown frame is right and is pinned by tests. Doing it silently is
    // what made "one bad frame" and "this build cannot read anything a newer service sends" the
    // same observation.
    if (dropped.malformed > 0 || dropped.unknown > 0) {
      logger.warn('stream.frames_dropped', {
        malformed: dropped.malformed,
        unknown: dropped.unknown,
        types: [...dropped.types],
      });
    }
  }
}

/**
 * Read a detached turn's answer back from the transcript, or `null` when it never appears.
 *
 * The detached turn writes its exchange to `session_messages` at its true end, so the recovery
 * signal is the transcript's newest question-and-answer pair turning into this turn's. Bounded — the server's turn deadline is 600 s, and polling much past it would wait
 * on a turn that can no longer exist — and abandoned early if the user presses Stop, whose
 * `stop()` both cancels the server turn and flips this signal.
 *
 * **By identity first.** A service that stamps each transcript row with the turn that stored it
 * (`TranscriptMessage.correlation_id`) lets this find the turn's answer by the `correlationId` its
 * own response header carried, wherever it sits and whatever its text — which is the only way to
 * see an answer that landed before the first read with nothing held, or one byte-identical to the
 * held answer. Everything below is the fallback for when that cannot be done: an older service
 * that sends no id, a row stored without one, or a turn whose header never arrived (`''`).
 *
 * Without a turn id, the question text is all there is to match on — but a chemist
 * retrying an identical failed question (the banner's own "Retry" refills the same text) makes
 * that text non-unique, and an answer bound to the wrong copy is this app's worst output: a
 * three-week-old "no alerts fired" presented as this turn's answer to a genotoxicity question.
 *
 * Two facts decide which copy is this turn's, and both are read off the transcript this loop
 * already fetches. The service writes a turn's exchange **once, when the answer exists**
 * (`api/runner._record_transcript`), and a session runs one turn at a time — so this turn's
 * question and answer are the *last* pair in the transcript, or the service has not written it yet
 * and nothing of this turn is there at all. `heldAnswer` is what tells those two apart: the newest
 * answer this client already holds, so an unchanged last pair is the one that was already there
 * and a changed one is this turn's.
 *
 * **It is one scalar rather than a count, and that is the whole point.** This used to skip
 * `priorOccurrences` matches while walking the transcript — a count taken over
 * `conversation.messages`, which is not the population being walked: `partialize` persists only the
 * newest `MAX_PERSISTED_MESSAGES` and `shedOldest` halves a conversation on a quota refusal, which
 * is precisely the reload path `resumeInterruptedTurn` exists for. Driven: a transcript holding the
 * question twice against a local list the trim had shortened undercounted by one, stopped at the
 * older copy, and bound *that* turn's answer into this turn's bubble. A single answer read from the
 * message next to this turn cannot come apart that way — every path that shortens a conversation
 * keeps its *tail*, so the turn's own neighbour survives whatever the head loses.
 *
 * **The cadence is backed off with jitter, and the reason is the trigger.** This loop starts on
 * any dropped turn stream, and the thing that drops every turn stream at once is a backend rolling
 * restart — so at the 200-user target every client with a turn in flight entered it in the same
 * second and, at the fixed 3 s interval this used to run at, produced 210 unpaginated
 * `GET /sessions/{id}/messages` each: ~16.7 requests a second of transcript reads, every one of
 * them `resolve_session`-gated and therefore a full session *rehydrate* on the pod that had just
 * restarted, for ten and a half minutes. The condition that starts this loop is backend distress
 * and what it did was add load to a distressed backend. `src/lib/backoff.ts` is the same helper
 * the job-stream client already used, and the same jitter is what desynchronises the herd; the
 * failure path uses it too, which is the other half — a poll that failed used to `continue`
 * straight into the next one at full speed.
 *
 * The wall clock stays the only bound: ~30 attempts fit inside it now instead of 210, and the
 * first is still within a few seconds, which is where the median detached answer lands. An attempt
 * cap on top would be a second number saying the same thing. `budgetMs` shortens it for a caller
 * that already knows the turn is over (`RELOAD_RECOVERY_MS`).
 */
export async function recoverDetachedAnswer(
  sessionId: string,
  question: string,
  heldAnswer: string | null,
  correlationId: string,
  signal: AbortSignal,
  auth: AuthProvider,
  budgetMs = 630_000,
): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  /**
   * The answer this turn's own must differ from.
   *
   * `null` on the way in means this client cannot say what the session's newest answer is — the
   * previous turn left none here, and the service may hold one it never saw — so the first read
   * becomes the anchor and only an answer that appears *after* recovery started can be this turn's.
   *
   * **Two answers the text anchor cannot find**, and `tests/detachRecoveryLimits.test.ts` pins
   * both: this turn's own answer when it landed before the first read (it becomes the anchor), and
   * one byte-identical to the held answer. Turn identity finds both, so they are misses only
   * against a service that sends no `correlation_id`. Accepting a matching question when nothing is
   * held is *not* the fix for that service: a retry repeats its question, and that would bind the
   * aborted turn's stored answer into this one.
   */
  let held = heldAnswer;
  while (Date.now() < deadline && !signal.aborted) {
    attempt += 1;
    await backoff(attempt, signal);
    // Re-checked AFTER the wait, not only before it. At a fixed 3 s interval the two were the same
    // question; a wait that can be 30 s long can start inside the deadline and end well outside it,
    // and a poll issued then is asking about a turn the service's own 600 s wall clock has ended.
    if (signal.aborted || Date.now() >= deadline) return null;
    let transcript;
    try {
      transcript = await api.getMessages(sessionId, () => auth.getAccessToken());
    } catch (err) {
      // The network that dropped the stream may still be flapping — keep trying, and leave a
      // record. Recovery giving up after ten minutes of this used to look, from outside the
      // browser, exactly like recovery never having been attempted.
      logger.debug('recovery.poll_failed', {
        kind: err instanceof ApiError ? err.kind : 'unknown',
      });
      continue;
    }
    const own = correlationId ? answerOfTurn(transcript, correlationId) : null;
    if (own !== null) return own;
    const newest = newestExchange(transcript);
    if (held === null) {
      // The anchor this client could not supply, taken from the same population the search runs on.
      // An empty transcript anchors on `''`, which is the honest reading: nothing was there.
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
 * The answer the turn `correlationId` stored, or `null` when the transcript holds none stamped so.
 *
 * Newest first, and an empty one is skipped for the same reason `newestExchange` skips it: a turn
 * whose record is its work alone is not an answer anybody is waiting on.
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
 * The newest question-and-answer pair in a stored transcript, or `null` when it holds none.
 *
 * Searched from the end because that is where the newest turn is: the transcript is a conversation
 * in order, and a session runs one turn at a time, so nothing is written after the pair at the end
 * until the next turn finishes. An assistant entry with no text is skipped — a turn whose record is
 * its work alone is not an answer anybody is waiting on — and so is a stored `system` entry, by
 * looking back for a `user` role rather than for the entry immediately before. `turn` is the
 * answer's `correlation_id` as sent — a string, `null`, or absent from an older service.
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
 * The newest answer this client already holds, as detach recovery's anchor.
 *
 * `''` when `messages` carries no turn at all, which for the two callers means this turn is the
 * conversation's first: there is no older copy of anything to confuse its answer with. `null` when
 * the newest turn left no answer here — an aborted or failed one, whose answer the service may
 * hold anyway (a detach whose recovery gave up is exactly that case), so an answer already in the
 * transcript might be *its* and recovery must wait for the transcript to move rather than adopt it.
 *
 * Only `finalText` counts. A partially streamed answer is a prefix of what the service stored, so
 * treating it as the anchor would make the previous turn's *whole* answer look like a new one.
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
 * Go and find the answer a reload interrupted.
 *
 * **The turn was not cancelled — it was detached.** `partialize` rewrites a message still marked
 * `streaming` to `aborted`, on the correct reasoning that a *stream* cannot be resumed across a
 * reload, and `chatStore` carried the conclusion "there is no resume endpoint, so on reload it
 * would hang forever". That conclusion stopped being true at
 * `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`: a disconnect detaches, the service's own
 * pump runs the turn to completion, and `api/detach.py` says in as many words that "the client
 * recovers the answer from `GET /sessions/{id}/messages` on reconnect". This app already
 * implements exactly that — and only inside the tab that started the turn, which is the one tab a
 * reload destroys. So a chemist who reloaded during a ten-minute multi-tool turn was shown
 * "Interrupted by a page reload" over an answer that existed, and the transcript rehydrate could
 * not reach it either: that effect runs only for a conversation with **no local messages at all**.
 *
 * Scoped to the conversation on screen, and to its newest turn. Doing this for every persisted
 * conversation on boot would be one long poll per conversation for answers nobody is waiting for.
 *
 * **First it follows the turn live, because the turn is usually still running.** The page's own
 * unload sent a stop, and a service that understands `reason: 'unload'` holds that stop for a grace
 * window that this reattach (`GET /sessions/{id}/turn/stream`) cancels — so the reloaded page
 * renders the rest of the turn and its answer instead of polling for it (Chemclaw3_ui#131: a plain
 * unload stop killed the turn and the page then polled an empty transcript for 630 s). It follows
 * only *its own* turn: the watch response names the turn it is a view of, and in a shared
 * conversation the one running now may be somebody else's that started meanwhile.
 *
 * Then the transcript, bounded by what the follow learned. No turn running here, or another one,
 * means this one is over and its answer is written or never will be — a short read
 * (`RELOAD_RECOVERY_MS`), then an honest "could not be recovered". A follow that *dropped* mid-turn
 * is the live path's case, and gets the live path's whole poll.
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

  // What this conversation already held when the turn started, read the same way the live path
  // reads it — a chemist who asks the same thing twice must not be handed the first answer for the
  // second, and the local list this is read from may be a trim of the real one.
  const heldAnswer = newestHeldAnswer(conversation.messages.slice(0, index - 1));

  const abort = new AbortController();
  const messageId = message.id;
  const turnId = message.correlationId ?? '';
  // Followed live only when it can be told apart from anybody else's turn (its id), when it is the
  // conversation's newest turn (a running turn is the newest one), and when nothing else holds the
  // app's one streaming slot.
  const followable =
    turnId !== '' &&
    index === conversation.messages.length - 1 &&
    useChatStore.getState().streaming === null;
  void (async () => {
    const followed = followable
      ? await followReloadedTurn(conversationId, sessionId, messageId, turnId, auth)
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
    if (recovered === null) {
      // **Recovery ran its whole budget and found nothing, so stop asking.** `finishTurn` clears
      // the flag on every turn that settles, but this exit settles nothing — and leaving the flag
      // set is what made an unrecoverable turn re-run the full 630 s / 210-request poll on every
      // single page load, for ever, behind a message the reader already sees as aborted. The
      // ownership check below applies here too: a newer turn must not be marked. And it says so:
      // "interrupted" reads as "may still come", which is no longer true.
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
      // A recovered answer was never reviewed by a second pass — this is the transcript being
      // rebuilt, not a fresh turn — so the pair is the service's own "nothing happened" values.
      challenged: false,
      review_hold_id: null,
      checks_run: [], // a transcript rebuilt locally had no gate run on it, which is what empty means
    });
    store.finishTurn(conversationId, messageId, 'done');
    announceStatus(describeAnswer(recovered));
  })();

  // The transcript poll belongs to the conversation on screen and stops with it. A live follow does
  // not: it holds the streaming slot like any turn this tab sent, and runs on while the reader looks
  // elsewhere, exactly as `sendMessage`'s does.
  return () => abort.abort();
}

/**
 * Follow a reload-interrupted turn to its end through `GET /sessions/{id}/turn/stream`.
 *
 * `'settled'` when the bubble is final — answered, failed with the turn's own error, or stopped
 * by the reader. `'gone'` when no turn of this page's is running here: a 404, or a running turn
 * the response names as another one. `'dropped'` when the view broke while the turn may still run.
 *
 * While following it is this tab's turn in every way the app knows: it holds the streaming slot and
 * the composer lock, Stop stops it, and a further reload sends the same deferred unload stop
 * `sendMessage`'s `abandon` does. Tokens are not appended: the view starts at the moment of
 * reattaching and replays nothing, so appending would splice the tail onto the text this page
 * streamed before the reload with the middle missing — the `answer` at the end is the whole text.
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
    if (someoneElses || kind === 'session_not_found') return 'gone';
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
