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
 * Knowledge-note ids.
 *
 * The same argument as `APPROVAL`, from the same cause: a note id is `note-{slug}` where the slug
 * comes from whatever the note is about, and for a compound note that is a name the model wrote.
 * So the set is again exactly what `encodeURIComponent` can emit, and again a raw `/` fails to
 * match because that changes the route's shape rather than its parameter.
 *
 * It gets its own constant rather than sharing `APPROVAL` because the two are the same set for
 * different reasons, and the next time either service tightens or widens its id scheme, only one
 * of these should move.
 */
const NOTE = "([A-Za-z0-9._:~!*'()%-]{1,128})";

/**
 * Durable job ids.
 *
 * Minted by the service and by Temporal rather than by the model, so unlike `APPROVAL` these are
 * not arbitrary in principle — but a connector job's id embeds a workflow id whose shape this
 * repo does not own, and pinning it to a guess is how the approval route spent a release
 * 404-ing every id with a bracket in it. Same closed set, same length cap, same argument: the
 * segment is forwarded still-encoded and the service uses it as a lookup key, never as a path.
 */
const JOB = "([A-Za-z0-9._:~!*'()%-]{1,128})";

/**
 * A stored tool result's ref.
 *
 * Narrower than every other id here, and it can be: the service defines the ref as the SHA-256
 * hex digest of the result text, so 64 lowercase hex characters is the whole set — the same kind
 * of structural traversal protection `SID` gets, for the same reason.
 */
const RESULT_REF = '([0-9a-f]{64})';

export interface Route {
  method: string;
  pattern: RegExp;
  /** Maps the matched groups to the upstream path. */
  target: (m: RegExpMatchArray) => string;
  /** True when the upstream responds with `text/event-stream` and must not be buffered. */
  sse: boolean;
  /** True for the one route that carries a file, and so a much larger body cap than the rest. */
  upload?: boolean;
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/api\/healthz$/, target: () => '/healthz', sse: false },
  { method: 'GET', pattern: /^\/api\/readyz$/, target: () => '/readyz', sse: false },

  // Sessions.
  { method: 'POST', pattern: /^\/api\/sessions$/, target: () => '/sessions', sse: false },
  // The agent profiles `POST /sessions` will accept. Whitelisted because the alternative is a
  // picker with hardcoded names: the service 400s an unknown profile, and the set is a
  // deployment's own, so guessing is how the picker breaks in the tenant nobody tested in.
  { method: 'GET', pattern: /^\/api\/profiles$/, target: () => '/profiles', sse: false },
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
  // The explicit stop. A disconnect only *detaches* from a running turn now
  // (D-2026-08-27-a-disconnect-is-a-detach-not-a-stop in the backend), so pressing Stop is a
  // request of its own rather than a closed socket.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/turn/stop$`),
    target: (m) => `/sessions/${m[1]}/turn/stop`,
    sse: false,
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
    upload: true,
  },

  // The untruncated text of one tool result.
  //
  // `ToolResultEvent.preview` is 200 characters and the service says it will stay that way; this
  // is the other half of that split. Session-scoped upstream, so the ownership check the turn
  // stream already passed covers it too — a ref from someone else's session finds nothing.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/tool-results/${RESULT_REF}$`),
    target: (m) => `/sessions/${m[1]}/tool-results/${m[2]}`,
    sse: false,
  },

  // One knowledge note, with its provenance and its neighbourhood.
  //
  // Whitelisted so a `note-…` citation resolves to the note it cites instead of prefilling a
  // question about it. `hops` rides through as a query parameter; the proxy forwards the query
  // string, and the service clamps it.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/notes/${NOTE}$`),
    target: (m) => `/notes/${m[1]}`,
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

  // The PR-gate review queue.
  //
  // A different mechanism from `/approvals` below, despite the similar shape, and worth not
  // confusing: an approval is a Temporal interaction hold answered mid-turn, a proposal is a
  // knowledge note waiting to enter the graph. The service calls this "the line that makes
  // machine-written knowledge safe". Listing is keyset-paginated (`before_id`) and state-filtered
  // through the query string, which the proxy forwards untouched.
  { method: 'GET', pattern: /^\/api\/proposals$/, target: () => '/proposals', sse: false },
  {
    method: 'GET',
    pattern: /^\/api\/proposals\/([0-9]{1,19})$/,
    target: (m) => `/proposals/${m[1]}`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: /^\/api\/proposals\/([0-9]{1,19})\/decision$/,
    target: (m) => `/proposals/${m[1]}/decision`,
    sse: false,
  },

  // The durable-run registry.
  //
  // Job ids are minted by the service and by Temporal, so they are constrained like an approval
  // id rather than like a session id. `DELETE` is the operator cancel, role-gated upstream; it is
  // whitelisted here anyway, because hiding a control the caller is entitled to use is the
  // frontend's job and refusing to proxy it would break the caller who *is* entitled.
  { method: 'GET', pattern: /^\/api\/jobs$/, target: () => '/jobs', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
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
] as const;

export interface ResolvedRoute {
  path: string;
  sse: boolean;
  upload: boolean;
}

/** Resolve a request to an upstream path, or `null` if it is not whitelisted. */
export function resolveRoute(method: string, path: string): ResolvedRoute | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { path: route.target(match), sse: route.sse, upload: route.upload === true };
  }
  return null;
}
