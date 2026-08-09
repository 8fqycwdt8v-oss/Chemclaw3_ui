/**
 * Typed API errors.
 *
 * The Chemclaw service's status codes each mean something specific and each want a different
 * response from the UI, so they are mapped once here rather than being re-interpreted at every
 * call site. Statuses verified against service/app.py @ d5ed9e3.
 */

import type { ChemclawErrorCode, ErrorEvent } from '../../shared/events.ts';

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
  /** 400 — the request itself was rejected, e.g. an unknown session profile. */
  | 'bad_request'
  /** 403 — authenticated, but this action needs a privileged role (proposal decisions, job
   *  cancellation). Distinct from `unauthorized`: signing in again will not help. */
  | 'forbidden'
  /** 413 — body over the 4 MB cap the BFF and the backend both enforce. */
  | 'too_large'
  /** 422 — message over the backend's character cap. */
  | 'message_too_long'
  /** 429 — turn/token budget exhausted, or too many concurrent event streams. Terminal. */
  | 'budget_exhausted'
  /** 503 — admission control shed the turn; the service is at capacity. Retryable. */
  | 'capacity'
  /** `fetch` itself threw — the service is unreachable. */
  | 'network'
  /** The user pressed Stop. */
  | 'aborted'
  /** The stream was malformed, truncated, or never produced an answer. */
  | 'stream'
  /** An `error` event arrived in-stream. Includes the 600s turn timeout, which the backend
   *  reports as a final SSE event rather than an HTTP status. */
  | 'agent';

export interface ApiErrorDetails {
  /** Overrides the kind-derived default. The backend states this per error; believe it. */
  retryable?: boolean;
  /** The backend's own error code, when this came from an in-stream `error` event. */
  code?: ChemclawErrorCode;
  /** The id the audit trail is keyed on — quote it in a bug report. */
  correlationId?: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;
  readonly code: ChemclawErrorCode | undefined;
  readonly correlationId: string | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number, details: ApiErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    // The kind-derived default is kept so every existing call site behaves exactly as before;
    // `details.retryable` is how an in-stream error asserts what the backend actually said.
    this.retryable = details.retryable ?? (kind === 'capacity' || kind === 'network');
    this.code = details.code;
    this.correlationId = details.correlationId;
  }
}

/**
 * Turn a terminal in-stream `error` event into an `ApiError`.
 *
 * The interesting case is `budget_exhausted`, which is overloaded on the wire and must be split on
 * `retryable` rather than on the code:
 *
 *   - `retryable: true`  — admission control shed the turn under load. Transient; ask again.
 *   - `retryable: false` — the session or user budget is genuinely spent. Terminal.
 *
 * Getting that backwards is not cosmetic: `sendMessage` locks the composer *permanently* on
 * `budget_exhausted`, so mapping a load-shed turn to it would wedge the conversation until a
 * reload for what is a few seconds of pressure.
 */
export function errorFromEvent(event: ErrorEvent): ApiError {
  const details: ApiErrorDetails = {
    retryable: event.retryable,
    code: event.code,
    correlationId: event.correlation_id,
  };

  switch (event.code) {
    case 'budget_exhausted':
      return event.retryable
        ? new ApiError('capacity', event.message, undefined, details)
        : new ApiError('budget_exhausted', event.message, undefined, details);
    case 'storage_unavailable':
    case 'llm_timeout':
      // Ours, not the user's, and the backend marks both retryable.
      return new ApiError('capacity', event.message, undefined, details);
    default:
      return new ApiError('agent', event.message, undefined, details);
  }
}

export function errorFromStatus(status: number, detail?: string): ApiError {
  switch (status) {
    case 400:
      // A caller error, not a transport one. Reachable today from `POST /sessions` with an unknown
      // `profile`. It had no case at all, so it fell to `default` and rendered as "the service
      // returned an unexpected status (400)" under a kind that means "unreachable".
      return new ApiError('bad_request', detail || 'The service rejected that request.', 400);
    case 401:
      return new ApiError('unauthorized', 'Your session has expired. Please sign in again.', 401);
    case 404:
      return new ApiError('session_not_found', detail || 'unknown session', 404);
    case 409:
      return new ApiError(
        'turn_in_flight',
        detail || 'A turn is already running for this conversation.',
        409,
      );
    case 422:
      return new ApiError(
        'message_too_long',
        detail || 'That message exceeds the service’s length limit.',
        422,
      );
    case 403:
      // The backend gates two things on a privileged role: deciding a note proposal and cancelling
      // a durable job. Neither is a sign-in problem, so it must not read as one.
      return new ApiError(
        'forbidden',
        detail || 'That action needs a role this account does not have.',
        403,
      );
    case 413:
      return new ApiError('too_large', detail || 'That upload is too large.', 413);
    case 429:
      return new ApiError(
        'budget_exhausted',
        detail || 'The usage budget for this service is exhausted.',
        429,
      );
    case 503:
      return new ApiError('capacity', detail || 'The service is at capacity. Retry shortly.', 503);
    default:
      return new ApiError(
        'network',
        detail || `The service returned an unexpected status (${status}).`,
        status,
      );
  }
}

/** Best-effort extraction of FastAPI's `{"detail": "..."}` without letting a parse failure mask
 *  the real error — an error page or an empty body is common on the failure paths. */
export async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    // FastAPI's request-validation handler answers with `detail` as an ARRAY of error objects,
    // not a string — so `detail` has two shapes depending on which 422 you hit, and returning
    // `undefined` for the array form threw away the only description of what was wrong.
    if (Array.isArray(body?.detail)) {
      const messages = body.detail
        .map((item) => {
          if (typeof item !== 'object' || item === null) return '';
          const { msg, loc } = item as { msg?: unknown; loc?: unknown };
          const where = Array.isArray(loc)
            ? loc.filter((l) => typeof l === 'string').join('.')
            : '';
          const what = typeof msg === 'string' ? msg : '';
          return where && what ? `${where}: ${what}` : what || where;
        })
        .filter(Boolean);
      return messages.length > 0 ? messages.join('; ') : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
