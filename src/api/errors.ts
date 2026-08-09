/**
 * Typed API errors.
 *
 * The Chemclaw service's status codes each mean something specific and each want a different
 * response from the UI, so they are mapped once here rather than being re-interpreted at every
 * call site. Statuses verified against service/app.py @ d5ed9e3.
 */

import type { ErrorCode } from '../../shared/events.ts';

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
  /** An `error` event arrived in-stream. Includes the 600s turn timeout, which the backend
   *  reports as a final SSE event rather than an HTTP status. */
  | 'agent';

/**
 * What the service itself said about a failure, when the failure got far enough for it to say.
 *
 * Only ever set on an `agent` error, because that is the only kind that came from the service's own
 * `error` event rather than from a status code or a dead socket. Everything else is this client
 * classifying a failure the service never saw.
 */
export interface AgentFailure {
  code: ErrorCode;
  retryable: boolean;
  /** The id the audit trail is keyed on. Empty from a backend that predates the field. */
  correlationId: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Whether a bare retry of the same request could plausibly succeed. */
  readonly retryable: boolean;
  /** Present only for `agent`: the service's own classification of what went wrong. */
  readonly agent: AgentFailure | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number, agent?: AgentFailure) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.agent = agent;
    // The service's own verdict wins where there is one. It knows things this mapping cannot
    // infer: a `turn_timeout` may be worth retrying and a `bad_tool_arguments` never is, and both
    // arrive as the same in-stream `error` frame.
    this.retryable = agent ? agent.retryable : kind === 'capacity' || kind === 'network';
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
