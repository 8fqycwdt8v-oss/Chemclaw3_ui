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
  /** An `error` event arrived in-stream. Includes the turn timeout, which the backend reports as
   *  a final SSE event rather than an HTTP status. */
  | 'agent';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;
  /**
   * The service's own id for the turn that failed, when it sent one.
   *
   * Only in-stream errors carry it — an HTTP failure has no correlation id to give — so this is
   * empty far more often than not. It is shown to the user rather than only logged, because the
   * browser console is not somewhere a chemist looks and this string is the entire content of a
   * useful support message.
   */
  readonly correlationId: string;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    /** Overrides the kind-derived default. The service knows things about one specific failure
     *  that its category does not — a `storage_unavailable` may or may not be worth retrying,
     *  and it is the only party that can tell. */
    options?: { retryable?: boolean; correlationId?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable = options?.retryable ?? (kind === 'capacity' || kind === 'network');
    this.correlationId = options?.correlationId ?? '';
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
      // The one that must lock the composer — the same terminal state a 429 produces.
      return new ApiError('budget_exhausted', event.message, undefined, {
        ...options,
        // Non-negotiable regardless of what the event says: the budget does not replenish
        // because someone pressed a button, and offering Retry here is offering a dead end.
        retryable: false,
      });
    case 'empty_answer':
      // Not a service failure — the turn ran and produced nothing. `stream` already means "the
      // stream ended without an answer", which is exactly what happened.
      return new ApiError('stream', event.message, undefined, options);
    default:
      return new ApiError('agent', event.message, undefined, options);
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
