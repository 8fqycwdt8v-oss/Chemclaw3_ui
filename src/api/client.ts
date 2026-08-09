/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * Endpoints verified against 8fqycwdt8v-oss/Chemclaw3 @ d5ed9e3 (service/app.py). Two of them —
 * `GET /sessions` and `GET /sessions/{id}/messages` — are added by the companion backend change;
 * both degrade to an empty result rather than throwing, so this UI runs against a service that
 * does not have them yet.
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

export interface SessionSummary {
  session_id: string;
  created_at?: string;
  title?: string;
}

export interface TranscriptMessage {
  role: string;
  text: string;
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

  /** Pending approvals. Degrades to `[]` like `listSessions` — the backend's approval workflow
   *  has no HTTP surface yet (see ISSUES.md), so a 404 here is the expected answer, not a fault. */
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
