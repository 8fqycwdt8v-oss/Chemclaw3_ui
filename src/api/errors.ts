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

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'capacity' || kind === 'network';
  }
}

export function errorFromStatus(status: number, detail?: string): ApiError {
  switch (status) {
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
    return typeof body?.detail === 'string' ? body.detail : undefined;
  } catch {
    return undefined;
  }
}
