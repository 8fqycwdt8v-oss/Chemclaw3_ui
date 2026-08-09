/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * The endpoint list is declared in `endpoints.ts` and checked against the backend's real route
 * table by `scripts/check-contract.mjs`, so this file cannot quietly drift from the service again.
 * It previously claimed verification against a commit the backend was hundreds of changes past.
 *
 * `listSessions` and `getMessages` still swallow a 404 into an empty result. That was written when
 * those routes did not exist upstream; they do now, and a 404 means "unknown session, or not
 * yours" — deliberately indistinguishable. The degradation is kept because the outcome is the same
 * either way (there is no transcript to show), but it is no longer about an older service.
 */

import { config } from '../env.ts';
import { ApiError, errorFromStatus, readDetail } from './errors.ts';
import { paths } from './endpoints.ts';

export type TokenGetter = () => Promise<string | null>;

/**
 * How long a non-streaming call may take before it is abandoned.
 *
 * There was no timeout anywhere in this client. A hung BFF left `getPlan` pending forever, so the
 * plan card sat on "Reading the plan…" with no way out, and an upload could never be given up on.
 * Generous, because these cross a proxy to a service that can be genuinely slow — but finite,
 * because a promise that never settles is a UI state nobody can leave.
 *
 * The turn stream and the job-event stream are deliberately exempt: both are long-lived by design
 * and have their own liveness signals.
 */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, getToken: TokenGetter, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  let res: Response;
  // Compose with any caller-supplied signal rather than replacing it.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // The body reads are INSIDE the try, not after it.
  //
  // The composed signal governs the response body as well as the headers, so a timeout that
  // elapses while the body is still streaming — headers fast, body slow, which is the normal shape
  // of a hung backend — made `res.json()` reject with a raw `TimeoutError` DOMException. That
  // sailed past every `instanceof ApiError` check in this module and rendered "signal timed out"
  // to the user. This module's whole contract is that a failure arrives as an `ApiError`.
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      ...init,
      signal,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (!res.ok) throw errorFromStatus(res.status, await readDetail(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    // A typed failure from `errorFromStatus` passes straight through; only transport-level
    // rejections get reinterpreted below.
    if (err instanceof ApiError) throw err;
    // The caller's own abort is checked FIRST. It is a deliberate cancellation, and reporting it
    // as "could not reach the service" both lies and hides the caller's intent — and the composed
    // signal exists precisely so callers can abort, so that path must be the one it gets right.
    if (init.signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
    if (timeout.aborted) {
      throw new ApiError('network', 'The Chemclaw service did not respond in time.');
    }
    throw new ApiError('network', 'Could not reach the Chemclaw service.');
  }
}

export interface SessionSummary {
  session_id: string;
  created_at?: string;
  title?: string;
}

/** One tool call as the backend persisted it. `arguments`/`result` are truncated to 400 chars. */
export interface TranscriptToolCall {
  tool: string;
  arguments?: string;
  /** `null` when the call raised, or when the result was not recorded. */
  result?: string | null;
}

export interface TranscriptMessage {
  /** Position in the stored transcript. The backend orders by this, not by timestamp. */
  index?: number;
  role: string;
  text: string;
  /**
   * The tool activity that produced this message.
   *
   * The backend added this specifically to unblock this repo — it calls the absence "the largest
   * single blocker for the frontend repo" — and it was still unmodelled here, so reloading a
   * conversation silently dropped every tool call and rendered a bare answer.
   *
   * Note what the backend does NOT persist: `confidence`, `review_required`, plan snapshots and
   * attachment references. A rehydrated message therefore cannot claim to have been verified, and
   * must not render as though it was.
   */
  tool_calls?: TranscriptToolCall[];
  created_at?: string;
}

export interface AttachmentSummary {
  name: string;
  content_type: string;
  /** Parsed row count. `0` for a non-tabular format (PDF, DOCX, PPTX) — the service defaults it
   *  rather than omitting it, so treat 0 as "not a table", not as "an empty table". */
  rows: number;
  excerpt: string;
}

export interface PendingApproval {
  approval_id?: string;
  [key: string]: unknown;
}

/** The plan a session is proposing, and the hash a decision on it must be bound to. */
export interface PlanStatus {
  session_id: string;
  plan_hash: string;
  plan: string[];
  /** `plan_only` until a human approves; `execute` afterwards. */
  mode: string;
  approved: boolean;
  decided_by: string | null;
}

/** A durable run, as `job_records` remembers it. */
export interface JobRecord {
  job_id: string;
  connector: string;
  job: string;
  rationale?: string;
  summary?: string;
  note_id?: string;
  completed_at?: string | null;
  /** Who asked for it. The list is NOT owner-scoped upstream, so this is how a "mine" view is built. */
  requested_by?: string;
}

/** One job's live status. `status` is free-form; the terminal set is completed/failed/cancelled/
 *  terminated/timed_out, and anything else means still running. */
export interface JobStatus {
  job_id: string;
  status: string;
  summary?: string | null;
  result?: Record<string, unknown>;
  rationale?: string;
}

export const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'terminated',
  'timed_out',
]);

/** A note the agent proposed, awaiting human sign-off through the PR gate. */
export interface ProposalSummary {
  id: number;
  note_id: string;
  note_type: string;
  /** `open` | `merged` | `rejected` | `failed`. */
  state: string;
  branch: string;
  reference: string;
  actor: string;
  submitted_at?: string | null;
  decided_at?: string | null;
  decided_by?: string;
  reason?: string;
}

export interface ProposalFile {
  path: string;
  content: string;
}

export interface ProposalDetail extends ProposalSummary {
  content: string;
  /**
   * The other files this proposal touches.
   *
   * A proposal is a multi-file unit, so a review surface that renders only `content` is showing a
   * partial submission and asking someone to sign off on it.
   */
  dependencies: ProposalFile[];
  session_id: string;
  correlation_id: string;
}

export const api = {
  async health(): Promise<boolean> {
    try {
      await request<{ status: string }>(paths.healthz(), async () => null);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Start a session, optionally on a named agent profile.
   *
   * The profile is fixed for the session's life — the backend resolves it once so a conversation
   * cannot have its instructions and tools change underneath its own history — so this is the only
   * point at which it can be chosen. An unknown name is a 400, not a 500 on the first turn.
   */
  createSession(getToken: TokenGetter, profile?: string | null): Promise<{ session_id: string }> {
    return request<{ session_id: string }>(paths.sessions(), getToken, {
      method: 'POST',
      // The body is optional upstream; send one only when there is something to say.
      ...(profile ? { body: JSON.stringify({ profile }) } : {}),
    });
  },

  /** The caller's sessions. Returns `[]` if the backend predates this endpoint (404) or has
   *  nothing durable to list, so the sidebar simply stays local-only. */
  async listSessions(getToken: TokenGetter): Promise<SessionSummary[]> {
    try {
      return await request<SessionSummary[]>(paths.sessions(), getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return [];
      throw err;
    }
  },

  /** A session's transcript. Same graceful degradation as `listSessions`: a backend without this
   *  route, or a session whose history is gone, yields an empty transcript rather than an error. */
  async getMessages(sessionId: string, getToken: TokenGetter): Promise<TranscriptMessage[]> {
    try {
      return await request<TranscriptMessage[]>(paths.messages(sessionId), getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return [];
      throw err;
    }
  },

  uploadAttachment(
    sessionId: string,
    file: File,
    getToken: TokenGetter,
  ): Promise<AttachmentSummary> {
    const form = new FormData();
    form.append('file', file);
    return request<AttachmentSummary>(paths.attachments(sessionId), getToken, {
      method: 'POST',
      body: form,
    });
  },

  listApprovals(getToken: TokenGetter): Promise<PendingApproval[]> {
    return request<PendingApproval[]>(paths.approvals(), getToken);
  },

  /** Deliver the human Yes/No to a durable approval hold. Deliberately an HTTP route on the
   *  backend and not an agent tool — the agent proposes, a human signs off. */
  decideApproval(approvalId: string, approved: boolean, getToken: TokenGetter): Promise<void> {
    return request<void>(paths.approvalDecision(approvalId), getToken, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    });
  },

  /** The plan a session is proposing, read for the hash that binds a decision to it. */
  getPlan(sessionId: string, getToken: TokenGetter): Promise<PlanStatus> {
    return request<PlanStatus>(paths.plan(sessionId), getToken);
  },

  /**
   * Approve or reject a harness plan, bound to the exact plan the human was shown.
   *
   * `planHash` is required by the service and is deliberately not defaulted to "whatever the plan
   * is now": a plan that changed after being displayed is a different plan. A mismatch comes back
   * as 409 and is re-kinded here, because on this route that status means the plan moved, while
   * on the message route it means a turn is already running — one number, two meanings, and only
   * the caller knows which route it asked.
   */
  async decidePlan(
    sessionId: string,
    approved: boolean,
    planHash: string,
    getToken: TokenGetter,
  ): Promise<void> {
    try {
      await request<void>(paths.planDecision(sessionId), getToken, {
        method: 'POST',
        body: JSON.stringify({ approved, plan_hash: planHash }),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        throw new ApiError('plan_changed', err.message, 409);
      }
      throw err;
    }
  },

  /** The specialised agents a new session can be started as. Empty on any failure — a picker that
   *  cannot load is a missing convenience, not a reason to block starting a conversation. */
  async listProfiles(getToken: TokenGetter): Promise<string[]> {
    try {
      return await request<string[]>(paths.profiles(), getToken);
    } catch {
      return [];
    }
  },

  /** Durable runs this system has finished, newest first. Not owner-scoped by the backend. */
  listJobs(
    getToken: TokenGetter,
    query: { text?: string; connector?: string } = {},
  ): Promise<JobRecord[]> {
    return request<JobRecord[]>(paths.jobs(query), getToken);
  },

  getJob(jobId: string, getToken: TokenGetter): Promise<JobStatus> {
    return request<JobStatus>(paths.job(jobId), getToken);
  },

  /**
   * Ask Temporal to stop a run. 202 means the request was delivered, NOT that it stopped —
   * cancellation is cooperative, so the caller must poll `getJob`.
   *
   * 403 when the caller lacks the privileged role, which is the expected answer for most users:
   * a job id excludes its requester by design, so two chemists asking for the same campaign share
   * one run and neither is more entitled to cancel it.
   */
  cancelJob(jobId: string, getToken: TokenGetter): Promise<{ status: string; job_id: string }> {
    return request<{ status: string; job_id: string }>(paths.job(jobId), getToken, {
      method: 'DELETE',
    });
  },

  /** The PR-gate queue. `beforeId` is keyset pagination: pass the last id seen. */
  listProposals(
    getToken: TokenGetter,
    query: { state?: string; beforeId?: number } = {},
  ): Promise<ProposalSummary[]> {
    return request<ProposalSummary[]>(paths.proposals(query), getToken);
  },

  getProposal(id: number, getToken: TokenGetter): Promise<ProposalDetail> {
    return request<ProposalDetail>(paths.proposal(id), getToken);
  },

  /**
   * Sign off on a proposed note.
   *
   * `reason` is mandatory on a rejection and the backend answers 422 without it — deliberately:
   * a rejection with no recorded reason is the one outcome the audit record cannot reconstruct.
   * Refusal order upstream is 403 (no review role) -> 422 (no reason) -> 404 -> 409 (already
   * decided), and each means something different to the reviewer.
   */
  decideProposal(
    id: number,
    approved: boolean,
    reason: string,
    getToken: TokenGetter,
  ): Promise<void> {
    return request<void>(paths.proposalDecision(id), getToken, {
      method: 'POST',
      body: JSON.stringify({ approved, reason }),
    });
  },
};
