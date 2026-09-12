/**
 * What a running ChemClaw3 UI must serve, asserted over HTTP against whatever is listening.
 *
 *   node scripts/check-serving.mjs [baseUrl]      # default http://127.0.0.1:8080
 *
 * Deliberately knows nothing about *how* the thing under test was started. `.github`'s container
 * job runs an image it just built with Docker; the Jenkins pipeline runs one built by buildah,
 * podman or kaniko and possibly pulled back out of a registry. Those are different artifacts on
 * purpose — the Jenkinsfile argues at length that the one that ships is the one worth checking —
 * but they owe the same four promises, and before this script each pipeline wrote its own copy of
 * them in its own shell dialect. Two copies of an assertion are two assertions, and they drift.
 *
 * The four, and why each is here rather than in a unit test:
 *
 * 1. `/healthz` — that the process came up at all inside its image, with its real entrypoint.
 * 2. `/config.js` renders `__CHEMCLAW_CONFIG__` — one image, any tenant. The config is rendered
 *    from the environment at request time, so an image that baked it in would pass every test in
 *    `tests/` and serve the wrong tenant's settings.
 * 3. SPA fallback on a client-side route — so a deep link, a `/c/:id` or the MSAL redirect URI
 *    resolves instead of 404-ing at the static server.
 * 4. `/api/metrics` is 404 — the proxy whitelist. This is the only thing standing between the
 *    browser and every backend route the BFF could otherwise forward, and it is a property of the
 *    route table *as deployed*.
 */

const base = (process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(
  /\/$/,
  '',
);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 30_000);

let failures = 0;
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log(`\nWhat ${base} serves\n`);

/* ── wait for it to come up ───────────────────────────────────────────────── */

const deadline = Date.now() + READY_TIMEOUT_MS;
let up = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${base}/healthz`);
    if (res.ok) {
      up = true;
      break;
    }
  } catch {
    /* not listening yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!up) {
  console.error(`  ✗ ${base}/healthz never answered within ${READY_TIMEOUT_MS} ms\n`);
  process.exit(1);
}

/* ── 1. health ────────────────────────────────────────────────────────────── */
{
  const res = await fetch(`${base}/healthz`);
  const body = await res.text();
  if (res.ok && body.includes('"ok"')) ok('GET /healthz', body.trim());
  else bad('GET /healthz', `status ${res.status}, body ${body.trim()}`);
}

/* ── 2. runtime config ────────────────────────────────────────────────────── */
{
  const res = await fetch(`${base}/config.js`);
  const body = await res.text();
  if (res.ok && body.includes('__CHEMCLAW_CONFIG__'))
    ok('GET /config.js renders __CHEMCLAW_CONFIG__');
  else bad('GET /config.js', `status ${res.status} and no __CHEMCLAW_CONFIG__ in the body`);
}

/* ── 3. SPA fallback ──────────────────────────────────────────────────────── */
{
  const res = await fetch(`${base}/auth/callback`);
  if (res.status === 200) ok('SPA fallback serves /auth/callback');
  else bad('SPA fallback', `GET /auth/callback answered ${res.status}, expected 200`);
}

/* ── 4. the proxy whitelist refuses what the UI never calls ───────────────── */
{
  const res = await fetch(`${base}/api/metrics`);
  if (res.status === 404) ok('un-whitelisted /api/metrics is refused', '404');
  else bad('the proxy whitelist', `GET /api/metrics answered ${res.status}, expected 404`);
}

console.log('');
if (failures > 0) {
  console.error(`  ${failures} serving failure${failures === 1 ? '' : 's'}.\n`);
  process.exit(1);
}
