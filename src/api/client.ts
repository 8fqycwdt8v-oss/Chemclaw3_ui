/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * Endpoints verified against 8fqycwdt8v-oss/Chemclaw3 @ d5ed9e3 (service/app.py). Two of them —
 * `GET /sessions` and `GET /sessions/{id}/messages` — are added by the companion backend change;
 * both degrade to an empty result rather than throwing, so this UI runs against a service that
 * does not have them yet.
 *
 * The jobs, proposals and profiles calls below were never missing backend features: they are
 * implemented, tested routes the BFF simply did not forward. Only `listProfiles` degrades on 404,
 * because a deployment without profiles should still be able to start a conversation. The others
 * surface their failure — a review queue that silently renders empty when it could not be read is
 * indistinguishable from one with nothing waiting, and those are opposite answers.
 */

import { config } from '../env.ts';
import { ApiError, errorFromStatus, readDetail } from './errors.ts';

export type TokenGetter = () => Promise<string | null>;

async function request<T>(
  path: string,
  getToken: TokenGetter,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      ...init,
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
  } catch {
    throw new ApiError('network', 'Could not reach the Chemclaw service.');
  }

  if (!res.ok) throw errorFromStatus(res.status, await readDetail(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface SessionSummary {
  session_id: string;
  created_at?: string;
  title?: string;
}

/** One tool the agent invoked during a stored turn — the same pair the live stream reports as
 *  `tool_call` + `tool_result`, recovered from storage. */
export interface TranscriptToolCall {
  tool: string;
  arguments: string;
  /**
   * `null` while the pairing is incomplete — a turn that failed mid-call, or a call whose result
   * row was pruned. That is a real state and a distinct one: it means "this ran and we do not know
   * how it ended", which must not render as a success with an empty answer.
   */
  result: string | null;
}

export interface TranscriptMessage {
  /** Position in the transcript, so a client has a stable key without the contract exposing a
   *  database row id. */
  index?: number;
  role: string;
  text: string;
  /** What the agent did during this turn. Absent from a backend that predates the field, which is
   *  why rehydration degrades to a message with an empty trace rather than failing. */
  tool_calls?: TranscriptToolCall[];
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

/**
 * One past durable run, as `GET /jobs` lists it.
 *
 * Mirrors `JobRecordSummary`. Note what the listing *is*: `job_records` rows, and a row is only
 * written once a run completes — so this endpoint answers "what has this system finished", not
 * "what is running now". A run still in flight is reachable only by its id, through `getJob`.
 *
 * `rationale` is the reason the run was asked for. It is the field that makes an old row useful
 * without its conversation, which the backend built this table for.
 */
export interface JobRecordSummary {
  job_id: string;
  connector: string;
  job: string;
  rationale: string;
  summary: string;
  /** The knowledge note the run published, if it published one. */
  note_id?: string;
  completed_at?: string | null;
}

/** One job's live state, from Temporal while it remembers the run and from `job_records` after. */
export interface DurableJobStatus {
  job_id: string;
  /** `running`, or one of `completed`/`failed`/`cancelled`/`terminated`/`timed_out`. */
  status: string;
  /** Only ever set on `completed` — the backend returns status alone for every other state. */
  summary?: string | null;
  /** Untyped by contract (`dict[str, Any]`), so anything reading it must probe and must render
   *  something for a job kind it has never seen. */
  result?: Record<string, unknown>;
  /** Empty on the live-Temporal path; carries the launching reason once only the record survives. */
  rationale?: string;
}

/** What `DELETE /jobs/{id}` answers with. See `api.requestJobCancel` for why it is not an outcome. */
export interface JobCancellation {
  /** Always `cancelling`. */
  status: string;
  job_id: string;
}

/** One note proposal as the review queue lists it — everything but the note body. */
export interface ProposalSummary {
  id: number;
  note_id: string;
  note_type: string;
  /** `open`, `merged` or `rejected`. */
  state: string;
  branch: string;
  reference: string;
  actor: string;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string;
  reason: string;
}

/** One further file the submission would write beside its subject note. */
export interface ProposalFile {
  path: string;
  content: string;
}

/**
 * A proposal with the bytes it would land, which is what a reviewer signs off on.
 *
 * `dependencies` is the rest of the submission — the `compound` note a `job-result` cites, say.
 * The backend calls a note and its links one reviewable unit, so a view that shows `content`
 * alone invites approving a link whose far end nobody saw.
 */
export interface ProposalDetail extends ProposalSummary {
  content: string;
  dependencies?: ProposalFile[];
  session_id?: string;
  correlation_id?: string;
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

export const api = {
  async health(): Promise<boolean> {
    try {
      await request<{ status: string }>('/healthz', async () => null);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Start a server session, optionally as a narrowed agent (`data/profiles/*.yaml`).
   *
   * The body is omitted entirely when no profile is chosen rather than sent as `{}`. `SessionIn`
   * defaults every field so both are accepted, but this route is the one every conversation
   * depends on and it has always been called bodyless — adding a body (and with it a
   * content-type) unconditionally would change a working request for callers who asked for
   * nothing.
   */
  createSession(getToken: TokenGetter, profile?: string): Promise<{ session_id: string }> {
    return request<{ session_id: string }>('/sessions', getToken, {
      method: 'POST',
      ...(profile ? { body: JSON.stringify({ profile }) } : {}),
    });
  },

  /** The narrowed agents this deployment offers. `[]` from a backend without the route, so the
   *  picker simply offers nothing rather than blocking session creation. */
  async listProfiles(getToken: TokenGetter): Promise<string[]> {
    try {
      return await request<string[]>('/profiles', getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return [];
      throw err;
    }
  },

  /** The caller's sessions. Returns `[]` if the backend predates this endpoint (404) or has
   *  nothing durable to list, so the sidebar simply stays local-only. */
  async listSessions(getToken: TokenGetter): Promise<SessionSummary[]> {
    try {
      return await request<SessionSummary[]>('/sessions', getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return [];
      throw err;
    }
  },

  /** A session's transcript. Same graceful degradation as `listSessions`: a backend without this
   *  route, or a session whose history is gone, yields an empty transcript rather than an error. */
  async getMessages(sessionId: string, getToken: TokenGetter): Promise<TranscriptMessage[]> {
    try {
      return await request<TranscriptMessage[]>(`/sessions/${sessionId}/messages`, getToken);
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
    return request<AttachmentSummary>(`/sessions/${sessionId}/attachments`, getToken, {
      method: 'POST',
      body: form,
    });
  },

  listApprovals(getToken: TokenGetter): Promise<PendingApproval[]> {
    return request<PendingApproval[]>('/approvals', getToken);
  },

  /** Deliver the human Yes/No to a durable approval hold. Deliberately an HTTP route on the
   *  backend and not an agent tool — the agent proposes, a human signs off. */
  decideApproval(approvalId: string, approved: boolean, getToken: TokenGetter): Promise<void> {
    return request<void>(`/approvals/${encodeURIComponent(approvalId)}/decision`, getToken, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    });
  },

  /** Finished durable runs, newest first. Not owner-scoped — that is the deployment's stated
   *  position, not an oversight: `requested_by` is on every row and nothing pretends it is private. */
  listJobs(getToken: TokenGetter): Promise<JobRecordSummary[]> {
    return request<JobRecordSummary[]>('/jobs', getToken);
  },

  /** One run's status and, once it finishes, its result. Answers for jobs whose session was
   *  evicted and whose Temporal history has aged out, which is the whole reason for the route. */
  getJob(jobId: string, getToken: TokenGetter): Promise<DurableJobStatus> {
    return request<DurableJobStatus>(`/jobs/${encodeURIComponent(jobId)}`, getToken);
  },

  /**
   * Ask Temporal to stop a running job. Named for what it does, because the two obvious
   * shorthands would both be lies.
   *
   * It is not the requester's to call: `job_workflow_id` hashes `[connector, job, payload]` and
   * *deliberately excludes the requester*, so two chemists asking for the identical campaign
   * rejoin one run. That run has no owner, cancelling it cancels it for everyone who joined, and
   * the backend therefore gates this on the reviewer role — **403 for anyone else**. The 403 is
   * left as it arrives, carrying the service's own sentence; it is a statement about the caller's
   * role, not a failure to retry.
   *
   * And a 202 is not a stop. Temporal's cancellation is cooperative: the request has been
   * delivered and the workflow unwinds through its own teardown whenever it next can. The
   * resolved value here is a receipt, never an outcome — `getJob` is the only thing that knows
   * how the run ended.
   */
  requestJobCancel(jobId: string, getToken: TokenGetter): Promise<JobCancellation> {
    return request<JobCancellation>(`/jobs/${encodeURIComponent(jobId)}`, getToken, {
      method: 'DELETE',
    });
  },

  /** The PR-gate's queue. `state` filters to `open`/`merged`/`rejected`; empty lists all. A
   *  reviewer sees every proposal, anyone else sees their own — the backend decides which. */
  listProposals(getToken: TokenGetter, state = ''): Promise<ProposalSummary[]> {
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    return request<ProposalSummary[]>(`/proposals${query}`, getToken);
  },

  /** One proposal with the bytes it would write, including the dependencies it links to. */
  getProposal(proposalId: number, getToken: TokenGetter): Promise<ProposalDetail> {
    return request<ProposalDetail>(`/proposals/${proposalId}`, getToken);
  },

  /**
   * Record the human sign-off on a proposal — or the refusal, which is the half that had no
   * record at all before this table existed.
   *
   * `reason` is required on a rejection and the backend 422s an empty one, so the caller must
   * collect it rather than defaulting a sentence nobody wrote. A 409 means someone else already
   * decided this row; it is not the plan gate's 409 and is left unre-kinded, because on this
   * route the correct response is to re-read the queue, not to re-read a plan.
   */
  decideProposal(
    proposalId: number,
    approved: boolean,
    reason: string,
    getToken: TokenGetter,
  ): Promise<void> {
    return request<void>(`/proposals/${proposalId}/decision`, getToken, {
      method: 'POST',
      body: JSON.stringify({ approved, reason }),
    });
  },

  /** The plan a session is proposing, read for the hash that binds a decision to it. */
  getPlan(sessionId: string, getToken: TokenGetter): Promise<PlanStatus> {
    return request<PlanStatus>(`/sessions/${sessionId}/plan`, getToken);
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
      await request<void>(`/sessions/${sessionId}/plan/decision`, getToken, {
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
};
