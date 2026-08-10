/**
 * Contract drift check: this repo's two mirrors of the backend, against the backend itself.
 *
 *   node scripts/check-openapi.mjs [baseUrl]      # default http://127.0.0.1:8080
 *
 * It exists because the same miss happened three times. `capability_degraded`, `tool_failed` and
 * `job_failed` each reached production absent from `shared/events.ts`, and because `normalizeEvent`
 * drops anything outside its union, each one was *silently* absent: an answer assembled without the
 * safety connector rendered as an ordinary confident answer, and a durable job that failed kept its
 * "runs asynchronously" label for the rest of the conversation. The backend's tests passed. This
 * repo's tests passed. Nothing compared the two, and the third was found only by reading the two
 * checkouts side by side.
 *
 * ## What it can check, and what it cannot
 *
 * **The route surface: checked.** FastAPI publishes every path and method it serves, so the BFF
 * whitelist in `server/routes.ts` can be diffed against it exactly.
 *
 * **The SSE event union: NOT checked against the backend, and this script says so on every run.**
 * The events are Pydantic models the runner serialises onto a `text/event-stream`; they are not the
 * response model of any route, so FastAPI has no reason to put them in `components.schemas` and
 * — unless a deployment references them from a route — does not. This script looks for them,
 * diffs them if they are there, and otherwise prints the gap rather than a pass. **A check that
 * reports success it did not perform is worse than no check**, and the three misses above are what
 * that costs. Closing the gap needs a backend change: expose the union from a route, and the diff
 * below starts running by itself.
 *
 * What it does do for the union meanwhile is the half that needs no backend: it checks this repo
 * against itself, that every member of the `ChemclawEvent` union is one `normalizeEvent` actually
 * admits. That is the exact shape all three production misses took — a type the code knows about
 * and the runtime drops — caught one layer earlier than the wire.
 *
 * ## The two directions are not symmetric, in either section
 *
 * A whitelist entry pointing at a route the backend does not serve is a dead button, and fails this
 * check. A backend route the whitelist omits is usually *deliberate* — `/metrics`,
 * `/events/knowledge-merged` and `/schedules` are excluded on purpose, see `server/routes.ts` — so
 * it is reported and does not fail. Read that list on every run anyway. `/jobs`, `/proposals` and
 * `/profiles` sat in it for months looking like decisions while being real gaps: implemented,
 * tested backend routes this UI simply could not reach, and nothing but reading the list told
 * anyone. They are whitelisted now; the next three will look exactly the same on the way in.
 *
 * The event union is the same shape. Something the backend sends that this repo drops is the bug
 * that happened three times; something mirrored here that the backend does not send is dead code.
 * Only the first fails.
 *
 * Node strips the types off the two `.ts` mirrors natively, which is why this script imports them
 * rather than parsing them: a check that re-implemented the whitelist's matching in a regex could
 * pass while the whitelist itself was broken.
 */

import { readFile } from 'node:fs/promises';
import { ROUTES, resolveRoute } from '../server/routes.ts';
import { normalizeEvent } from '../shared/events.ts';

const base = (process.argv[2] ?? process.env.CHEMCLAW_API_URL ?? 'http://127.0.0.1:8080').replace(
  /\/$/,
  '',
);

let failures = 0;
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  · ${label}${detail ? ` — ${detail}` : ''}`);

console.log(`\nChemclaw3 contract drift check against ${base}\n`);

/* ------------------------------------------------------------------ the schema */

let openapi;
try {
  const res = await fetch(`${base}/openapi.json`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  openapi = await res.json();
} catch (err) {
  // Non-zero: an unreachable backend means the check did not run, and exiting green on that is the
  // failure mode this whole script exists to refuse.
  console.error(`  ✗ GET ${base}/openapi.json — ${err.message}`);
  console.error(`
  The FastAPI service serves this and the BFF deliberately does not proxy it, so point this at the
  service directly — \`uvicorn service.app:create_app --factory --port 8080\` in the Chemclaw3
  repo, or the compose service on the internal network.
`);
  process.exit(1);
}
ok('GET /openapi.json', `${Object.keys(openapi.paths ?? {}).length} paths`);

/* ------------------------------------------------------------ the route surface */

console.log('\nBFF whitelist vs. the routes the backend serves\n');

/**
 * Concrete stand-ins for a path parameter.
 *
 * The whitelist matches regexes against a real incoming path, not templates against templates, so
 * comparing it to `/sessions/{session_id}` means building a path that could actually arrive and
 * asking the whitelist about that. Every sample is tried and one match is enough, so a wrong guess
 * about which alphabet a parameter takes cannot report a live route as dead — and each of these is
 * a real id shape, documented at the pattern it satisfies in `server/routes.ts`.
 */
const SAMPLES = [
  '0123456789abcdef0123456789abcdef', // uuid4 hex, as `POST /sessions` mints a session id
  '12345', // a proposal row id
  'calc-compare_solvents-0123456789abcdef', // a durable job id
  'approval-Suzuki(A)', // a model-authored approval hold id
  '0123456789abcdef'.repeat(4), // a sha256 digest, as a content-addressed ref
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every (method, path template) the backend publishes. */
const backendRoutes = Object.entries(openapi.paths ?? {}).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((method) => HTTP_METHODS.includes(method))
    .map((method) => ({ method: method.toUpperCase(), path })),
);

/**
 * Every concrete path a backend template could produce, over every combination of samples.
 *
 * The combination matters on the two-parameter routes: `/sessions/{id}/tool-results/{ref}` takes a
 * uuid4 hex in the first hole and something quite different in the second, so substituting one
 * sample into both would report a live whitelist entry as dead. Two holes and five samples is
 * twenty-five strings; there is no route here with more holes than that.
 */
const concretePaths = (template) =>
  template
    .split(/(\{[^}]+\})/)
    .reduce(
      (paths, part) =>
        /^\{[^}]+\}$/.test(part)
          ? paths.flatMap((prefix) => SAMPLES.map((sample) => prefix + sample))
          : paths.map((prefix) => prefix + part),
      [''],
    );

// Direction 1: a whitelist entry backed by no route the backend serves. Drift, and it fails —
// the button that reaches it 404s at the service.
//
// Matched by hand rather than through `resolveRoute` because this direction needs to know WHICH
// entry matched, and the resolver only answers "some entry did".
const dead = ROUTES.filter(
  (route) =>
    !backendRoutes.some(
      (backend) =>
        backend.method === route.method &&
        concretePaths(backend.path).some((path) => {
          const match = `/api${path}`.match(route.pattern);
          return match !== null && route.target(match) === path;
        }),
    ),
);
if (dead.length === 0) {
  ok('every whitelisted route exists upstream', `${ROUTES.length} entries`);
} else {
  // Fatal even when the second half of that sentence is the true one: an entry this script cannot
  // show to be live is an entry nobody has checked, which is the state all three misses sat in.
  bad(
    `${dead.length} whitelisted route(s) not backed by anything the backend serves`,
    'each forwards to a 404 — unless no sample id above satisfies its pattern',
  );
  for (const route of dead) console.error(`      ${route.method} ${route.pattern.source}`);
}

// Direction 2: a backend route the whitelist omits. Through `resolveRoute`, because this direction
// is about what the proxy really does with a request — including an entry shadowed by an earlier
// one. Reported, never fatal: the whitelist is deliberately narrower than the service.
const unforwarded = backendRoutes.filter(
  (backend) =>
    !concretePaths(backend.path).some(
      (path) => resolveRoute(backend.method, `/api${path}`)?.path === path,
    ),
);
if (unforwarded.length === 0) {
  ok('the BFF forwards every route the backend serves');
} else {
  note(`${unforwarded.length} backend route(s) the BFF does not forward`, 'informational');
  for (const backend of unforwarded) console.log(`      ${backend.method} ${backend.path}`);
}

/* ------------------------------------------------------------- the event union */

console.log('\nEvent union\n');

/** The `type` discriminator of an event schema. Pydantic writes a `Literal` field as a const, a
 *  one-member enum or a default, depending on its version and settings. */
function typeLiteralOf(schema) {
  const property = schema?.properties?.type;
  if (!property) return null;
  if (typeof property.const === 'string') return property.const;
  if (Array.isArray(property.enum) && property.enum.length === 1) return String(property.enum[0]);
  if (typeof property.default === 'string') return property.default;
  return null;
}

/**
 * The `type` literals declared by the members of `ChemclawEvent`, read off the source.
 *
 * Read rather than imported: the union is a type, erased at runtime, and the runtime set it is
 * supposed to agree with (`EVENT_TYPES`) is module-private. That disagreement is the seam this
 * checks, so it may not be closed by asking one of the two halves what the other says.
 */
async function unionMembers() {
  const source = await readFile(new URL('../shared/events.ts', import.meta.url), 'utf8');
  return [...source.matchAll(/^\s*type:\s*'([a-z_]+)';/gm)].map((m) => m[1]);
}

const declared = await unionMembers();

/**
 * Event models the backend publishes, if any.
 *
 * A schema counts as an event when it is named `…Event` *and* carries a literal `type` — both,
 * because a match on either alone would let some unrelated model into the diff and produce a
 * confident verdict about a contract this is not looking at. The expected finding is none.
 */
const published = Object.entries(openapi.components?.schemas ?? {})
  .filter(([name]) => name.endsWith('Event'))
  .map(([name, schema]) => ({ name, type: typeLiteralOf(schema) }))
  .filter((schema) => schema.type !== null);

if (published.length === 0) {
  note('the backend does not publish its SSE event schemas in OpenAPI', 'NOT CHECKED');
  console.log(
    '      The events are streamed rather than returned by any route, so FastAPI has nothing\n' +
      '      to document and this half of the drift cannot be verified from here. Until the\n' +
      '      backend exposes the union from a route, `shared/events.ts` is kept in step by\n' +
      '      reading `src/chemclaw/api/events.py` — which is how all three misses got in.',
  );
} else {
  const dropped = published.filter((schema) => normalizeEvent({ type: schema.type }) === null);
  if (dropped.length === 0) {
    ok('normalizeEvent admits every event the backend publishes', `${published.length} events`);
  } else {
    bad(`${dropped.length} published event(s) shared/events.ts drops on the floor`);
    for (const schema of dropped) console.error(`      ${schema.type}  (${schema.name})`);
  }

  // The other direction, and it is informational for the same reason the unforwarded routes are —
  // plus one this section cannot get around: FastAPI publishes a model only where a route
  // references it, so a *partial* publication is indistinguishable from a shrunk union. A mirrored
  // event the backend no longer sends is dead code; the direction above is a user-visible bug.
  const backendTypes = new Set(published.map((schema) => schema.type));
  const stale = declared.filter((type) => !backendTypes.has(type));
  if (stale.length === 0) {
    ok('every mirrored event appears in what the backend publishes');
  } else {
    note(
      `${stale.length} mirrored event(s) absent from what the backend publishes`,
      'informational: the publication may simply be partial',
    );
    for (const type of stale) console.log(`      ${type}`);
  }
}

// The half of the union check that needs no backend at all: a declared member the runtime drops.
if (declared.length === 0) {
  bad('found no event interfaces in shared/events.ts', 'this script can no longer read the mirror');
} else {
  const unhandled = declared.filter((type) => normalizeEvent({ type }) === null);
  if (unhandled.length === 0) {
    ok(
      'normalizeEvent admits every member of the ChemclawEvent union',
      `${declared.length} members`,
    );
  } else {
    bad(`${unhandled.length} union member(s) normalizeEvent silently drops`);
    for (const type of unhandled) console.error(`      ${type}`);
  }
}

console.log(
  failures === 0
    ? '\nNo drift found in what could be checked.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
