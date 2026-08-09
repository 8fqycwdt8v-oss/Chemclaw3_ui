/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * Endpoints verified against 8fqycwdt8v-oss/Chemclaw3 @ c46b004, reading
 * `src/chemclaw/api/routes/*.py` and `src/chemclaw/api/schemas.py`. Every route this module calls
 * now exists there: `GET /sessions`, `GET /sessions/{id}/messages`, `GET /approvals`,
 * `GET /approvals/{id}` and `POST /approvals/{id}/decision` all landed after the note in ISSUES.md
 * was written, which is why several of them are richer than the shapes this client used to expect.
 *
 * The 404-degradation on the two session reads is kept anyway. It is no longer "the backend has
 * not built this": it is "this UI is deployed independently of the service and can meet an older
 * one", which is a standing condition rather than a temporary gap.
 */

import { config } from '../env.ts';
import { ApiError, errorFromStatus, readDetail } from './errors.ts';

export type TokenGetter = () => Promise<string | null>;

async function request<T>(path: string, getToken: TokenGetter, init: RequestInit = {}): Promise<T> {
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

/**
 * One of the caller's sessions, as `GET /sessions` lists them.
 *
 * There is deliberately no `title` here, though this interface used to declare one. The service's
 * `SessionSummary` is `{session_id, created_at}` and nothing else — a session is minted before
 * anyone has said anything, so the server has no name for it at creation and never revisits the
 * row. An optional field the server never sends is not forward-compatibility, it is a reader being
 * told a value might arrive when it cannot; the sidebar's `summary.title?.trim() || 'Earlier
 * conversation'` was really an unconditional constant with a plausible-looking guard in front.
 * The title is recovered from the transcript instead — see `App.tsx`.
 */
export interface SessionSummary {
  session_id: string;
  /** ISO-8601, from the durable ownership row. Not the last activity — see ISSUES.md. */
  created_at: string;
}

/**
 * One tool the agent invoked during a turn, as the stored transcript remembers it.
 *
 * `result` is `null` when the pairing is incomplete — a turn that died mid-call, or a call whose
 * result row was pruned. That is a third state, not a failure and not a success: the call ran and
 * how it ended was not recorded. Rendering it either way would claim something the store does not
 * know, so it maps to `unresolved` rather than to `failed`.
 */
export interface TranscriptToolCall {
  tool: string;
  arguments: string;
  result: string | null;
}

export interface TranscriptMessage {
  role: string;
  text: string;
  /**
   * Position in the stored transcript — a stable key without the wire contract exposing a row id.
   * Optional only because an older service omits it; the current one always sends it.
   */
  index?: number;
  /**
   * What the agent *did* during this message, not only what it said.
   *
   * The service always held this (a MAF message carries its own `function_call` contents) and the
   * transcript route used to flatten it away, so a reload turned every answer into bare prose and
   * lost the whole trace. It is served now, and dropping it here would reproduce the same loss one
   * layer further out. Optional for the same reason `index` is.
   */
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

/**
 * One durable Yes/No hold still awaiting a click, as `GET /approvals` lists them.
 *
 * This was an index signature over `unknown` while the endpoint was believed not to exist, which
 * made every field a guess and the whole type unusable for rendering. The service's shape is
 * three required strings, owner-scoped: a hold authorizes a knowledge write, so it is listed and
 * answerable only by the chemist whose turn raised it.
 */
export interface PendingApproval {
  approval_id: string;
  /** What the hold is asking, already phrased for a human. */
  question: string;
  /** The Entra oid of the chemist whose turn raised it — always the caller, given the scoping. */
  requested_by: string;
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

  createSession(getToken: TokenGetter): Promise<{ session_id: string }> {
    return request<{ session_id: string }>('/sessions', getToken, { method: 'POST' });
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

  /**
   * Upload a working file, reporting progress and honouring a cancel.
   *
   * XHR rather than `fetch`, which is the one place in this client that deviates: `fetch` still
   * cannot report upload progress in any shipping browser, and an SOP or a large CSV over a lab
   * VPN is exactly where an indeterminate spinner stops being honest. Everything else here stays
   * on `fetch`.
   */
  async uploadAttachment(
    sessionId: string,
    file: File,
    getToken: TokenGetter,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<AttachmentSummary> {
    const token = await getToken();
    const form = new FormData();
    form.append('file', file);

    return new Promise<AttachmentSummary>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${config.apiBase}/sessions/${sessionId}/attachments`);
      xhr.responseType = 'json';
      xhr.setRequestHeader('accept', 'application/json');
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as AttachmentSummary);
          return;
        }
        const detail =
          typeof xhr.response === 'object' && xhr.response !== null
            ? (xhr.response as { detail?: unknown }).detail
            : undefined;
        reject(errorFromStatus(xhr.status, typeof detail === 'string' ? detail : undefined));
      };
      xhr.onerror = () => reject(new ApiError('network', 'Could not reach the Chemclaw service.'));
      xhr.onabort = () => reject(new ApiError('aborted', 'Upload cancelled.'));

      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  },

  /**
   * The caller's open approval holds — the review queue.
   *
   * Still degrades to `[]` on a 404, but for a different reason than when this was written: the
   * route exists, so a 404 now means an older service rather than an unbuilt one. It keeps
   * throwing everything else, because the inbox has to be able to tell "no holds" from "we could
   * not ask" — a queue that silently reads empty when the query failed is the one failure mode a
   * queue of unsigned approvals must not have.
   */
  async listApprovals(getToken: TokenGetter): Promise<PendingApproval[]> {
    try {
      return await request<PendingApproval[]>('/approvals', getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return [];
      throw err;
    }
  },

  /** Deliver the human Yes/No to a durable approval hold. Deliberately an HTTP route on the
   *  backend and not an agent tool — the agent proposes, a human signs off. */
  decideApproval(approvalId: string, approved: boolean, getToken: TokenGetter): Promise<void> {
    return request<void>(`/approvals/${encodeURIComponent(approvalId)}/decision`, getToken, {
      method: 'POST',
      body: JSON.stringify({ approved }),
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
