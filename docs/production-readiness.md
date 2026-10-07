# Production readiness

What `Chemclaw3_ui` (the SPA and its Node BFF) enforces, bounds and accepts, each with the test
that holds it.

| Word         | Claim                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| **Enforced** | Something is refused or impossible, and a test drives the refusal.     |
| **Bounded**  | Something has a stated ceiling, and the ceiling is asserted.           |
| **Measured** | A number someone ran, with its conditions. Not a promise.              |
| **Accepted** | A real risk nobody has removed; it names who decides and what changes. |

## 1. The gate

- **Enforced.** One gate definition, `scripts/ci.mjs`; both pipelines run `npm run ci` and hold no
  inline assertions of their own. Every script under `scripts/` is reachable from an npm script
  (`tests/gate.test.ts`).
- **Enforced.** The gate leaves `dist/client` free of the dev-auth provider; the dev-auth bundle
  goes to `dist/client-dev-auth`, and the last step asserts the marker is absent from one and
  present in the other (`scripts/assert-no-dev-auth.mjs`, `tests/gate.test.ts`).
- **Bounded.** Not in the gate: `ci:container` (needs a container runtime; `CI_REQUIRE_CONTAINER=1`
  fails instead of skipping), `check:live` (needs a live service) and the full-stack/kind lanes
  (`tests/gate.test.ts`).
- **Accepted.** `check:live` is on no schedule — no pipeline runner can reach a service. `npm run ci`
  does not install a browser; each pipeline installs one before the gate.

## 2. The wire contract with Chemclaw3

- **Enforced.** Against a Chemclaw3 checkout: every whitelisted route is one the service registers;
  every path and JSON body `src/api/` sends is declared, including required fields; every declared
  event survives `normalizeEvent` and every field it reads exists; `ErrorCode`, `RefusalReason` and
  `AnswerCheck` match; every model-shaped response is cast to the model's own name and its fields
  compared (`tests/backendContract.test.ts`). The checkout resolves from `CHEMCLAW3_DIR`, then
  `CHEMCLAW_REPO`, else `../Chemclaw3`, in one resolver (`tests/backendContract.ts`).
- **Enforced.** Every event-union member round-trips through `normalizeEvent` with every field, and
  `EVENT_TYPES` and the schemas are one vocabulary (`tests/eventContract.test.ts`).
- **Enforced.** A wire name this client admits and the service does not declare fails unless argued
  in `AHEAD_OF_BACKEND` / `RETAINED_FOR_ROLLOUT` with a reason, an `ISSUES.md` phrase and an unexpired
  review date. This half needs no checkout (`tests/backendContract.test.ts`).
- **Accepted.** With no checkout the check verifies nothing (a warning; `CHEMCLAW3_REQUIRED=1` fails
  instead). The GitHub lane checks out Chemclaw3 at `CHEMCLAW3_REF` (default `main`); Jenkins runs
  the gate only when `RUN_GATE` is set. Nested element types, non-model responses and what a
  deployment actually serves are outside it. `ISSUES.md` Issue 14.

## 3. Path encoding

- **Enforced.** Every path-segment interpolation that can reach the service is `encodeURIComponent`,
  checked over the tree with the TypeScript compiler (templates, `+` concatenation, hoisted and
  imported constants), plus behavioural tests on the fetch and XHR seams
  (`tests/pathEncoding.test.ts`).
- **Accepted.** Encoded `%00`/`%0A` inside wide-class ids is forwarded; traversal is refused by
  `isTraversal` (`tests/routes.test.ts`). `ISSUES.md` Issue 15.

## 4. The BFF

- **Enforced.** The proxy is a whitelist of method + per-id-shape patterns; anything else 404s
  without reaching the service (`tests/routes.test.ts`).
- **Enforced.** Upstream headers: the bearer passes verbatim; `cookie`, `proxy-authorization`,
  `x-chemclaw-*` and `x-forwarded-*` are dropped (`tests/proxyAuth.test.ts`). Downstream: the
  upstream cannot relax this origin's policy or set cookies/CORS here
  (`tests/securityHeaders.test.ts`).
- **Enforced.** No user-controlled destination: the upstream is `CHEMCLAW_API_URL`, the path comes
  from the matched route, and a path prefix in the URL is refused (`tests/serverConfig.test.ts`).
- **Bounded.** Body size, upstream timeouts, connection and socket pools; a held stream or hung
  request cannot take `/api` down (`tests/serverLimits.test.ts`, `tests/upstreamPool.test.ts`,
  `tests/upstreamHang.test.ts`).
- **Bounded.** `POST /api/client-events` is unauthenticated and rate-limited
  (`CLIENT_EVENTS_RATE_PER_MIN`, 429 + `Retry-After`); a message cannot forge a log line. Metric
  labels are route patterns only (`tests/bffObservability.test.ts`, `tests/clientLogging.test.ts`).
- **Enforced.** `/healthz` is liveness; `/readyz` probes the service, single-flighted. SIGTERM fails
  `/readyz` first, then closes (`tests/bffObservability.test.ts`, `tests/bffLifecycle.test.ts`).
- **Enforced.** Invalid sandbox configuration is refused at boot; the app origin never serves
  `/sandbox/frame`; the sandbox listener serves only that page under a closed CSP
  (`tests/sandboxServer.test.ts`). In a browser the sandboxed page cannot fetch, read app storage,
  navigate or open popups (`e2e/sandbox.spec.ts`). The OpenShift examples match
  (`tests/openshiftManifests.test.ts`).
- **Accepted.** HTML artefact scripts run by default and can still send data over WebRTC.
  `HTML_SCRIPTS_DEFAULT=off` removes it. The product owner decides. `ISSUES.md` Issue 25.

## 5. Identity

- **Enforced.** An unknown `AUTH_MODE` is refused; dev auth on a non-loopback bind needs
  `ALLOW_INSECURE_AUTH` (`tests/serverConfig.test.ts`).
- **Enforced.** Under `msal`, a backend that serves anonymous `/sessions` makes the pod unready
  (`tests/upstreamPosture.test.ts`).
- **Enforced.** The MSAL cache is `sessionStorage` (`tests/msalAuth.test.ts`).
- **Accepted.** The access token is readable by script on this origin, and silent refresh depends on
  third-party cookies. `ISSUES.md` Issue 8.

## 6. One tab holds the job streams

The backend caps event streams per user; a `BroadcastChannel` leader election keeps several tabs
to one set of streams.

- **Enforced.** Simultaneous open, leader close, crash, suspension, split brain and no
  `BroadcastChannel` at all; the leader watches the round-robin merge of every tab's interest and
  rotates when the budget starves a tab (`tests/jobStreamElection.test.ts`).
- **Enforced.** A relayed throttle is a notice, not a budget change
  (`tests/streamThrottleNotice.test.tsx`, `tests/jobStreamRateLimit.test.ts`).
- **Accepted.** A job ending read by a tab that dies before relaying it is recovered late from
  `GET /jobs/{id}` on the next takeover (`tests/jobReconcile.test.ts`). `ISSUES.md` Issue 12.

## 7. Chemistry on the client

- **Enforced.** Only the RDKit worker script gets `'unsafe-eval'` (`RDKIT_WORKER_CSP`); the document
  never does (`tests/workerCsp.test.ts`, `tests/csp.test.ts`, `e2e/rdkit.spec.ts`).
- **Enforced.** A dead or silent worker, or a stack exhaustion, is never reported as "not a molecule"
  (`tests/rdkitWorker.test.ts`).
- **Measured.** The worker takes a 600-character draw from 587 ms of blocked main thread to 0
  (`scripts/measure-rdkit-placement.mjs`, through the Vite dev server).
- **Accepted.** Canonicalisation of a long legal chain can answer "too complex" depending on stack
  state; no consumer keys a molecule by its raw spelling (`tests/rdkitUnavailable.test.tsx`,
  `tests/rdkitTooComplex.test.tsx`). `ISSUES.md` Issue 11.

## 8. Routing and links

- **Enforced.** `/open/:sessionId` is a second-device link for the owner (non-owners get a 404 from
  the service); the legacy `/s/` path explains itself and mints nothing (`tests/routing.test.tsx`).
- **Accepted.** A link copied before a session id rotates points at a session the chemist has left.

## 9. What the browser keeps

- **Bounded.** Persistence has a byte budget; a newer persisted version is refused
  (`tests/persistBudget.test.ts`, `tests/persistQuota.test.ts`, `tests/persistence.test.ts`).
- **Enforced.** Two tabs merge rather than overwrite each other's conversations
  (`tests/persistBudget.test.ts`).
- **Accepted.** No live cross-tab sync of local conversations; another tab's appear on reload.
