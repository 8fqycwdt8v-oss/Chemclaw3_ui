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
} as const;
