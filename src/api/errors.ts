/**
 * Typed API errors: each status maps once here to a kind the UI acts on, rather than being
 * re-interpreted at every call site.
 */

export type ApiErrorKind =
  /** 401 — missing or invalid bearer token. Re-authenticate. */
  | 'unauthorized'
  /**
   * 403: the caller was identified and lacks the role or ownership. A refusal, not a fault and not
   * retryable; re-authenticating does not help. The service's own sentence (naming the entitlement)
   * is preferred.
   */
  | 'forbidden'
  /**
   * 404: unknown, someone else's, or evicted session — indistinguishable by design. The handle is
   * dead; mint a new one.
   */
  | 'session_not_found'
  /**
   * 409 on the turn route: the session could not take this message (a busy session queues instead).
   * The service's detail says why.
   */
  | 'turn_in_flight'
  /**
   * 409 `queue_full`: the session's line is full. Wait and send again; never reset. Older services
   * send a sentence, which stays `turn_in_flight`.
   */
  | 'queue_full'
  /**
   * 409 `already_waiting`: this sender already has a message in the line. Same fallback as
   * `queue_full`.
   */
  | 'already_waiting'
  /**
   * 409 on the plan-decision route: the plan changed since it was shown. Re-kinded by
   * `api.decidePlan`, since the status alone also means `turn_in_flight`.
   */
  | 'plan_changed'
  /**
   * 409 on the protocol-revision route: the design moved since it was opened for editing. Re-kinded
   * by `api.putProtocolRevision`.
   */
  | 'revision_conflict'
  /**
   * 409 `status_conflict` on the protocol-status route: someone else changed the status meanwhile.
   * The document did not move, so the remedy is not a diff.
   */
  | 'status_conflict'
  /**
   * 409 `stale_revision` on the artefact-revision route, with the head revision it moved to; the
   * editor diffs and offers to reapply. Always raised as `StaleRevisionError`.
   */
  | 'stale_revision'
  /**
   * 409 `exhibit_limit`: the session holds the maximum number of artefacts; revise an existing one
   * instead.
   */
  | 'exhibit_limit'
  /**
   * 422 on the turn route about the attached artefact references (unknown, or too many), not the
   * text. Re-kinded by `streamTurn`, which knows it sent references.
   */
  | 'invalid_reference'
  /** 422 — message over the backend's character cap. */
  | 'message_too_long'
  /** 429 without a `Retry-After` — the turn/token budget is spent, or too many concurrent event
   *  streams are open. Terminal: neither replenishes because somebody pressed a button. */
  | 'budget_exhausted'
  /**
   * 429 with a `Retry-After`: the per-principal limiter said when to come back. A pause, not a
   * refusal.
   */
  | 'rate_limited'
  /**
   * Admission control shed the turn (a 503 before the stream, or an in-stream `at_capacity`).
   * Retryable.
   */
  | 'capacity'
  /** `fetch` itself threw — the service is unreachable. */
  | 'network'
  /** The user pressed Stop. */
  | 'aborted'
  /**
   * The stream was malformed, truncated or dropped; possibly recoverable by polling the transcript.
   */
  | 'stream'
  /** The stream ended with `empty_answer`: the turn completed with nothing. Do not poll. */
  | 'empty_answer'
  /**
   * `context_length`: the conversation outgrew the model's window. Not retryable; offer a fresh
   * session.
   */
  | 'context_length'
  /**
   * `queue_cancelled`: the message was withdrawn from the line before it ran. Not a failure; the
   * question goes back to the composer.
   */
  | 'queue_cancelled'
  /**
   * `stream_lagged`: this view fell behind and was cut off; the turn runs on. Reattach or read the
   * transcript.
   */
  | 'stream_lagged'
  /**
   * The followed turn died with its service process (a 410 `turn_interrupted` on reattach, or an
   * `interrupted` question in the transcript). Offer Retry; do not poll.
   */
  | 'turn_interrupted'
  /** An `error` event arrived in-stream. Includes the turn timeout, which the backend reports as
   *  a final SSE event rather than an HTTP status. */
  | 'agent'
  /**
   * The auth provider could not produce a token (e.g. a silent-refresh network failure, which
   * deliberately does not force a redirect). Happens before any request, so the server received
   * nothing and there is nothing to recover.
   */
  | 'token_unavailable';

/**
 * This app's sentence for an interrupted turn, the same whether learned from a 410 or from the
 * transcript.
 */
export const TURN_INTERRUPTED_TEXT = 'This answer was interrupted (the service restarted).';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;
  /**
   * The service's id for the failed request or turn (from `X-Chemclaw-Correlation-Id`, a body
   * `correlation_id`, or the turn's own), shown in the banner so it can be quoted to support. Empty
   * when not sent.
   */
  readonly correlationId: string;
  /** Seconds to wait before retrying, from `Retry-After`; zero when none was sent. */
  readonly retryAfterSeconds: number;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    /** Overrides the kind-derived default; the service may know better about one failure. */
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
 * An artefact edit written against a revision that is no longer the head. `headRevision` is `null`
 * when the 409 named none; the editor then re-reads the head rather than guessing.
 */
export class StaleRevisionError extends ApiError {
  readonly headRevision: number | null;

  constructor(headRevision: number | null, message: string, correlationId = '') {
    super('stale_revision', message, 409, correlationId ? { correlationId } : undefined);
    this.name = 'StaleRevisionError';
    this.headRevision = headRevision;
  }
}

/**
 * Whether a turn-route 422 is about the attached artefact references. The service sends no code, so
 * this reads its sentence; only asked when the request had references.
 */
export function isReferenceRefusal(detail: string | undefined): boolean {
  return /exhibit_refs|\bartefact\b|\bexhibit\b/i.test(detail ?? '');
}

/**
 * The response header carrying the service's per-request correlation id. Read, never sent: the BFF
 * strips `x-chemclaw-*` request headers.
 */
export const CORRELATION_HEADER = 'x-chemclaw-correlation-id';

/** The correlation id this response carries, or `''` when it carries none. */
export const correlationFrom = (res: { headers: Headers }): string =>
  res.headers.get(CORRELATION_HEADER)?.trim() ?? '';

/**
 * Seconds a `Retry-After` asks for, or `null`. Delta-seconds only (the service's limiter sends
 * `ceil(seconds)`); an HTTP-date or zero is not usable. Shared with `useJobStreams`.
 */
export function retryAfterSeconds(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Map an HTTP failure to a typed error. A 429 with `Retry-After` is the refilling rate limiter;
 * without one it is a spent budget. `correlationId` is carried on every branch so every banner has
 * a reference.
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
   * The service's discriminator from an object `detail`'s `code`. Only 409 reads it, because that
   * status means several things on one route; without a code it falls back to the message-route
   * default.
   */
  code?: string,
): ApiError {
  const options = correlationId ? { correlationId } : undefined;
  // Only the reattach route answers 410, and only with this code. A 410 without it is not a
  // refusal this client knows, so it falls to the same default as any other unknown status.
  if (status === 410 && code === 'turn_interrupted') {
    return new ApiError(code, TURN_INTERRUPTED_TEXT, 410, options);
  }
  switch (status) {
    case 401:
      return new ApiError(
        'unauthorized',
        'Your session has expired. Please sign in again.',
        401,
        options,
      );
    case 403:
      // Prefer the service's sentence (it names the entitlement).
      return new ApiError(
        'forbidden',
        detail || 'You do not have permission to do that.',
        403,
        options,
      );
    case 404:
      return new ApiError('session_not_found', detail || 'unknown session', 404, options);
    case 409:
      if (code === 'exhibit_limit') {
        return new ApiError(
          code,
          detail ||
            'This conversation already holds as many artefacts as this deployment allows. Revise one instead.',
          409,
          options,
        );
      }
      if (code === 'status_conflict' || code === 'revision_conflict') {
        return new ApiError(code, detail || 'Somebody else changed this design.', 409, options);
      }
      // Queue refusals by code only; an uncoded sentence stays `turn_in_flight`.
      if (code === 'queue_full') {
        return new ApiError(
          code,
          detail || 'This conversation already has as many messages waiting as it can hold.',
          409,
          options,
        );
      }
      if (code === 'already_waiting') {
        return new ApiError(
          code,
          detail ||
            'You already have a message waiting in this conversation; withdraw it or wait for it to run.',
          409,
          options,
        );
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
      // The header's presence picks the kind; parsing only supplies the number. An unreadable value
      // is still a rate limit, shown without a countdown.
      if (retryAfter?.trim()) {
        // The limiter's `detail` is a fixed string, so this app's sentence is used.
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

/** This app's sentence for `context_length`: the remedy (a fresh session) is offered beside it. */
export const CONTEXT_LENGTH_MESSAGE =
  'This conversation has grown too long for the model to read in one go. Start a fresh session ' +
  'to carry on — asking again here will hit the same limit.';

/**
 * This app's sentence for `llm_auth`: the deployment's key is at fault; only reporting it helps.
 */
export const GATEWAY_AUTH_MESSAGE =
  "The AI model service rejected this deployment's credentials, so no question can be answered " +
  'until an administrator fixes them. Retrying will not help — please report this, with the ' +
  'reference shown.';

/** This app's sentence for `stream_lagged`: it must not read as a failed turn. */
export const STREAM_LAGGED_MESSAGE =
  'This browser fell behind the answer and the service cut its view off. The turn itself is ' +
  'still running — reconnect to follow it, or wait for the answer to land in the conversation.';

/**
 * Map an in-stream `error` event to a typed error. Only codes that change what the UI does change
 * the kind; the rest stay `agent` with the service's message. `retryable` always comes from the
 * event.
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
      // Can lock the composer, but only if the event says it is not retryable (older services send
      // a shed turn here with `retryable=true`).
      return new ApiError('budget_exhausted', event.message, undefined, options);
    case 'at_capacity':
      // Shed: "not now". Same kind as the front door's 503.
      return new ApiError('capacity', event.message, undefined, options);
    case 'empty_answer':
      // The turn completed with nothing: its own kind so no recovery polling runs.
      return new ApiError('empty_answer', event.message, undefined, options);
    case 'context_length':
      // The chemist's remedy, so this app's sentence; never retryable.
      return new ApiError('context_length', CONTEXT_LENGTH_MESSAGE, undefined, {
        ...options,
        retryable: false,
      });
    case 'llm_auth':
      // An operator's fault: name who fixes it, no Retry. Kept as `agent` since the UI does nothing
      // different.
      return new ApiError('agent', GATEWAY_AUTH_MESSAGE, undefined, {
        ...options,
        retryable: false,
      });
    case 'queue_cancelled':
      // Not a failure: the caller puts the question back.
      return new ApiError(
        'queue_cancelled',
        event.message || 'Your message was withdrawn before it ran.',
        undefined,
        { ...options, retryable: false },
      );
    case 'stream_lagged':
      // Only the view ended: retryable (look again, do not resend).
      return new ApiError('stream_lagged', STREAM_LAGGED_MESSAGE, undefined, {
        ...options,
        retryable: true,
      });
    default:
      return new ApiError('agent', event.message, undefined, options);
  }
}

/**
 * The service's discriminator from an object `detail` (`{code, message}`), passed to
 * `errorFromStatus`; never rendered.
 */
function detailCode(detail: unknown): string | undefined {
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' && code ? code : undefined;
  }
  return undefined;
}

/**
 * The head revision a `stale_revision` 409 names. Lifted here because `request` consumes the body;
 * a non-integer is dropped rather than coerced.
 */
function detailHead(detail: unknown): number | undefined {
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const head = (detail as { head_revision?: unknown }).head_revision;
    return typeof head === 'number' && Number.isSafeInteger(head) && head >= 0 ? head : undefined;
  }
  return undefined;
}

/**
 * The service's `detail` as a sentence, whatever its shape: a string, `{code, message}`, or a
 * pydantic validation array (rendered as `field.path: message`, without the `body` prefix).
 */
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

/**
 * What a failed response says about itself: FastAPI's `detail` and the correlation id (header
 * first, body `correlation_id` as fallback). Best-effort: an empty or HTML body must not mask the
 * real error.
 */
export async function readFailure(
  res: Response,
): Promise<{ detail?: string; code?: string; headRevision?: number; correlationId: string }> {
  const fromHeader = correlationFrom(res);
  try {
    const body = (await res.json()) as { detail?: unknown; correlation_id?: unknown };
    const head = detailHead(body?.detail);
    return {
      detail: detailText(body?.detail),
      code: detailCode(body?.detail),
      ...(head === undefined ? {} : { headRevision: head }),
      correlationId:
        fromHeader || (typeof body?.correlation_id === 'string' ? body.correlation_id : ''),
    };
  } catch {
    return { correlationId: fromHeader };
  }
}
