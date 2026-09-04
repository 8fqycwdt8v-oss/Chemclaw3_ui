/**
 * Typed API errors.
 *
 * The Chemclaw service's status codes each mean something specific and each want a different
 * response from the UI, so they are mapped once here rather than being re-interpreted at every
 * call site. Statuses verified against service/app.py @ d5ed9e3.
 */

export type ApiErrorKind =
  /** 401 — missing or invalid bearer token. Re-authenticate. */
  | 'unauthorized'
  /** 404 — unknown session, someone else's session, or one evicted from the backend's live-session
   *  LRU. The backend deliberately makes these indistinguishable, so treat all three the same:
   *  the handle is dead, mint a new one. */
  | 'session_not_found'
  /** 409 — a turn is already running for this session. The backend serialises turns per session
   *  and sheds rather than queues, so this is a hard error, not a wait. */
  | 'turn_in_flight'
  /** 409 on the plan-decision route only — the plan changed between being shown and being
   *  approved, so the human agreed to something else and the service refuses rather than
   *  silently approving the current plan. The status alone cannot be told apart from
   *  `turn_in_flight`, which is why `api.decidePlan` re-kinds it instead of `errorFromStatus`
   *  guessing from a number that means two different things on two different routes. */
  | 'plan_changed'
  /** 409 on the protocol-revision route only — the design moved between being opened for editing
   *  and being saved, so this edit was written against a revision that is no longer the head and
   *  saving it would silently discard whatever landed in between. Re-kinded by
   *  `api.putProtocolRevision` for exactly the reason `plan_changed` is: the status alone cannot be
   *  told apart from `turn_in_flight`, and only the caller knows which route it asked. */
  | 'revision_conflict'
  /** 409 on the protocol-status route only — somebody else *decided* while this chemist was
   *  deciding. Distinct from `revision_conflict` because the document did not move, so the remedy
   *  is not a diff: a colleague already approved, executed or abandoned this design, and the
   *  question is whether to override them. The service is what tells the two apart —
   *  `{"code": "status_conflict"}` against `{"code": "revision_conflict"}` on one route — because
   *  the status number cannot: before this, `expected_revision` was a compare-and-set on the
   *  *document* alone and two people at revision 1 could approve and abandon it with both told
   *  204, so the case had no 409 to carry a code at all. */
  | 'status_conflict'
  /** 422 — message over the backend's character cap. */
  | 'message_too_long'
  /** 429 without a `Retry-After` — the turn/token budget is spent, or too many concurrent event
   *  streams are open. Terminal: neither replenishes because somebody pressed a button. */
  | 'budget_exhausted'
  /** 429 *with* a `Retry-After` — the per-principal request limiter refused this call and said
   *  when to come back. The service computes that number specifically so a client can wait it
   *  out, so this is a pause, not a refusal. */
  | 'rate_limited'
  /** 503 — admission control shed the turn; the service is at capacity. Retryable. */
  | 'capacity'
  /** `fetch` itself threw — the service is unreachable. */
  | 'network'
  /** The user pressed Stop. */
  | 'aborted'
  /** The stream was malformed, truncated, or dropped — a connection problem, plausibly
   *  recoverable by polling the session transcript for the answer the server is still producing. */
  | 'stream'
  /** The stream ended cleanly with the server's own `empty_answer` event: the turn ran to
   *  completion and produced nothing. Not a connection problem — polling the transcript would
   *  wait for an answer the server has already said will never arrive. */
  | 'empty_answer'
  /** An `error` event arrived in-stream. Includes the turn timeout, which the backend reports as
   *  a final SSE event rather than an HTTP status. */
  | 'agent'
  /**
   * The auth provider could not produce a bearer token, for a reason it did not resolve into an
   * interactive sign-in itself — `msalAuth.getAccessToken` rethrows exactly this shape, on
   * purpose: a silent-refresh failure is very often a network blip, not proof the session is
   * gone, and forcing a redirect on one would send a chemist to a login page to fix an unplugged
   * VPN.
   *
   * Distinct from `network` although the message reads the same: this failure happens strictly
   * BEFORE any request is opened, so unlike a `fetch` that throws after being sent, there is no
   * chance whatsoever that the server received anything. `stream`/`network` recovery polls the
   * session transcript on exactly that chance — for this kind there is none to poll for, and
   * `sendMessage` must not read "no bearer token" as "the turn may still be running server-side". */
  | 'token_unavailable';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;
  /**
   * The service's own id for the request or turn that failed, when it sent one.
   *
   * It used to come only from an in-stream `error` event, so every HTTP-level failure — a 401, a
   * 409, a dropped connection — reached the banner with nothing to quote, and "it broke at 14:32"
   * could not be joined to a single line of the service's logs. The service stamps this id on
   * every JSON log record it writes, so the join key exists; what was missing was reading it back.
   * Now `errorFromStatus` takes it from the response (the `X-Chemclaw-Correlation-Id` header, or
   * `correlation_id` in the error body) and `streamTurn` carries the turn's own.
   *
   * Still empty when the service did not send one — an older deployment, or a `fetch` that never
   * reached it — and empty is the honest reading, never a placeholder. It is shown to the user
   * rather than only logged, because the browser console is not somewhere a chemist looks and this
   * string is the entire content of a useful support message.
   */
  readonly correlationId: string;
  /**
   * Seconds to wait before retrying, from the service's own `Retry-After`. Zero when it sent none,
   * which is every failure but `rate_limited`.
   */
  readonly retryAfterSeconds: number;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    /** Overrides the kind-derived default. The service knows things about one specific failure
     *  that its category does not — a `storage_unavailable` may or may not be worth retrying,
     *  and it is the only party that can tell. */
    options?: { retryable?: boolean; correlationId?: string; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable =
      options?.retryable ?? (kind === 'capacity' || kind === 'network' || kind === 'rate_limited');
    this.correlationId = options?.correlationId ?? '';
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 0;
  }
}

/**
 * The response header the service stamps its per-request correlation id on.
 *
 * Read, never sent. Sending one is a dead end twice over: the BFF strips every `x-chemclaw-*`
 * request header deliberately (`server/proxy.ts`, a trap removed before somebody adds a reader),
 * and the service mints the id itself and has no reader for a client-supplied one. The id is the
 * service's to issue and this app's to quote back.
 */
export const CORRELATION_HEADER = 'x-chemclaw-correlation-id';

/** The correlation id this response carries, or `''` when it carries none. */
export const correlationFrom = (res: { headers: Headers }): string =>
  res.headers.get(CORRELATION_HEADER)?.trim() ?? '';

/**
 * Seconds a `Retry-After` asks for, or `null` when there is no usable one.
 *
 * Exported because `useJobStreams` reads the same header off the same status for the same reason,
 * and the header's meaning is one fact — a second copy of this parse is a second answer to
 * "was this the rate limiter?".
 *
 * Delta-seconds only. The one producer of this header in the chain is the service's
 * per-principal request limiter, which sends `str(ceil(seconds))`; an HTTP-date would come from
 * something else in the path whose meaning we cannot vouch for, and misreading it as a wait is
 * worse than not having one. Zero is not "immediately" here — it is a value we cannot act on —
 * so it does not count.
 */
export function retryAfterSeconds(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Map an HTTP failure onto a typed error.
 *
 * `retryAfter` is the response's own `Retry-After`, and it is what tells the two 429s apart. The
 * service refuses with that status for three structurally different reasons: the per-principal
 * request limiter, which computes the wait and sends it precisely so a client backs off by the
 * right amount; the turn/token budget; and the concurrent-event-stream cap. Only the first
 * replenishes on its own, and only the first says so. Collapsing all three into
 * `budget_exhausted` locked the composer on a limit that had already refilled by the time the
 * banner rendered — the same conflation `errorFromEvent` below records for the in-band path,
 * fixed here on the same principle: the service's own signal decides, not the status number.
 *
 * (The event-stream cap does not come through here at all — `useJobStreams` reads that status
 * itself, and honours a `Retry-After` for the same reason.)
 *
 * `correlationId` is threaded onto every branch so that EVERY banner can carry a reference, not
 * only the ones raised by an in-stream `error` event. Both trailing arguments are read off the
 * same failed response, which is why `readFailure` hands back the id and the caller passes the
 * header straight through.
 */
export function errorFromStatus(
  status: number,
  detail?: string,
  /** The response's `Retry-After`, verbatim — parsed here, not at the call site. */
  retryAfter?: string | null,
  /** The service's id for the request that failed — `correlationFrom`, or the error body's
   *  `correlation_id`. */
  correlationId?: string,
  /**
   * The service's own machine-readable discriminator, from an object `detail`'s `code`.
   *
   * Only 409 reads it, and only because that status genuinely means several things: a turn already
   * running, an edit against a stale revision, and a sign-off against a status somebody else
   * already moved. The comment above says the *number* must not be guessed from, and that stands —
   * this is not the number, it is the service naming which of its own refusals this is. A response
   * without one falls through to the message-route default exactly as before, which is what keeps
   * an older deployment working.
   */
  code?: string,
): ApiError {
  const options = correlationId ? { correlationId } : undefined;
  switch (status) {
    case 401:
      return new ApiError(
        'unauthorized',
        'Your session has expired. Please sign in again.',
        401,
        options,
      );
    case 404:
      return new ApiError('session_not_found', detail || 'unknown session', 404, options);
    case 409:
      if (code === 'status_conflict' || code === 'revision_conflict') {
        return new ApiError(code, detail || 'Somebody else changed this design.', 409, options);
      }
      return new ApiError(
        'turn_in_flight',
        detail || 'A turn is already running for this conversation.',
        409,
        options,
      );
    case 422:
      return new ApiError(
        'message_too_long',
        detail || 'That message exceeds the service’s length limit.',
        422,
        options,
      );
    case 429: {
      // The *presence* of the header picks the kind; parsing it only supplies the number. These
      // are two decisions and they used to be one: a `Retry-After` this parser could not read —
      // an HTTP-date from a gateway, a `0`, a stray character — fell through to the terminal
      // branch, which locks the composer with "the usage budget is exhausted" over a limiter that
      // refills in seconds, and nothing in the UI clears that lock. Refusing to invent a *wait*
      // from an unreadable value is right; inventing a *ceiling* from it is not.
      //
      // A `rate_limited` carrying zero renders correctly: `Countdown` shows nothing at zero, so
      // the banner is the sentence without a number.
      if (retryAfter?.trim()) {
        // The one status whose `detail` is not used. The limiter's is the fixed string "too many
        // requests", which says nothing the kind does not, and the banner appends the wait to
        // this — so a lower-case fragment from the service would land mid-sentence.
        return new ApiError(
          'rate_limited',
          'The service is limiting how fast requests can be made.',
          429,
          { ...options, retryAfterSeconds: retryAfterSeconds(retryAfter) ?? 0 },
        );
      }
      return new ApiError(
        'budget_exhausted',
        detail || 'The usage budget for this service is exhausted.',
        429,
        options,
      );
    }
    case 503:
      return new ApiError(
        'capacity',
        detail || 'The service is at capacity. Retry shortly.',
        503,
        options,
      );
    default:
      return new ApiError(
        'network',
        detail || `The service returned an unexpected status (${status}).`,
        status,
        options,
      );
  }
}

/**
 * Map an in-stream `error` event onto a typed error.
 *
 * The event's `code` is a closed set the service maintains, and each member wants something
 * different from the UI. Before this every one of them became `agent` with no action offered,
 * which had two visible costs: a `budget_exhausted` that arrived as an event rather than as a 429
 * left the composer unlocked, so the next message was sent into a budget that was already gone;
 * and a `storage_unavailable` the service had marked retryable was presented as final.
 *
 * Only two codes change the *kind*, because only two change what the UI must do. The rest stay
 * `agent` and are differentiated by the service's own message — which is already user-safe, and is
 * better wording than a mapping table here would invent. `retryable` comes from the event in every
 * case: it is the service's judgement, not a property of the category.
 */
export function errorFromEvent(event: {
  message: string;
  code: string;
  retryable: boolean;
  correlation_id: string;
}): ApiError {
  const options = { retryable: event.retryable, correlationId: event.correlation_id };
  switch (event.code) {
    case 'budget_exhausted':
      // The kind that can lock the composer — the same terminal state a 429 produces. Whether it
      // *does* is the event's call, not this table's: the service sends this one code for two
      // different things, and only it can tell them apart. A real budget exhaustion arrives
      // `retryable=False`; admission control shedding a turn arrives `retryable=True` with
      // "server at capacity; retry shortly", which its own ADR glosses as "'not now', not 'not
      // ever'". Hardcoding `false` here rendered every shed as a permanent refusal.
      return new ApiError('budget_exhausted', event.message, undefined, options);
    case 'empty_answer':
      // Not a service failure, and not a connection problem either — the turn ran to completion
      // and produced nothing. Its own kind, so callers don't run connection-drop recovery (polling
      // the transcript for an answer that will never land) against an outcome the server has
      // already resolved.
      return new ApiError('empty_answer', event.message, undefined, options);
    default:
      return new ApiError('agent', event.message, undefined, options);
  }
}

/**
 * What a failed response says about itself: FastAPI's `{"detail": …}` and the correlation id.
 *
 * Both halves are best-effort and neither may mask the real error — an error page, an empty body
 * or a gateway's HTML is common on exactly these paths. The header is read first because it is
 * present on every response the service writes, including the ones with no body at all; the body's
 * `correlation_id` is the fallback for a response that carries one there instead.
 */
/**
 * The service's `detail`, as a sentence, whatever shape it arrived in.
 *
 * **A pydantic validation error is an array of objects, and dropping it made every rejected edit
 * read as the wrong thing.** `detail` was kept only when it was a string, so a 422 from
 * `POST /protocols/{id}/revisions` fell through to `errorFromStatus`'s message-route default and
 * told a chemist "That message exceeds the service's length limit." — for typing `0` into
 * "Time (h)", or clearing a factor level's label. Those are ordinary states of the editor's own
 * controls, and the actual reason (`Input should be greater than 0`, and the field it came from)
 * was discarded on the way.
 *
 * `loc` is trimmed of its `body`/`document` prefix, because a chemist reads
 * `base.setpoints.time_h`, not the transport's framing of it.
 *
 * **The third shape is an object, and it is the one this function was first written blind to.**
 * `POST /protocols/{id}/revisions` answers a stale edit with
 * `{"code": "revision_conflict", "message": …}` — a `detail` that is neither a string nor an array
 * — so the message naming the head revision was dropped and `errorFromStatus`'s 409 default put
 * "A turn is already running for this conversation." on a banner about a concurrent *edit*. The
 * `code` is still not *rendered* — a machine-readable code is for the code that branches on it,
 * not for the chemist — but `detailCode` above now hands it to `errorFromStatus`, because the
 * status route answers with two of them (`revision_conflict` and `status_conflict`) and only the
 * service can say which refusal this is.
 */
function detailCode(detail: unknown): string | undefined {
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' && code ? code : undefined;
  }
  return undefined;
}

function detailText(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail;
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    return typeof message === 'string' && message ? message : undefined;
  }
  if (!Array.isArray(detail)) return undefined;
  const parts = detail
    .map((item) => {
      const entry = item as { loc?: unknown; msg?: unknown };
      if (typeof entry?.msg !== 'string') return '';
      const where = Array.isArray(entry.loc)
        ? entry.loc
            .filter((step) => step !== 'body' && step !== 'document')
            .map(String)
            .join('.')
        : '';
      return where ? `${where}: ${entry.msg}` : entry.msg;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export async function readFailure(
  res: Response,
): Promise<{ detail?: string; code?: string; correlationId: string }> {
  const fromHeader = correlationFrom(res);
  try {
    const body = (await res.json()) as { detail?: unknown; correlation_id?: unknown };
    return {
      detail: detailText(body?.detail),
      code: detailCode(body?.detail),
      correlationId:
        fromHeader || (typeof body?.correlation_id === 'string' ? body.correlation_id : ''),
    };
  } catch {
    return { correlationId: fromHeader };
  }
}
