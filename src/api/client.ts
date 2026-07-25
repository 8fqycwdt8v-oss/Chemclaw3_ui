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
};
