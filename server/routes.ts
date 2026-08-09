/**
 * The upstream route whitelist.
 *
 * The BFF deliberately does NOT forward `/api/*` wildcard-style to the Chemclaw service. That
 * service sits on an internal network and exposes routes this UI has no business reaching
 * (`/metrics`, `/events/knowledge-merged`, `/schedules`), so an open proxy would widen the blast
 * radius of any bug in this process to the whole backend surface.
 *
 * Session ids are matched as exactly 32 lowercase hex chars (uuid4 hex, which is what
 * `POST /sessions` returns). That validation doubles as traversal protection: a path segment
 * that matches this pattern cannot contain `/`, `.` or an encoded escape.
 *
 * Each route declares the backend path template it targets (`spec`), and
 * `scripts/check-contract.mjs` asserts — in both directions — that this list matches the service's
 * real route table. A backend route that is neither proxied nor named in that script's
 * DELIBERATELY_UNPROXIED list fails the build, so a new upstream surface cannot go unnoticed
 * simply because nobody looked. The header used to claim verification against a commit the
 * backend was hundreds of changes past, which is exactly the failure mode that replaces.
 */

const SID = '([0-9a-f]{32})';

/**
 * Approval hold ids.
 *
 * Wider than `SID` on purpose, and the reason is worth stating: a hold's id is
 * `approval-{interaction_id}`, and `interaction_id` is an argument the *model* supplies to
 * `record_confirmed_answer`. So unlike a session id — which the service mints as uuid4 hex — its
 * characters are not guaranteed. A pattern that only accepted `[A-Za-z0-9._:-]` refused any id
 * the model happened to write with a space, a slash, or a bracket: the trace panel would render
 * the approval and its Approve button would 404 here, never reaching the service.
 *
 * The set is therefore exactly what `encodeURIComponent` can emit: its unreserved characters
 * `A-Za-z0-9-_.!~*'()` plus `%` for the escapes it produces. Note it does NOT escape `!~*'()`,
 * so `approval-Suzuki(A)` arrives literally — a pattern that merely added `%` would still have
 * refused that one. A test pins each case.
 *
 * Widening here is safe in a way it would not be for `SID`: this segment is forwarded
 * still-encoded, and the service uses the decoded value purely as a Temporal workflow-id lookup,
 * never as a filesystem or URL path, so an encoded `/` cannot traverse anything. A *raw* `/`
 * still fails to match, because that would change the route's shape rather than its parameter.
 * The length cap and the closed character set still hold.
 */
const APPROVAL = "([A-Za-z0-9._:~!*'()%-]{1,128})";

/**
 * Durable job ids.
 *
 * `job_workflow_id` hashes `[connector, job, payload]`, so the id is a generated token rather
 * than anything user-authored. The character set is therefore closed and narrow, and unlike
 * `APPROVAL` there is no argument for widening it: nothing about a job id comes from a model.
 */
const JOB = '([A-Za-z0-9._:-]{1,128})';

/** Proposal ids are a Postgres bigint primary key — digits, nothing else. */
const PROPOSAL = '([0-9]{1,19})';

export interface Route {
  method: string;
  pattern: RegExp;
  /** Maps the matched groups to the upstream path. */
  target: (m: RegExpMatchArray) => string;
  /** True when the upstream responds with `text/event-stream` and must not be buffered. */
  sse: boolean;
  /**
   * The backend route this proxies to, in the service's own path-template spelling.
   *
   * Declared rather than derived. `SID` and `APPROVAL` are lossy encodings of `{session_id}` and
   * `{approval_id}` — a checker that tried to reverse a regex back into a template would be
   * guessing, and would break the first time one of these patterns was tightened. Stating the
   * identity makes `scripts/check-contract.mjs` able to verify that every route this BFF exposes
   * still exists upstream, and doubles as documentation of what the regex is for.
   */
  spec: string;
}

export const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/healthz$/,
    target: () => '/healthz',
    sse: false,
    spec: '/healthz',
  },
  {
    method: 'GET',
    pattern: /^\/api\/readyz$/,
    target: () => '/readyz',
    sse: false,
    spec: '/readyz',
  },

  // Sessions.
  {
    method: 'POST',
    pattern: /^\/api\/sessions$/,
    target: () => '/sessions',
    sse: false,
    spec: '/sessions',
  },
  // Added by the companion backend change: list the caller's sessions.
  {
    method: 'GET',
    pattern: /^\/api\/sessions$/,
    target: () => '/sessions',
    sse: false,
    spec: '/sessions',
  },
  // Added by the companion backend change: read a transcript back after a reload.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/messages$`),
    target: (m) => `/sessions/${m[1]}/messages`,
    sse: false,
    spec: '/sessions/{session_id}/messages',
  },
  // The turn stream: SSE over POST, which is why native EventSource is unusable.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/messages$`),
    target: (m) => `/sessions/${m[1]}/messages`,
    sse: true,
    spec: '/sessions/{session_id}/messages',
  },
  // Async job push-back. Long-lived and legitimately silent for minutes at a time.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/events$`),
    target: (m) => `/sessions/${m[1]}/events`,
    sse: true,
    spec: '/sessions/{session_id}/events',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/attachments$`),
    target: (m) => `/sessions/${m[1]}/attachments`,
    sse: false,
    spec: '/sessions/{session_id}/attachments',
  },

  // The harness plan gate: read the plan awaiting a decision — with the hash that binds it — then
  // answer it. Deliberately HTTP routes on the service and not agent tools: until they existed,
  // the agent moved itself out of plan mode through MAF's own `mode_set` and the audit trail
  // recorded that under the asking chemist's identity.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/plan$`),
    target: (m) => `/sessions/${m[1]}/plan`,
    sse: false,
    spec: '/sessions/{session_id}/plan',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/plan/decision$`),
    target: (m) => `/sessions/${m[1]}/plan/decision`,
    sse: false,
    spec: '/sessions/{session_id}/plan/decision',
  },

  // Durable approval holds (the PR-gate's human sign-off).
  {
    method: 'GET',
    pattern: /^\/api\/approvals$/,
    target: () => '/approvals',
    sse: false,
    spec: '/approvals',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/approvals/${APPROVAL}$`),
    target: (m) => `/approvals/${m[1]}`,
    sse: false,
    spec: '/approvals/{approval_id}',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/approvals/${APPROVAL}/decision$`),
    target: (m) => `/approvals/${m[1]}/decision`,
    sse: false,
    spec: '/approvals/{approval_id}/decision',
  },

  // Session profiles: which specialised agent a new conversation talks to. The backend 400s an
  // unknown name, and nothing exposed the list — so a surface had to hardcode names living in
  // files it cannot see.
  {
    method: 'GET',
    pattern: /^\/api\/profiles$/,
    target: () => '/profiles',
    sse: false,
    spec: '/profiles',
  },

  // Durable runs. Deliberately NOT owner-scoped upstream (`find_past_jobs`, the agent tool over
  // the same table, is unscoped for cross-project learning), so the UI filters by `requested_by`
  // rather than pretending the list is private.
  { method: 'GET', pattern: /^\/api\/jobs$/, target: () => '/jobs', sse: false, spec: '/jobs' },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
    spec: '/jobs/{job_id}',
  },
  // Cancellation needs a privileged role and answers 202: the request was delivered, not that the
  // run has stopped. A job's id excludes its requester by design, so a running job has no single
  // owner to authorise stopping it.
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
    spec: '/jobs/{job_id}',
  },

  // The PR-gate's review queue. This is what makes the `note_proposed` event actionable: until
  // now a note was pushed to a branch and that was the end of it as far as this UI was concerned.
  {
    method: 'GET',
    pattern: /^\/api\/proposals$/,
    target: () => '/proposals',
    sse: false,
    spec: '/proposals',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/proposals/${PROPOSAL}$`),
    target: (m) => `/proposals/${m[1]}`,
    sse: false,
    spec: '/proposals/{proposal_id}',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/proposals/${PROPOSAL}/decision$`),
    target: (m) => `/proposals/${m[1]}/decision`,
    sse: false,
    spec: '/proposals/{proposal_id}/decision',
  },
] as const;

export interface ResolvedRoute {
  path: string;
  sse: boolean;
}

/** Resolve a request to an upstream path, or `null` if it is not whitelisted. */
export function resolveRoute(method: string, path: string): ResolvedRoute | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { path: route.target(match), sse: route.sse };
  }
  return null;
}
