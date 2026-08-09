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
 * Route list verified against 8fqycwdt8v-oss/Chemclaw3 @ d5ed9e3 (service/app.py).
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
 * Deliberately narrow, and unlike `APPROVAL` it can afford to be: this id is never model-written.
 * `job_workflow_id` mints it as `{connector}-{job}-{16 hex}` from two names declared in a
 * connector's `connector.yaml`, and the orchestrator's child runs append `-{prefix}-{index}` to
 * that. Every part of every one of those is `[A-Za-z0-9_]`, so the class below is already the
 * whole alphabet the backend can produce — copying `APPROVAL`'s percent-escape allowance would
 * buy nothing and give up something. With no `.` and no `%` in the set, a segment that matches
 * this cannot spell `..` or smuggle an encoded separator, so traversal is refused by the shape of
 * the id rather than by a decode step this proxy does not perform.
 *
 * Not `SID`: a job id is not a uuid4 hex and never was. Reusing it would 404 every job at the
 * proxy — the failure mode the approval pattern was widened to fix, arrived at from the other
 * direction.
 */
const JOB = '([A-Za-z0-9_-]{1,128})';

/**
 * Note proposal ids.
 *
 * A database row id: `proposal_id: int` on the handler, monotonic, and the same value
 * `GET /proposals?before_id=` pages backwards through. Digits are the entire alphabet, so anything
 * else is a 422 upstream that this proxy can refuse for free. Capped at 19 digits, where a signed
 * 64-bit row id stops — a longer run of digits is not a row any deployment can hold, so the cap
 * costs nothing and bounds the match.
 *
 * Also not `SID`, for the opposite reason to `JOB`: `SID` is far *wider* than this and would let
 * a non-numeric segment through to a route whose only parameter is an integer.
 */
const PROPOSAL = '([0-9]{1,19})';

export interface Route {
  method: string;
  pattern: RegExp;
  /** Maps the matched groups to the upstream path. */
  target: (m: RegExpMatchArray) => string;
  /** True when the upstream responds with `text/event-stream` and must not be buffered. */
  sse: boolean;
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/api\/healthz$/, target: () => '/healthz', sse: false },
  { method: 'GET', pattern: /^\/api\/readyz$/, target: () => '/readyz', sse: false },

  // Sessions.
  { method: 'POST', pattern: /^\/api\/sessions$/, target: () => '/sessions', sse: false },
  // Added by the companion backend change: list the caller's sessions.
  { method: 'GET', pattern: /^\/api\/sessions$/, target: () => '/sessions', sse: false },
  // Added by the companion backend change: read a transcript back after a reload.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/messages$`),
    target: (m) => `/sessions/${m[1]}/messages`,
    sse: false,
  },
  // The turn stream: SSE over POST, which is why native EventSource is unusable.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/messages$`),
    target: (m) => `/sessions/${m[1]}/messages`,
    sse: true,
  },
  // Async job push-back. Long-lived and legitimately silent for minutes at a time.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/events$`),
    target: (m) => `/sessions/${m[1]}/events`,
    sse: true,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/attachments$`),
    target: (m) => `/sessions/${m[1]}/attachments`,
    sse: false,
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
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/plan/decision$`),
    target: (m) => `/sessions/${m[1]}/plan/decision`,
    sse: false,
  },

  // Durable approval holds (the PR-gate's human sign-off).
  { method: 'GET', pattern: /^\/api\/approvals$/, target: () => '/approvals', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/approvals/${APPROVAL}$`),
    target: (m) => `/approvals/${m[1]}`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/approvals/${APPROVAL}/decision$`),
    target: (m) => `/approvals/${m[1]}/decision`,
    sse: false,
  },

  // Durable runs. `GET /jobs` takes `?text=`/`?connector=` and `GET /proposals` takes
  // `?state=`/`?before_id=`; `index.ts` re-appends the query string after resolution, so neither
  // needs anything here.
  { method: 'GET', pattern: /^\/api\/jobs$/, target: () => '/jobs', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
  },
  // Cancellation. Forwarded, not interpreted: upstream this is reviewer-gated (403 for anyone
  // else, because `job_workflow_id` excludes the requester so a shared run has no owner) and
  // answers 202 for "the cancel was delivered", not "the run stopped". Both are the client's to
  // render honestly — a proxy that swallowed either would be inventing an outcome.
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
  },

  // The PR-gate's review queue. `POST /events/knowledge-merged` lives in the same backend module
  // and is deliberately NOT here: it is a signed git-host webhook that closes proposal rows, so a
  // browser is the one caller that must never reach it.
  { method: 'GET', pattern: /^\/api\/proposals$/, target: () => '/proposals', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/proposals/${PROPOSAL}$`),
    target: (m) => `/proposals/${m[1]}`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/proposals/${PROPOSAL}/decision$`),
    target: (m) => `/proposals/${m[1]}/decision`,
    sse: false,
  },

  // The narrowed agents a session may be started as, so the picker lists what the deployment
  // actually has rather than hardcoding names from files it cannot see.
  { method: 'GET', pattern: /^\/api\/profiles$/, target: () => '/profiles', sse: false },
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
