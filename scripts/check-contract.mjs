/**
 * Fail the build when this frontend has drifted from the backend it talks to.
 *
 * The drift this exists to catch is not hypothetical — it is what this repo shipped. The backend
 * added `job_failed` and the SPA silently dropped it, so a durable job that failed showed as
 * running forever. It added `answer.verified_by`, `tool_result.note_ids`/`numbers` and
 * `error.code`/`retryable`/`correlation_id`, and every one was discarded by a normalizer that
 * simply did not mention them. None of that is a type error, none of it fails a test, and all of
 * it degrades in the same direction: a qualified answer rendering as a clean one.
 *
 * The comparison is against `shared/backend-contract.json`, generated from a real backend checkout
 * by `scripts/gen_backend_contract.py`. That file is a pinned copy, so it going stale is itself a
 * deliberate act — regenerating it produces a reviewable diff, which is the moment to decide what
 * the frontend should do about the change.
 *
 * Run: `npm run check:contract`
 */

import { readFileSync } from 'node:fs';
import { ROUTES } from '../server/routes.ts';
import { ERROR_CODES, EVENT_FIELDS, EVENT_TYPES } from '../shared/events.ts';
import { CLIENT_ENDPOINTS } from '../src/api/endpoints.ts';

const contract = JSON.parse(readFileSync('shared/backend-contract.json', 'utf8'));
const failures = [];
const fail = (msg) => failures.push(msg);

/**
 * Backend routes the BFF deliberately does NOT expose.
 *
 * Asserted in both directions, like the backend's own probe allowlist: a route that is neither
 * proxied nor named here is an omission to notice, not a decision. That is what stops a new
 * backend surface from going unnoticed simply because nobody looked.
 */
const DELIBERATELY_UNPROXIED = new Set([
  // Operational surfaces. `/metrics` is a scrape target, `/schedules` an operator view; neither
  // belongs on a browser-reachable path, and an open proxy would widen the blast radius of any
  // bug in the BFF to the whole backend.
  'GET /metrics',
  'GET /schedules',
  // A git-host webhook authenticated by an HMAC over the raw body. A browser cannot sign it, and
  // proxying it would put an unsigned path in front of a signed endpoint.
  'POST /events/knowledge-merged',
]);

/**
 * Backend fields the frontend knowingly ignores.
 *
 * Every entry needs a reason. "We do not use it yet" is a reason; the point of the reverse check
 * is that ignoring a field becomes a decision someone wrote down rather than an oversight.
 */
const IGNORED_FIELDS = new Set([
  // The turn stream's `summary` is a bare `dict[str, object]` on the backend, so the wire carries
  // no fixed keys to check. `JobSummary` models it as an index signature for that reason.
]);

// ---------------------------------------------------------------------------
// 1. Routes: everything the BFF proxies still exists upstream.
// ---------------------------------------------------------------------------
const backendRoutes = new Set();
for (const route of contract.routes) {
  for (const method of route.methods) backendRoutes.add(`${method} ${route.path}`);
}

const proxied = new Set();
for (const route of ROUTES) {
  const key = `${route.method} ${route.spec}`;
  proxied.add(key);
  if (!backendRoutes.has(key)) {
    fail(`BFF proxies ${key}, which the backend does not serve (server/routes.ts).`);
  }
}

for (const key of backendRoutes) {
  if (proxied.has(key) || DELIBERATELY_UNPROXIED.has(key)) continue;
  fail(
    `Backend serves ${key}, which the BFF neither proxies nor lists in DELIBERATELY_UNPROXIED. ` +
      `Add a route, or record why it stays internal.`,
  );
}

for (const key of DELIBERATELY_UNPROXIED) {
  if (!backendRoutes.has(key)) {
    fail(`DELIBERATELY_UNPROXIED names ${key}, which the backend no longer serves. Drop it.`);
  }
}

// ---------------------------------------------------------------------------
// 2. Event types: the union we handle is exactly the union the backend emits.
// ---------------------------------------------------------------------------
const backendEvents = new Set(Object.keys(contract.events));
for (const type of backendEvents) {
  if (!EVENT_TYPES.has(type)) {
    fail(
      `Backend emits the "${type}" event and shared/events.ts does not know it, so ` +
        `normalizeEvent drops it silently. This is the job_failed class of bug.`,
    );
  }
}
for (const type of EVENT_TYPES) {
  if (!backendEvents.has(type)) {
    fail(`shared/events.ts handles "${type}", which the backend no longer emits.`);
  }
}

// ---------------------------------------------------------------------------
// 3. Event fields, both directions.
// ---------------------------------------------------------------------------
for (const [type, spec] of Object.entries(contract.events)) {
  const declared = EVENT_FIELDS[type];
  if (!declared) continue; // already reported above
  const backendFields = new Set(Object.keys(spec.fields));

  for (const field of declared) {
    if (!backendFields.has(field)) {
      fail(`shared/events.ts reads ${type}.${field}, which the backend does not send.`);
    }
  }
  for (const field of backendFields) {
    if (declared.includes(field) || IGNORED_FIELDS.has(`${type}.${field}`)) continue;
    fail(
      `Backend sends ${type}.${field} and nothing here reads it. Handle it, or add it to ` +
        `IGNORED_FIELDS with a reason.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. The closed error taxonomy.
// ---------------------------------------------------------------------------
const backendCodes = contract.enums?.ErrorCode ?? [];
const ours = new Set(ERROR_CODES);
for (const code of backendCodes) {
  if (!ours.has(code)) fail(`Backend ErrorCode "${code}" is missing from ERROR_CODES.`);
}
for (const code of ours) {
  if (!backendCodes.includes(code)) fail(`ERROR_CODES has "${code}", which the backend dropped.`);
}

// ---------------------------------------------------------------------------
// 5. Client endpoints resolve through the BFF whitelist.
// ---------------------------------------------------------------------------
for (const { method, spec } of CLIENT_ENDPOINTS) {
  if (!proxied.has(`${method} ${spec}`)) {
    fail(`The client calls ${method} ${spec}, which the BFF whitelist does not expose.`);
  }
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(
    `check-contract: ${failures.length} problem(s) against backend ${contract.backend_revision}:\n`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nRegenerate the fixture with `npm run gen:contract` if the backend has legitimately moved,' +
      '\nthen decide what this frontend should do about each change.',
  );
  process.exit(1);
}

console.log(
  `check-contract: ok — ${ROUTES.length} proxied routes, ${EVENT_TYPES.size} events, ` +
    `${ERROR_CODES.length} error codes match backend ${contract.backend_revision}.`,
);
