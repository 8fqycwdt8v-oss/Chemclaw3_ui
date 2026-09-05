/**
 * Consume `GET /sessions/{id}/events` — the async job push-back stream — for SEVERAL sessions.
 *
 * This is the channel that tells the UI a durable QM job finished, without polling. It used to
 * watch only the conversation that happened to be open, which is the one case where the chemist
 * would have noticed anyway: a conformer search takes minutes to hours, so the completion almost always
 * lands while they are somewhere else. Now the recently-active conversations are watched too.
 *
 * Three backend constraints shape this, all of them still true:
 *
 *  - The backend caps concurrent event streams per user and 429s past the cap. The cap's value is
 *    now known — see `MAX_JOB_STREAMS` — but the failure mode is unchanged: the 429 path backs off
 *    and retries forever, so overshooting looks like "notifications quietly stopped". So there is
 *    an explicit client-side budget, and it only ever adjusts DOWNWARD.
 *  - Its claim is destructive and scoped to three kinds in SQL. We are one of two consumers
 *    racing for those rows, so a missed event is expected and must never be treated as an error.
 *    More streams do not multiply delivery; they multiply racers.
 *  - A legitimately silent stream must stay open. Only the connect phase is bounded.
 */

import { useEffect } from 'react';
import { config } from '../env.ts';
import { retryAfterSeconds } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type { AuthProvider } from '../auth/types.ts';
import { useChatStore } from '../state/chatStore.ts';
import type { ChatState } from '../state/chatStore.ts';
import { logger } from '../lib/logger.ts';
import { readEventStream } from '../lib/sse.ts';

/**
 * How many sessions to watch at once.
 *
 * Chosen from what the feature needs — the active conversation, plus the two most recently used,
 * which covers "I launched a run, moved on, and it finished" — and now checked against the real
 * cap rather than left as a defensible guess. The service's is
 * `service_max_event_streams_per_user`, default **5** (`chemclaw/core/config/service.py`), enforced
 * in `routes/streams.py` beside a per-pod total. Three fits under five, so the number stands; what
 * changed is that it is a measured margin instead of a hope.
 *
 * The margin is thinner than it looks, and that is the part worth knowing. The cap is **per
 * principal, per process, counted across connections** — it has no idea what a tab is. Two windows
 * on one account ask for six against a cap of five, so the second window's last stream 429s.
 * Nothing here can see the other tab: the count lives in the pod's memory, and a client-side budget
 * can only bound its own. So the overshoot is real, expected in a two-window workflow, and handled
 * rather than prevented — the 429 path below drops this tab to a single stream, which brings the
 * pair back under the cap. Preventing it properly means one tab holding the streams for all of
 * them (a `BroadcastChannel` leader election), which is a feature and not a constant; it is filed
 * in ISSUES.md rather than half-built here.
 */
const MAX_JOB_STREAMS = 3;

/**
 * Consecutive failed connects before this stream is reported as failing.
 *
 * The module docstring names the hazard exactly — "a silent retry loop is exactly how this failure
 * hides" — and then only the 429 path acted on it. Every other failure (a 500, a 502, a TLS error,
 * a DNS error, a body that closes the instant it opens) fell into two identical silent branches:
 * an infinite retry loop, capped at 30 s, with no banner, no counter, no log and no store flag, so
 * durable job completions quietly stopped arriving and nothing anywhere recorded that they had.
 *
 * Four, because the backoff is 1, 2, 4, 8 s: past it the stream has been down for roughly half a
 * minute, which is long enough that this is not a rollout blipping and short enough that the
 * chemist has not yet been waiting for a completion that will never arrive.
 */
const FAILURES_BEFORE_REPORTING = 4;

/**
 * The sessions to watch, as one comma-joined string.
 *
 * A string rather than an array because it is both the effect's dependency and the store
 * subscription: zustand compares a selector's result with `Object.is`, so a projection to a
 * primitive re-renders only when the watched set actually changes. Exported so the property that
 * matters — a token flush does not move it — can be pinned without opening a socket.
 */
export function watchedSessionKey(s: ChatState): string {
  const budget = s.jobStreamsThrottled ? 1 : MAX_JOB_STREAMS;
  const activeId = s.activeId;
  const candidates = Object.values(s.conversations)
    .filter((c) => c.sessionId)
    // A conversation nobody has sent in has no job to report. This predicate is also what keeps
    // `warmSession` from inflating the stream count: warming gives a session, not a turn.
    .filter((c) => c.messages.length > 0 || c.id === activeId)
    .sort((a, b) => {
      if (a.id === activeId) return -1; // the active conversation is always watched
      if (b.id === activeId) return 1;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, budget)
    .map((c) => c.sessionId as string);
  return [...new Set(candidates)].join(',');
}

export function useJobStreams(): void {
  const { auth, ready } = useAuth();

  // **The projection is the subscription.** The conversations map is a fresh object on every store
  // write, so this used to be `useChatStore((s) => s.conversations)` folded into a `useMemo`. The
  // memo did its job — streams were not torn down and reopened once per animation frame — but it
  // could not touch the other half: subscribing to the map at all re-renders *this hook's
  // component* at that rate, and its component is `AppShell`, so the top bar, the composer, the
  // entity rail and the sidebar were all dragged onto the per-token render path. Measured with the
  // hook stubbed out, 20 token flushes went from 20 renders each of those four to 0, and ~70% of
  // all per-frame work went with them. `MessageList.tsx` documents this exact hazard and avoids
  // it; the shell above it did not.
  //
  // Selecting the key itself means zustand compares with `Object.is` and re-renders only when the
  // watched set actually changes. The projection still runs per write, over at most
  // `MAX_CONVERSATIONS` entries, which is microseconds.
  const watchKey = useChatStore(watchedSessionKey);

  useEffect(() => {
    if (!ready || !watchKey) return;
    const sessionIds = watchKey.split(',').filter(Boolean);
    const controllers = sessionIds.map((sessionId) => {
      const controller = new AbortController();
      void openStream(sessionId, auth, controller);
      return controller;
    });
    return () => {
      controllers.forEach((c) => c.abort());
      // A stream nobody is watching cannot be failing. Without this, dropping a conversation out
      // of the watch set would leave its indicator up for the life of the page.
      sessionIds.forEach((id) => useChatStore.getState().setJobStreamFailing(id, false));
    };
  }, [watchKey, auth, ready]);
}

async function openStream(
  sessionId: string,
  auth: AuthProvider,
  controller: AbortController,
): Promise<void> {
  let attempt = 0;
  let consecutive429 = 0;
  let reauthed = false;
  /** Connects that produced no frame, in a row. Reset by a frame, never by a connect. */
  let failures = 0;

  /**
   * Record one connect that delivered nothing, and say so once it has happened enough times.
   *
   * The log line is per attempt because the shape of the failure is what an operator needs — a
   * 502 every time is an ingress, a 401 once is a token, a clean close every time is a pod coming
   * up — and the store flag is once, because it drives an indicator rather than a stream of them.
   */
  const failed = (reason: string, status?: number): void => {
    failures += 1;
    logger.warn('jobstream.connect_failed', {
      sessionId,
      reason,
      ...(status ? { status } : {}),
      attempt: failures,
    });
    if (failures >= FAILURES_BEFORE_REPORTING) {
      useChatStore.getState().setJobStreamFailing(sessionId, true);
    }
  };

  /** A frame arrived, so this stream is doing its job. */
  const delivering = (): void => {
    // The one-shot re-auth below is spent per *rejection*, not per session, and this is where it
    // is given back. `reauthed` was set once and never cleared, so a stream that refreshed its
    // token, then delivered for an hour, then hit the ordinary next expiry took the `return`
    // instead of the refresh — permanently, for the life of the page. Measured over
    // `401 → 200 (one job_completed frame, then close) → 401`: requests 3, provider asked 1,
    // jobFeed 1, and every completion after that lost. A connection that delivered is proof the
    // credential it used was good, which is exactly what makes the next 401 a *new* fact.
    reauthed = false;
    if (failures === 0) return;
    failures = 0;
    useChatStore.getState().setJobStreamFailing(sessionId, false);
  };

  while (!controller.signal.aborted) {
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`${config.apiBase}/sessions/${sessionId}/events`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

      // Over the per-user stream cap (`service_max_event_streams_per_user`, default 5, shared
      // across this account's tabs). Backing off hard is necessary but not sufficient: a silent
      // retry loop is exactly how this failure hides. A second one in a row means this tab's share
      // of the cap is smaller than its budget — almost always a second window — so we say so and
      // drop to a single stream for the life of the page.
      //
      // Still no recovery path, and still deliberately: raising the budget again after a quiet
      // spell would flap against whatever else holds the cap, and the cost of staying low is one
      // tab watching one conversation instead of three. Down is cheap; oscillating is not.
      //
      // Except when the 429 is not this cap at all. The per-principal *request* limiter refuses
      // inside `require_principal`, ahead of every route including this one, and says when to come
      // back in `Retry-After`; the stream cap sends no such header. Counting a limiter refusal as
      // evidence that this tab holds too many streams would drop it to one stream for the life of
      // the page over a budget that refills in seconds — so honour the number it sent, and leave
      // `consecutive429`, the cap's own counter, alone. It is the same signal `errorFromStatus`
      // splits the two 429s on. (The *failure* counter is a different fact and does now move; see
      // the branch itself.)
      if (res.status === 429) {
        // **Presence picks the branch; parsing only supplies the number.** These are two decisions
        // and this file made them one: `retryAfterSeconds` returns `null` for a header it cannot
        // read — an HTTP-date from a gateway, a `0`, a stray character — so a limiter refusal
        // whose header survived the hop in a shape this parser does not accept fell into the
        // stream-cap branch below, and two of them set `jobStreamsThrottled`, which is
        // irreversible: this tab watches one conversation instead of three for the life of the
        // page, over a budget that refilled in seconds. `errorFromStatus` already splits the two
        // 429s exactly this way, and its own comment says so; this is the file its docstring
        // claims does "the same thing for the same reason".
        const header = res.headers.get('retry-after');
        if (header?.trim()) {
          // `null` when the value is present but unreadable, which is a different thing from
          // absent: the branch is already decided, and what is missing is only the number. The
          // wait then comes from the backoff below rather than from an invented constant —
          // `sleep(0)` on an unreadable header would be a hot retry loop.
          const wait = retryAfterSeconds(header);
          // Honouring the number is right; honouring it *silently and for ever* was not. This was
          // the one retry path that touched neither `failed()` nor `attempt` nor the log, so a
          // limiter refusing steadily — plausibly *because* this tab keeps coming back at exactly
          // the rate it asked for — was invisible. Measured over 120 s of one stream at
          // `Retry-After: 1`: **121 requests, `jobStreamsFailing` empty**, nothing logged.
          //
          // So it counts like every other connect that delivered nothing, and past the reporting
          // threshold the header stops being taken at face value: a limiter that has refused four
          // times running is not describing a queue that clears in a second, and the backoff's
          // 15-30 s ceiling is the honest pace for it. `jobStreamsThrottled` is deliberately NOT
          // set — that flag means "this tab holds more streams than its share of the *stream*
          // cap", which a request-rate refusal is no evidence of, and it is irreversible.
          attempt += 1;
          failed('rate_limited', 429);
          if (failures >= FAILURES_BEFORE_REPORTING || wait === null) {
            await backoff(attempt, controller.signal);
          } else {
            // Bounded by the same ceiling the backoff has. The limiter's own number is seconds, so
            // this never bites in practice; what it prevents is a header from somewhere else in
            // the path silently switching job push-back off for an hour.
            await sleep(Math.min(wait * 1_000, MAX_BACKOFF_MS), controller.signal);
          }
          continue;
        }
        // **This was the last retry path that told nobody.** It called neither `failed()` nor
        // the logger nor `attempt`, and once `jobStreamsThrottled` is already true
        // `setJobStreamsThrottled(true)` is a no-op — so a tab persistently over the per-user cap
        // spun at the 15-30 s backoff for the life of the page with nothing recorded anywhere.
        // Measured over 12 simulated hours on one watched session: **1,932 requests, 0 log lines,
        // `jobStreamsFailing` empty**. That is the module docstring's own named hazard
        // ("notifications quietly stopped") surviving in the one branch the client-side budget
        // cannot fix, because the budget reduces how many streams there are, not whether the
        // survivor reports.
        consecutive429 += 1;
        if (consecutive429 >= 2) useChatStore.getState().setJobStreamsThrottled(true);
        attempt += 1;
        failed('stream_cap', 429);
        // **The wait stays at the ceiling, and the counter is what moves.** This branch used to
        // pass the literal `6` — `backoff`'s saturation point, so 15–30 s — and making it share
        // `attempt` with every other retry path dropped the *first* cap refusal to 1–2 s. That is
        // the wrong pace for this refusal specifically: a concurrent-stream cap is not a transient
        // failure that clears while you wait, it is a statement that something else holds the
        // slots, so coming back in a second is the hammering the constant existed to prevent.
        // `attempt` still rises, because it is also the failure count this branch now reports on.
        await backoff(Math.max(attempt, 6), controller.signal);
        continue;
      }
      consecutive429 = 0;

      // A 401 is not a transport failure and must not be backed off like one. It used to fall
      // into the branch below — increment, wait, retry, forever — so an unrecoverable rejection
      // (a revoked token, a misconfigured audience after a redeploy) became an unbounded request
      // loop from every open tab, against a service whose per-principal rate budget cannot see
      // it: that budget lives *inside* the front door's `require_principal` and only spends after
      // validation succeeds.
      //
      // So: ask the provider to recover, once. Under MSAL that is usually invisible, because
      // `getAccessToken` already refreshes silently — reaching here means the refresh did not
      // help, which is precisely when retrying the same token forever is the wrong answer. If it
      // cannot recover, stop watching. The conversation still works; only push-back is lost, and
      // the turn path will surface the sign-in prompt on the next message.
      if (res.status === 401) {
        // **`handleUnauthorized` is typed `Promise<boolean>` and one shipped provider throws.**
        // `createDevAuth` rejects with an actionable `ApiError` ("Redeploy it with AUTH_MODE=msal…")
        // for the UI-in-dev-mode / backend-with-Entra-required combination — which
        // `server/ready.ts` does not detect either, because its probe only runs in `msal` mode. The
        // await sat inside the outer `try`, so that rejection landed in the bare `catch` below and
        // was classified `transport`: retry for ever, message discarded, and the `jobstream.
        // unauthorized` terminus never reached. Measured over 12 simulated hours: **1,918 requests,
        // 1,918 recovery attempts, and not one log line carrying the actionable text.**
        //
        // `!reauthed &&` keeps the original short-circuit: the one-shot is spent per rejection, and
        // asking a provider that has already been asked is both pointless and, under MSAL, a
        // second redirect.
        let recovered = false;
        if (!reauthed) {
          try {
            recovered = await auth.handleUnauthorized();
          } catch {
            // A provider that cannot even attempt recovery has answered the question: it cannot.
            recovered = false;
          }
        }
        // Every other terminus in this loop checks this first; this one did not, so the store
        // write below could land *after* the effect cleanup had aborted the stream and cleared the
        // flag for this session — leaving a "job notifications failing" indicator that nothing
        // would ever clear again, on a session nothing is watching.
        if (controller.signal.aborted) return;
        if (reauthed || !recovered) {
          logger.warn('jobstream.unauthorized', { sessionId });
          // The indicator is raised here rather than through `failed()`, and immediately rather
          // than after four attempts. `FAILURES_BEFORE_REPORTING` exists so a rollout blip does
          // not raise a badge, and it works because a transient failure *repeats* — this one
          // does not, because there is no next attempt to count. It was the only terminus in
          // this loop that returned without telling anyone, so the one death mode that is
          // permanent was the one that showed nothing: a conformer search finishing afterwards
          // produced no card, no badge and no notification.
          useChatStore.getState().setJobStreamFailing(sessionId, true);
          return;
        }
        reauthed = true;
        continue;
      }

      if (!res.ok || !res.body) {
        attempt += 1;
        failed('status', res.status);
        await backoff(attempt, controller.signal);
        continue;
      }

      // `readEventStream` cancels its reader on the way out (loop exit, throw, or this iterator
      // being abandoned), so there is nothing left to clean up here.
      //
      // Whether this connection delivered anything at all — see the close handling below.
      let sawFrame = false;
      for await (const frame of readEventStream(res.body)) {
        sawFrame = true;
        // A frame arrived, so this connection is doing its job — only now is the escalation
        // reset. Resetting it at connect time meant a connect-then-immediately-close cycle
        // could repeat for ever without the delay ever growing. A frame this build cannot use
        // still counts as "arrived": it proves the connection is delivering, which is the only
        // question the backoff and the failure counter are asking.
        attempt = 0;
        delivering();
        if (!frame.event) continue;
        const event = frame.event;
        try {
          // Both endings, not just the happy one. This stream is scoped server-side to
          // `job_completed`, `job_failed` and `awaiting-answer`, and a job that died after the
          // turn ended is the case the whole push-back path exists for — dropping it left the
          // launch row saying "runs asynchronously" indefinitely.
          if (event.type === 'job_completed' || event.type === 'job_failed') {
            // The event carries no session id — but we know which stream we opened, so the
            // association is attached here rather than by mutating the wire contract.
            useChatStore.getState().pushJobFinished(event, sessionId);
          } else if (event.type === 'awaiting_answer') {
            // The third kind this stream claims (backend D-2026-09-05). It is not a job ending —
            // it is a durable request *starting* or expiring — so it goes to its own slice rather
            // than into the job feed, where a "question waiting on you" would render as a run that
            // finished. The expiry push matters as much as the open: `noteAwaiting` removes on it,
            // which is what keeps the badge from counting a question nobody can answer any more.
            useChatStore.getState().noteAwaiting(event);
          }
        } catch {
          // one bad frame is not worth dropping the stream
        }
      }

      // The body ended with no error and no status to react to: a backend pod restarting
      // mid-rollout, a proxy hop closing the connection, an upstream failure after the headers.
      // Reconnecting is right — reconnecting *immediately* is what turned a rollout into ~300
      // connects per second per watched session, from every open tab, against the pod that was
      // still coming up. This is the same pacing every other retry path here already had.
      if (controller.signal.aborted) return;
      attempt += 1;
      // A body that ends without ever delivering a frame is a failure however clean the close
      // was: it is the rollout loop this file already paid for once, and the chemist's view of it
      // is the same as a 502's — completions stop arriving.
      //
      // **"Without ever delivering a frame" is what the comment said and not what the code did.**
      // `failed('closed')` ran unconditionally, so every ordinary reconnect of a *healthy* stream
      // shipped a WARN to the BFF log, and a stream that had delivered then hit three real
      // failures raised the badge one attempt early. `sawFrame` is the condition the sentence
      // already described.
      if (!sawFrame) failed('closed');
      await backoff(attempt, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      attempt += 1;
      // `fetch` itself threw: DNS, TLS, a refused connection. Indistinguishable here and worth
      // distinguishing in the log only by the fact that it is not a status.
      failed('transport');
      await backoff(attempt, controller.signal);
    }
  }
}

/** The longest this hook will ever wait before trying a stream again. */
const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff with jitter, capped at `MAX_BACKOFF_MS`, abortable. */
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
  return sleep(base * (0.5 + Math.random() * 0.5), signal);
}

/**
 * Wait, resolving early if the stream is torn down — a timer nobody cancels outlives the tab's
 * interest in the answer.
 *
 * Both halves are cleaned up by whichever of them wins, and that is the fix rather than a
 * tidy-up. `{ once: true }` removes a listener only when the event FIRES, and on the ordinary
 * path it never does: the timer wins, the promise resolves, and the listener stays attached to a
 * signal that lives for the whole stream. Measured on a stream held at the 15-30 s backoff cap
 * for 12 simulated hours: **1,931 `abort` listeners added, 0 removed**, each retaining this
 * closure and its timer id — from one stream, of the three a tab holds.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    // Declared after `done` and read only from inside it, which is after `setTimeout` has
    // returned — the two refer to each other, and this is the order that keeps both `const`.
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}
