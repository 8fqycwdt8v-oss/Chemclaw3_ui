/**
 * The upstream route whitelist. The BFF never forwards `/api/*` wholesale: the service exposes
 * routes the browser must not reach (`/metrics`, `/schedules`, ...), so an open proxy would widen
 * any bug here to the whole backend.
 *
 * Id patterns are per shape. Narrow ones (session ids are 32 lowercase hex) are also structural
 * traversal protection; wide ones are checked by `isTraversal`.
 */

import { CALC_ARTIFACT_REF } from '../shared/exhibitConstants.ts';

const SID = '([0-9a-f]{32})';

/**
 * Knowledge-note ids: `note-{slug}`, where the slug may be model-written, so the set is everything
 * `encodeURIComponent` emits (including `!~*'()` and `%`). The segment is forwarded still-encoded;
 * `isTraversal` refuses anything a normalising hop would decode into a traversal. The length cap
 * applies to the encoded segment (non-ASCII costs three characters per byte), hence 512.
 */
const NOTE = "([A-Za-z0-9._:~!*'()%-]{1,512})";

/**
 * Durable job ids: may embed a Temporal workflow id this repo does not own, so `NOTE`'s set and
 * cap. Used upstream as a lookup key, never a path.
 */
const JOB = "([A-Za-z0-9._:~!*'()%-]{1,512})";

/**
 * A held-open question's id: `await-<hash>` or `<workflow id>:await:<round>`, so `JOB`'s set; cap
 * as `NOTE`'s (colons triple when encoded).
 */
const PENDING = "([A-Za-z0-9._:~!*'()%-]{1,512})";

/** A stored tool result's ref: a SHA-256 hex digest, 64 lowercase hex. */
const RESULT_REF = '([0-9a-f]{64})';

/**
 * An experiment design id: `design-` plus twelve lowercase hex. Revision query parameters are
 * forwarded untouched for the service to validate (the client sends integers).
 */
const DESIGN = '(design-[0-9a-f]{12})';

/**
 * A skill name (also its store key). The service only refuses `/`, a leading `.`, whitespace and
 * non-printables, so the set is `NOTE`'s; the encoded cap is wider because one character can cost
 * twelve encoded.
 */
const SKILL = "([A-Za-z0-9._:~!*'()%-]{1,1024})";

/** A ticket in a session's line: a `bigint` identity, digits only. */
const TICKET = '([0-9]{1,19})';

/**
 * A session member's actor id (an Entra `oid`, `dev-user`, or anything the identity provider mints;
 * the service validates nothing more than non-empty). `NOTE`'s set and cap; `isTraversal` applies.
 */
const ACTOR = "([A-Za-z0-9._:~!*'()%-]{1,512})";

/** An artefact id: `xb-` plus sixteen lowercase hex (`EXHIBIT_ID_RE` in `shared/exhibits.ts`). */
const XID = '(xb-[0-9a-f]{16})';

/**
 * Artefact export formats the service renders. SDF and SVG are made in the browser. `html` is safe
 * to proxy because the service sends it as `text/plain` attachment and this process sets its own
 * CSP and `nosniff` (`proxy.ts`).
 */
const FMT = '(md|csv|smi|xyz|html)';

/**
 * Whether a query is exactly one `ref` that is a calc artifact reference; anything else is refused.
 */
function onlyCalcArtifactRef(search: string): boolean {
  // `CALC_ARTIFACT_REF` (in `shared/`, so the client checks a ref against it before it asks) is
  // the one statement of what this query may hold: any key but whitespace and `#`, a strict name.
  let params: URLSearchParams;
  try {
    // `URLSearchParams` decodes leniently; a malformed escape is refused by asking first.
    decodeURIComponent(search.replace(/\+/g, ' '));
    params = new URLSearchParams(search);
  } catch {
    return false;
  }
  const keys = [...params.keys()];
  const ref = params.get('ref');
  return keys.length === 1 && keys[0] === 'ref' && ref !== null && CALC_ARTIFACT_REF.test(ref);
}

/**
 * Whether a query is empty or exactly one valid `session_id` (what `GET /jobs/{id}` takes);
 * anything else is refused.
 */
function onlySessionId(search: string): boolean {
  if (search === '') return true;
  let params: URLSearchParams;
  try {
    decodeURIComponent(search.replace(/\+/g, ' '));
    params = new URLSearchParams(search);
  } catch {
    return false;
  }
  const keys = [...params.keys()];
  const sid = params.get('session_id');
  return (
    keys.length === 1 &&
    keys[0] === 'session_id' &&
    sid !== null &&
    new RegExp(`^${SID}$`).test(sid)
  );
}

/** What a proposal proposes. Two values, because the service's `ProposalKind` has exactly two. */
const KIND = '(skill|profile)';

export interface Route {
  method: string;
  pattern: RegExp;
  /** Maps the matched groups to the upstream path. */
  target: (m: RegExpMatchArray) => string;
  /** True when the upstream responds with `text/event-stream` and must not be buffered. */
  sse: boolean;
  /** True for the one route that carries a file, and so a much larger body cap than the rest. */
  upload?: boolean;
  /**
   * Names for the capture groups in the route's metrics/log template, in order; omitted for one
   * capture (`{id}`).
   */
  labels?: readonly string[];
  /**
   * A validator for the query string, for the routes whose id travels there; absent means the query
   * is forwarded for the service to validate.
   */
  query?: (search: string) => boolean;
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/api\/healthz$/, target: () => '/healthz', sse: false },
  { method: 'GET', pattern: /^\/api\/readyz$/, target: () => '/readyz', sse: false },

  // Sessions.
  { method: 'POST', pattern: /^\/api\/sessions$/, target: () => '/sessions', sse: false },
  // The deployment's agent profiles, so the picker never hardcodes names.
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
  // Delete one conversation on the service, not just in the browser.
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/sessions/${SID}$`),
    target: (m) => `/sessions/${m[1]}`,
    sse: false,
  },
  // Branch a conversation; the service refuses (409) while a turn is in flight.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/fork$`),
    target: (m) => `/sessions/${m[1]}/fork`,
    sse: false,
  },
  // The explicit stop: a disconnect only detaches.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/turn/stop$`),
    target: (m) => `/sessions/${m[1]}/turn/stop`,
    sse: false,
  },
  // Withdraw a message queued in a shared session's line, by ticket.
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/sessions/${SID}/queue/${TICKET}$`),
    target: (m) => `/sessions/${m[1]}/queue/${m[2]}`,
    sse: false,
    labels: ['{id}', '{ticket}'],
  },
  // The session's line and whether a turn is running, polled by an open shared conversation.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/queue$`),
    target: (m) => `/sessions/${m[1]}/queue`,
    sse: false,
  },
  // Reattach to a running turn after `stream_lagged`, or follow another member's; SSE.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/turn/stream$`),
    target: (m) => `/sessions/${m[1]}/turn/stream`,
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
    upload: true,
  },

  // Shared sessions. Sessions others own that the caller was let into (`shared` cannot match
  // `SID`).
  {
    method: 'GET',
    pattern: /^\/api\/sessions\/shared$/,
    target: () => '/sessions/shared',
    sse: false,
  },
  // Who is in a session: its owner and the members that owner admitted. Open to every participant.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/members$`),
    target: (m) => `/sessions/${m[1]}/members`,
    sse: false,
  },
  // Admit somebody — the owner's act alone (403 for a member). Idempotent upstream.
  {
    method: 'PUT',
    pattern: new RegExp(`^/api/sessions/${SID}/members/${ACTOR}$`),
    target: (m) => `/sessions/${m[1]}/members/${m[2]}`,
    labels: ['{id}', '{actor}'],
    sse: false,
  },
  // Remove somebody (the owner), or leave (a member naming themself).
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/sessions/${SID}/members/${ACTOR}$`),
    target: (m) => `/sessions/${m[1]}/members/${m[2]}`,
    labels: ['{id}', '{actor}'],
    sse: false,
  },

  // The untruncated text of one tool result; session-scoped upstream.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/tool-results/${RESULT_REF}$`),
    target: (m) => `/sessions/${m[1]}/tool-results/${m[2]}`,
    labels: ['{id}', '{ref}'],
    sse: false,
  },

  // One knowledge note with provenance and neighbourhood; `hops` is forwarded and clamped by the
  // service.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/notes/${NOTE}$`),
    target: (m) => `/notes/${m[1]}`,
    sse: false,
  },

  // The plan gate: read the plan awaiting a decision (with its hash), then answer it.
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

  // Every undecided plan of the caller's, across conversations (scoped to the caller upstream).
  { method: 'GET', pattern: /^\/api\/plans\/pending$/, target: () => '/plans/pending', sse: false },

  // Questions a workflow is holding open, and the answer that releases one. The service filters to
  // what the caller may answer. (The old `/approvals` routes stay un-whitelisted;
  // `tests/routes.test.ts` pins that.)
  { method: 'GET', pattern: /^\/api\/pending$/, target: () => '/pending', sse: false },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/pending/${PENDING}/answer$`),
    target: (m) => `/pending/${m[1]}/answer`,
    sse: false,
  },

  // Standing-query findings. Reading consumes them, so the client claims once at boot.
  { method: 'GET', pattern: /^\/api\/digests$/, target: () => '/digests', sse: false },

  // The caller's own blocked questions: same destructive mailbox as `/digests`, scoped to the
  // principal.
  { method: 'GET', pattern: /^\/api\/check-ins$/, target: () => '/check-ins', sse: false },

  // The durable-run registry. `DELETE` (cancel) is role-gated upstream; whitelisted because hiding
  // the control is the frontend's job.
  { method: 'GET', pattern: /^\/api\/jobs$/, target: () => '/jobs', sse: false },
  // Only `?session_id=` with a valid session id, which lets a report's `exhibit_id` come back.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    query: onlySessionId,
    sse: false,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/jobs/${JOB}$`),
    target: (m) => `/jobs/${m[1]}`,
    sse: false,
  },

  // Behaviour proposals and the two stored skill tiers. `/skills/org` writes are role-gated
  // upstream; whitelisted for entitled callers.
  { method: 'GET', pattern: /^\/api\/proposals$/, target: () => '/proposals', sse: false },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/proposals/${KIND}/${SKILL}$`),
    target: (m) => `/proposals/${m[1]}/${m[2]}`,
    labels: ['{kind}', '{name}'],
    sse: false,
  },

  { method: 'GET', pattern: /^\/api\/skills\/mine$/, target: () => '/skills/mine', sse: false },
  { method: 'POST', pattern: /^\/api\/skills\/mine$/, target: () => '/skills/mine', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/skills/mine/${SKILL}$`),
    target: (m) => `/skills/mine/${m[1]}`,
    sse: false,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/skills/mine/${SKILL}$`),
    target: (m) => `/skills/mine/${m[1]}`,
    sse: false,
  },

  { method: 'GET', pattern: /^\/api\/skills\/org$/, target: () => '/skills/org', sse: false },
  { method: 'POST', pattern: /^\/api\/skills\/org$/, target: () => '/skills/org', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/skills/org/${SKILL}$`),
    target: (m) => `/skills/org/${m[1]}`,
    sse: false,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/skills/org/${SKILL}$`),
    target: (m) => `/skills/org/${m[1]}`,
    sse: false,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/skills/org/${SKILL}/versions$`),
    target: (m) => `/skills/org/${m[1]}/versions`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/skills/org/${SKILL}/revert$`),
    target: (m) => `/skills/org/${m[1]}/revert`,
    sse: false,
  },

  // Experiment protocols — the one document a human edits. No DELETE: a design is retired by moving
  // its status to `abandoned`. A new revision is POSTed with the `parent_revision` it was written
  // against.
  { method: 'GET', pattern: /^\/api\/protocols$/, target: () => '/protocols', sse: false },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/protocols/${DESIGN}$`),
    target: (m) => `/protocols/${m[1]}`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/protocols/${DESIGN}/revisions$`),
    target: (m) => `/protocols/${m[1]}/revisions`,
    sse: false,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/protocols/${DESIGN}/diff$`),
    target: (m) => `/protocols/${m[1]}/diff`,
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/protocols/${DESIGN}/status$`),
    target: (m) => `/protocols/${m[1]}/status`,
    sse: false,
  },

  // Artefacts: session-scoped upstream (owner or member). No DELETE; revisions are POSTed against a
  // `parent_revision`.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits$`),
    target: (m) => `/sessions/${m[1]}/exhibits`,
    sse: false,
  },
  // A chemist's own create, e.g. pinning a tool result.
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits$`),
    target: (m) => `/sessions/${m[1]}/exhibits`,
    sse: false,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits/${XID}$`),
    target: (m) => `/sessions/${m[1]}/exhibits/${m[2]}`,
    labels: ['{id}', '{xid}'],
    sse: false,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits/${XID}/revisions$`),
    target: (m) => `/sessions/${m[1]}/exhibits/${m[2]}/revisions`,
    labels: ['{id}', '{xid}'],
    sse: false,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits/${XID}/revisions$`),
    target: (m) => `/sessions/${m[1]}/exhibits/${m[2]}/revisions`,
    labels: ['{id}', '{xid}'],
    sse: false,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits/${XID}/diff$`),
    target: (m) => `/sessions/${m[1]}/exhibits/${m[2]}/diff`,
    labels: ['{id}', '{xid}'],
    sse: false,
  },
  // A file download: the service's `Content-Type` and `Content-Disposition` pass through. No
  // request body, so not `upload`.
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SID}/exhibits/${XID}/export\\.${FMT}$`),
    target: (m) => `/sessions/${m[1]}/exhibits/${m[2]}/export.${m[3]}`,
    labels: ['{id}', '{xid}', '{fmt}'],
    sse: false,
  },
  // Every artefact of the caller's, across sessions they own or belong to.
  { method: 'GET', pattern: /^\/api\/exhibits$/, target: () => '/exhibits', sse: false },
  // A calculation by-product's bytes (calc cache is shared, not session-owned); a file like the
  // export above.
  {
    method: 'GET',
    pattern: /^\/api\/calc-artifacts\/content$/,
    target: () => '/calc-artifacts/content',
    query: onlyCalcArtifactRef,
    sse: false,
  },
] as const;

export interface ResolvedRoute {
  path: string;
  sse: boolean;
  upload: boolean;
  /**
   * The route's shape (`/sessions/{id}/messages`), used as the log/metrics label so ids never
   * become series.
   */
  template: string;
}

/**
 * Placeholders for a match's capture groups, so the template is derived from the route's own
 * `target` and cannot drift. Multi-capture routes name their groups (`Route.labels`).
 */
function templateGroups(route: Route): RegExpMatchArray {
  return ['', ...(route.labels ?? ['{id}'])] as unknown as RegExpMatchArray;
}

/**
 * Whether a captured segment would traverse if the next hop decoded it once: a decoded `/` or `\`,
 * `..`, a lone `.`, or a malformed escape. Applied to every capture, including narrow ones that
 * cannot fail it.
 */
function isTraversal(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  return decoded.includes('/') || decoded.includes('\\') || decoded === '..' || decoded === '.';
}

/**
 * Resolve a request to an upstream path, or `null` if not whitelisted. `search` is the raw query,
 * checked only by routes that declare `query`.
 */
export function resolveRoute(method: string, path: string, search = ''): ResolvedRoute | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) {
      if (match.slice(1).some((group) => group !== undefined && isTraversal(group))) {
        return null;
      }
      if (route.query && !route.query(search.replace(/^\?/, ''))) return null;
      return {
        path: route.target(match),
        sse: route.sse,
        upload: route.upload === true,
        template: route.target(templateGroups(route)),
      };
    }
  }
  return null;
}
