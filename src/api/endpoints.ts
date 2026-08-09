/**
 * Every backend endpoint this client calls, declared once.
 *
 * Two jobs. It is the single place to read to know what the SPA actually touches — the paths used
 * to be string literals scattered through `client.ts`, `streamTurn.ts` and `useJobFeed.ts`, so
 * "what does the frontend call?" could only be answered by grepping. And it gives
 * `scripts/check-contract.mjs` something to check: each entry names the backend route template it
 * resolves to, which is asserted against the BFF whitelist and, through it, the real backend.
 *
 * `path` builds the browser-side URL (the BFF's `/api` prefix is added by the caller from
 * `config.apiBase`); `spec` is the backend's own path-template spelling of the same route.
 */

export interface ClientEndpoint {
  method: string;
  /** The backend route template, matching `Route.spec` in `server/routes.ts`. */
  spec: string;
}

export const CLIENT_ENDPOINTS: readonly ClientEndpoint[] = [
  { method: 'GET', spec: '/healthz' },
  { method: 'GET', spec: '/readyz' },
  { method: 'POST', spec: '/sessions' },
  { method: 'GET', spec: '/sessions' },
  { method: 'GET', spec: '/sessions/{session_id}/messages' },
  { method: 'POST', spec: '/sessions/{session_id}/messages' },
  { method: 'GET', spec: '/sessions/{session_id}/events' },
  { method: 'POST', spec: '/sessions/{session_id}/attachments' },
  { method: 'GET', spec: '/sessions/{session_id}/plan' },
  { method: 'POST', spec: '/sessions/{session_id}/plan/decision' },
  { method: 'GET', spec: '/approvals' },
  { method: 'POST', spec: '/approvals/{approval_id}/decision' },
  { method: 'GET', spec: '/profiles' },
  { method: 'GET', spec: '/jobs' },
  { method: 'GET', spec: '/jobs/{job_id}' },
  { method: 'DELETE', spec: '/jobs/{job_id}' },
  { method: 'GET', spec: '/proposals' },
  { method: 'GET', spec: '/proposals/{proposal_id}' },
  { method: 'POST', spec: '/proposals/{proposal_id}/decision' },
] as const;

/** URL builders, so a path is spelled once and always encoded the same way. */
export const paths = {
  healthz: () => '/healthz',
  readyz: () => '/readyz',
  sessions: () => '/sessions',
  // `encodeURIComponent` on every interpolated segment, everywhere. Five of the six call sites
  // used to interpolate the session id raw and relied entirely on the BFF's 32-hex whitelist to
  // make that safe — a correct outcome resting on a guarantee this file cannot see.
  messages: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/messages`,
  events: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/events`,
  attachments: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/attachments`,
  plan: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/plan`,
  planDecision: (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/plan/decision`,
  approvals: () => '/approvals',
  approvalDecision: (approvalId: string) => `/approvals/${encodeURIComponent(approvalId)}/decision`,
  profiles: () => '/profiles',
  jobs: (query: { text?: string; connector?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.text) params.set('text', query.text);
    if (query.connector) params.set('connector', query.connector);
    const qs = params.toString();
    return qs ? `/jobs?${qs}` : '/jobs';
  },
  job: (jobId: string) => `/jobs/${encodeURIComponent(jobId)}`,
  proposals: (query: { state?: string; beforeId?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.state) params.set('state', query.state);
    // Keyset pagination: `before_id` is the last row id seen, not a page number.
    if (query.beforeId) params.set('before_id', String(query.beforeId));
    const qs = params.toString();
    return qs ? `/proposals?${qs}` : '/proposals';
  },
  proposal: (id: number) => `/proposals/${id}`,
  proposalDecision: (id: number) => `/proposals/${id}/decision`,
} as const;
