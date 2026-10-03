# Chemclaw3 UI

A lightweight React chat frontend for [Chemclaw3](https://github.com/8fqycwdt8v-oss/Chemclaw3) — the
FastAPI agent service for pharmaceutical and chemical process R&D.

Two servers that talk to each other:

```
browser ──▶ chemclaw3-ui (Node)  ──▶ chemclaw3 (FastAPI)
            SPA + /api proxy          agent, tools, durable jobs
```

The browser never calls the FastAPI service directly. The UI server proxies `/api` to it
server-to-server, which means **no CORS configuration on the backend** and one place to attach the
bearer token.

## What it does

- **Streams a turn** and renders every event in the service's contract — tokens, plan revisions,
  tool calls, launched jobs, proposed notes, questions, approvals, and the final answer.
- **Shows what the turn is doing, on one line.** A row that mutates rather than a log that grows:
  the plan step it is on, the tool that is out, the durable job it is waiting on, and how long it
  has been going. When the turn settles the same row becomes the summary — `6 steps · 2 tools ·
1 job · 4s` — which is also the disclosure that opens the work.
- **Shows the agent's work** as a rail rather than a list: one line per step, its state in the dot,
  how long it took on the right, and what it returned one disclosure in. A refused call is amber
  and counted as _held_, not as a failure — the gate working is not the gate breaking.
- **Renders structures** from SMILES — the `molecule_smiles` a finished QM job pushes back, plus an
  opt-in toggle on inline SMILES in answers.
- **Ranks what qualifies an answer** rather than stacking it. What stops a reader acting on the
  answer — "needs expert review", "cut short" — keeps a full-width alert above the text; what they
  merely consult — a connector that did not come up, the verifier's score, the methods behind the
  numbers — is a chip that expands in place.
- **Renders what a tool returned in the answer itself**, not only the model's paraphrase of it. The
  turn streams a 200-character preview and a content address; a block under the answer fetches the
  rest when it scrolls into view and draws it as a hazard table, an ICH limit with its guideline, a
  charge table, a grid of structures, a series or a generic table — with the result's own `verdict`
  above the data, because an empty screen is explicitly not a clearance. The renderers are a
  shape-keyed registry (`src/results/`), so the block in the answer and the panel behind it are one
  component in two sizes, and a tool the service adds tomorrow is legible without a release here.
- **Carries an experiment protocol as a document, not as an answer.** `/protocols` lists every
  design; `/protocols/{id}` is the whole thing — the structured request with each field marked
  _stated_ (with the chemist's own words), _inferred_ or _absent_, the conditions, the charge table,
  the procedure, the factors, a run sheet with a CSV, the plate drawn as a plate, the hazards, what
  it rests on, and every revision. It is the one artefact here a human **edits**: a save is a new
  revision posted against the revision it was written on, so two chemists editing one design get a
  refusal and a re-read rather than one of them silently losing their work.
- **Keeps the agent's working documents beside the conversation, as Artefacts.** A report draft,
  a table, a structure panel or a chart the agent writes as part of its answer opens in a resizable
  right-hand pane (tabbed _Artefacts | Index_, the index being the entity rail unchanged), with a
  card in the answer that wrote it. Every artefact is versioned: a chemist corrects a cell or a
  paragraph and that is a new revision attributed to them, bound to the revision it was written on
  — so an edit that meets the agent's newer revision gets the diff and a choice, never a silent
  overwrite. A chart the agent transcribed says so, and a figure no tool returned is listed as
  _unchecked_. Exports come from the service (Markdown, CSV, SMILES) or are made here (SDF from
  RDKit, SVG of the chart); a result block can be pinned as an artefact, an artefact can be handed
  back to the agent with the next message, and `/artefacts` lists them across conversations. The
  code name is `exhibit` because the service already spends "artifact" on calculation by-products;
  a deployment with `agent_exhibits_enabled` off never shows the pane.
- **Resolves citations.** A `note-…` chip opens the note with its provenance and its validity
  window, so a citation in an old answer that points at a superseded note says so.
- **Shows what is waiting on you, across conversations.** `/review` is the plan inbox
  (`GET /plans/pending`) and the held-open questions. It used to carry a third section — the PR
  gate, showing byte for byte what a proposal would commit — and that gate is deleted upstream
  (`D-2026-09-05-the-gate-follows-behaviour-not-knowledge`): knowledge is written directly and
  corrected rather than pre-approved, so there is nothing left to sign. What remains is every
  conversation where the agent has planned work it may not start — including the ones you closed, which is the whole point, since the
  decision card otherwise lives only inside a live turn. An empty list says _which_ emptiness it is
  (no gate in this deployment, nothing waiting, or a scan the service bounded), because the section
  this one replaced spent a release rendering a swallowed 404 as "nothing is waiting on you".
  `/jobs` is the durable run registry — searchable by _why_ each run was launched — with
  cancellation for those entitled.
- **Answers the plan gate.** A plan approval posts to `POST /sessions/{id}/plan/decision`, bound to
  the hash of the plan that was actually shown, behind a confirmation that says the decision is
  irreversible and attributable. It is answered in the conversation rather than in the inbox: a
  plan is approved on the strength of the reasoning that produced it. Against a service that
  predates the plan route, the card falls back to answering in the conversation and says that is
  what it is doing.
- **Shares a conversation without sharing authority** (Chemclaw3 #483). A conversation's owner adds
  a colleague by account id from its people panel; the colleague finds it under _Shared with me_.
  Every message runs as its sender, so once more than one person is in a conversation each question
  says whose it was; a plan is decided only by its author, so the card names the author and
  disables the decision for anybody else; and a member is offered Leave rather than Branch or
  Delete, which stay the owner's. The service enforces every one of those; this UI just does not
  offer what would be refused.
- **Survives a reload** — conversations persist locally and rehydrate from the service.
- **Is ready for Entra SSO** without a rewrite: one env var switches the auth provider.

## Quick start

### Both servers with Docker Compose

Expects the Chemclaw3 checkout as a sibling directory (override with `CHEMCLAW_REPO`):

```sh
# Core talks to one OpenAI-compatible gateway and nothing else (no provider switch, no vendor key)
export CHEMCLAW_LLM_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible /v1 base
export CHEMCLAW_LLM_MODEL=...                               # a model id that gateway serves
export CHEMCLAW_LLM_API_KEY=...                             # the gateway's credential
ALLOW_INSECURE_AUTH=true docker compose up --build
open http://localhost:3000
```

This brings up Postgres/pgvector, Temporal, the Chemclaw3 service, and this UI. Only the UI
publishes a port — on `127.0.0.1` by default — and the backend stays on the internal network.

`ALLOW_INSECURE_AUTH=true` is not optional and is not a default this repository sets for you: the
stack runs `AUTH_MODE=dev`, which requires no sign-in and drives the backend as a shared principal
with every authorization gate open, and the BFF refuses to serve that on a non-loopback bind unless
somebody says it is deliberate. Share it beyond the host with `UI_BIND=0.0.0.0`, and allow it to be
framed (a preview iframe) with `ALLOW_FRAMING=true` — each one a separate decision.

### Against a locally-run backend

Node **22.12 or newer** (`engines` in `package.json`; CI and the Dockerfile run the current 22.x).

```sh
# in the Chemclaw3 repo
uvicorn chemclaw.api.app:create_app --factory --port 8080

# here
npm install
npm run dev            # UI on :5173, proxying through the BFF on :8787
```

`CHEMCLAW_API_URL` points the UI server at the service (default `http://127.0.0.1:8080`).

### Verifying the chain

```sh
npm run smoke                              # against the dev BFF
npm run smoke http://localhost:3000        # against the container
```

This is the check that matters: it asserts stream frames arrive **incrementally**. A stream that is
correct but arrives all at once means something in the chain is buffering, and nothing that only
inspects the final answer will catch it.

## Configuration

The UI server is configured entirely by environment — see [`.env.example`](.env.example). Because
Vite inlines `import.meta.env` at build time, browser-facing settings are served at runtime from
`GET /config.js` instead, so **one image runs in any tenant** with no rebuild.

### What the BFF refuses to start with

`validateConfig` (`server/config.ts`) refuses — logs one `config:` line per problem and exits 1 —
rather than serving a configuration that would look like it works:

- `CHEMCLAW_API_URL` that is not a valid http(s) URL, or that carries a path (use the service root;
  put a prefix in the ingress);
- `AUTH_MODE` other than `dev` or `msal` (a typo never falls back to no sign-in);
- `MAX_MESSAGE_CHARS` that is not a whole number above zero;
- under `AUTH_MODE=msal`: a missing `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` or `API_SCOPE`; an
  `ENTRA_AUTHORITY` that is not a URL, not https, carries a query, fragment or userinfo, or names a
  host CSP would read as syntax;
- `AUTH_MODE=dev` on a non-loopback `BIND_HOST` without `ALLOW_INSECURE_AUTH=true`;
- the HTML sandbox: `SANDBOX_ORIGIN` or `APP_ORIGIN` not a plain http(s) origin, `SANDBOX_ORIGIN`
  without `APP_ORIGIN` or equal to it, an http sandbox under an https app, `SANDBOX_PORT` not a port
  from 1 to 65535 or equal to `PORT`, and `HTML_SCRIPTS_DEFAULT` other than `on`/`off` (see "HTML
  sandbox" below).

A listener that cannot bind (`EADDRINUSE` on `PORT` or `SANDBOX_PORT`) exits 1 with one structured
line naming the address.

### Enabling Entra SSO

The backend enforces Entra when `CHEMCLAW_ENTRA_REQUIRED=true`. Set `AUTH_MODE=msal` here at the
same time, plus:

| Variable          | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| `ENTRA_TENANT_ID` | your tenant GUID                                                              |
| `ENTRA_CLIENT_ID` | **this SPA's** app registration (platform: Single-page application)           |
| `API_SCOPE`       | `api://<api-client-id>/<scope>`, e.g. `.../Chat.Access`                       |
| `REVIEWER_ROLES`  | the backend's `CHEMCLAW_ENTRA_PRIVILEGED_ROLES`, comma-separated              |
| `ENTRA_AUTHORITY` | _optional_ — see below; unset is `https://login.microsoftonline.com/<tenant>` |

Three things account for most "the token looks fine but the API returns 401" incidents:

1. **The scope must be the API's.** Requesting only `openid`/`profile` yields an _ID_ token whose
   `aud` is the SPA client id; the backend checks `aud == CHEMCLAW_ENTRA_AUDIENCE`. Graph's
   `.default` is equally wrong.
2. **The API app registration needs `accessTokenAcceptedVersion: 2`.** The backend pins the issuer
   to `https://login.microsoftonline.com/{tenant}/v2.0`; a v1 token is issued by `sts.windows.net`
   and fails the issuer check.
3. **There is no `CHEMCLAW_ENTRA_CLIENT_ID` on the backend.** Its settings model is
   `extra="forbid"`, so exporting one aborts its startup. The SPA client id belongs only here.

Silent token refresh uses a hidden iframe to `login.microsoftonline.com`, so the CSP is built
conditionally on `AUTH_MODE` (`server/config.ts`). Copying the backend's `connect-src 'self'`
verbatim breaks refresh about an hour after login — a failure that looks like a random logout.

**`ENTRA_AUTHORITY`** points MSAL at an authority other than Entra's public cloud: a sovereign
cloud, or the stand-in tenant in Chemclaw3_mock that the OIDC browser test signs in against. It is
the full authority URL, the same shape as the default (`https://<host>/<tenant>`); the BFF serves it
to the SPA through `/config.js`, MSAL trusts that host (`knownAuthorities`), and the CSP's
`connect-src`, `frame-src` and `form-action` open **its origin instead of**
`login.microsoftonline.com`. Unset, nothing changes — the authority string and the whole CSP header
are byte-for-byte what they were, and `tests/csp.test.ts` pins the header literally. It must be
https: MSAL refuses any other scheme itself (`authority_uri_insecure`, loopback included), so the BFF
refuses one at boot, and unlike `ALLOW_INSECURE_AUTH` there is no flag that relaxes it — a local
test authority is served over https with a throwaway certificate. The service validates issuer and
keys on its own (`CHEMCLAW_ENTRA_ISSUER` / `CHEMCLAW_ENTRA_JWKS_URL`), so a UI pointed at the wrong
authority gets every request refused there; it does not get anyone in.

One response carries a different policy: the RDKit worker's script (`/assets/rdkit.worker-<hash>.js`)
is sent with `RDKIT_WORKER_CSP`, the only place `'unsafe-eval'` appears, because RDKit's Embind glue
needs `Function(...)` and a network-served worker runs under its own response's CSP rather than the
document's. The document never gets it. A proxy or CDN in front of the BFF must pass that header
through per path, not overwrite every response with one policy — or no structure is drawn
(`ISSUES.md` Issue 10).

### HTML sandbox (artefacts)

An `html` artefact is markup and script the agent wrote. It never runs on the app's origin, which
holds the bearer token: it is shown in a frame served by the BFF's **second listener**, on a
different origin, embedded with `sandbox="allow-scripts"` and nothing else (no `allow-same-origin`,
`allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`). That listener serves
`GET /sandbox/frame` and nothing else, under `default-src 'none'; connect-src 'none'` and
`frame-ancestors <APP_ORIGIN>`; the app listener answers that path with a 404. The shell posts
`{type: "ready"}` once its listener is armed and the app sends the artefact only in answer to it;
after that the shell posts back nothing but its height.

**The sandbox is on by default, and so are the artefact's scripts** (owner decisions of 2026-10-03).
The shell puts the artefact in a nested `srcdoc` frame with `allow-scripts` behind a prelude, and
the view always says, briefly, that scripts run isolated and what they can still do, with a link
here. A per-view **Disable scripts** re-renders it with `sandbox=""` (no script at all); the choice
is never persisted — a new revision, another artefact or a reload is back to the default.
**`HTML_SCRIPTS_DEFAULT=off` is the kill switch**: nothing runs until somebody presses **Run
scripts** on one view.

What a running script can still do — an **owner-accepted residual risk**
(`docs/production-readiness.md` §4, `ISSUES.md` Issue 25):

- **Network egress over WebRTC.** CSP does not govern WebRTC — measured under this shell, a scripted
  page sent UDP carrying data it read to an arbitrary host through a STUN candidate, and Chromium
  ignores `webrtc 'block'`. The prelude removes `RTCPeerConnection`, `webkitRTCPeerConnection` and
  `RTCDataChannel` from the page's realm; that is defence in depth and **bypassable** (a nested
  `srcdoc` realm is untouched). So this is not a "no network" sandbox. Browser policy narrows it:
  on Chrome/Edge set **`WebRtcIPHandling=disable_non_proxied_udp`** — which _reduces_ the exposure and
  does not eliminate it (WebRTC can still relay over TURN/TCP through a proxy) — and on Firefox
  **`media.peerconnection.enabled=false`**, which removes WebRTC. `HTML_SCRIPTS_DEFAULT=off` removes
  the script.
- **Clipboard writes** after one click in the frame.
- **Self-navigation, bounded by `frame-src`.** The outer frame can only be navigated to an origin the
  app's CSP lists in `frame-src`: the sandbox origin — and, in MSAL mode, the Entra authority, which
  the hidden-iframe token refresh needs. Measured: self-navigation, meta refresh, anchor clicks and
  `data:`/`blob:` navigations to anywhere else are refused. The nested content frame is bounded by
  the shell's `default-src 'none'`, which lists no frame source at all.

The **Export** menu offers the source as `<title>.html.txt` and says that the file runs its scripts if
opened as a web page: outside the sandbox it is an ordinary page with nothing around it.

| Variable               | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `SANDBOX_ORIGIN`       | the origin the browser reaches the sandbox at, e.g. `https://sandbox.ui.example`                      |
| `APP_ORIGIN`           | the origin the browser reaches the app at, e.g. `https://ui.example` — required with `SANDBOX_ORIGIN` |
| `SANDBOX_PORT`         | the second listener's port (default `8081`), a whole number from 1 to 65535, not `PORT`               |
| `SANDBOX_BIND_HOST`    | its bind address (default: `BIND_HOST`)                                                               |
| `HTML_SCRIPTS_DEFAULT` | `on` (default) or `off` — whether an artefact's script runs without a click                           |

**Both origins are exact.** They are what the _browser_ types, scheme, host and port. The shell
takes content only from `APP_ORIGIN`, so a page opened at any other address — `localhost` for
`127.0.0.1`, a second hostname, a LAN address — shows the artefact as escaped source with a notice
naming both origins (`/config.js` publishes `appOrigin` for exactly that comparison). Unset
`SANDBOX_ORIGIN`, the second listener does not start, `/config.js` serves `sandboxOrigin: ""`, and
HTML artefacts are shown as escaped source with the notice "HTML preview needs a separate sandbox
origin". The CSP gains `frame-src <SANDBOX_ORIGIN>` only when the sandbox is on.

The BFF **refuses to start** when `SANDBOX_ORIGIN` or `APP_ORIGIN` is not a plain http(s) origin
(no path, query or userinfo), when `SANDBOX_ORIGIN` is set without `APP_ORIGIN` or equals it, when
the sandbox is http under an https app (mixed content), when `SANDBOX_PORT` is not a port or is
`PORT`, and when `HTML_SCRIPTS_DEFAULT` is anything but `on`/`off`. **`ALLOW_FRAMING=true` turns the
sandbox off** rather than refusing — a framed app cannot frame the sandbox, whose `frame-ancestors`
names `APP_ORIGIN` alone while the browser checks every ancestor — and the HTML is shown as source.
Either way **one startup line says whether the sandbox is on and why** (`html sandbox on: …` /
`html sandbox off: …`).

Where it is on, and at which addresses:

| How you run it                 | App                            | Sandbox                                                        |
| ------------------------------ | ------------------------------ | -------------------------------------------------------------- |
| `docker compose up`            | `http://localhost:3000`        | `http://localhost:3001`                                        |
| `npm run dev`                  | `http://127.0.0.1:5173` (Vite) | `http://127.0.0.1:8788`                                        |
| the browser suite              | `http://127.0.0.1:4321`        | `http://127.0.0.1:4323` (and the kill switch on `4324`/`4325`) |
| kind (Chemclaw3 `deploy/kind`) | `http://127.0.0.1:15173`       | `http://sandbox.localhost:15174`                               |
| `start.sh` (hosted)            | the platform's                 | **off** — see below                                            |

**On a LAN**, compose publishes on loopback unless `UI_BIND=0.0.0.0`; a colleague reaching
`http://<host>:3000` is then at a different origin from `APP_ORIGIN`, so set both to what they type —
`APP_ORIGIN=http://<host>:3000 SANDBOX_ORIGIN=http://<host>:3001` — and reach it only there.

**`start.sh` leaves the sandbox off**, deliberately. It is what a hosted preview (Replit) runs, and
nothing reliable says where the browser would reach a _second_ listener: the platform publishes its
public hostname (`REPLIT_DEV_DOMAIN`), but a second external port is a `.replit` `[[ports]]` mapping
this repository does not ship (and a published deployment exposes one port), and guessing
`localhost` would frame the _viewer's_ own machine and post the artefact to whatever runs there. Set
`SANDBOX_ORIGIN`/`APP_ORIGIN`/`SANDBOX_PORT` yourself once a second host or port is routed, or HTML
artefacts are shown as source.

**Probes.** `/healthz` (liveness) and `/readyz` (readiness) are on the **app** port; the sandbox port
has one page, so `/sandbox/frame` is its probe.

**In a deployment the sandbox needs a host of its own.** On OpenShift — example manifests in
[`deploy/openshift/`](deploy/openshift/README.md), held to `server/config.ts` by
`tests/openshiftManifests.test.ts`:

- a **second container port** (`SANDBOX_PORT`) and a **Service port named `sandbox`**;
- a **separate Route with its own host**, edge TLS with `insecureEdgeTerminationPolicy: Redirect`
  (an https app cannot frame an http sandbox), annotated
  `haproxy.router.openshift.io/disable_cookies: "true"` so the router's affinity cookie is not the one
  cookie the sandbox origin ever sets;
- **no oauth-proxy or SSO in front of the sandbox host** — the browser loads the frame with no
  credential;
- **proxies pass the sandbox page's CSP through untouched** and add neither `X-Frame-Options` nor the
  app's CSP to it, or the frame is refused;
- prefer a host under a **separate registrable domain** from the app's, so the two are different
  _sites_ and not only different origins. A different port on the same host is a different origin,
  which is all the frame strictly needs and what local dev and compose use; it is the same site,
  so the BFF warns when the two share a non-loopback hostname.

## Layout

```
server/     the BFF — route whitelist, streaming proxy, static host, /config.js,
            the access log + /metrics + /readyz, and the browser's log sink
src/        the SPA — api/ auth/ state/ components/
  components/ui/    primitives (button, sheet, alert-dialog, …) on Radix + cva
  components/chem/  composites built from them (StatusDot, ConfirmDialog, …)
  results/          the tool-result renderers, keyed on payload shape, and their registry
shared/     the contracts mirrored by hand from the service — events.ts (the SSE union,
            from api/events.py) and protocols.ts (the experiment-design schemas)
scripts/    the gate (ci.mjs) and its checks, dev launcher, server bundler, smoke test
e2e/        Playwright specs and the SSE fixture service
public/     theme boot script, favicon — served as-is by the BFF
deploy/     example OpenShift manifests (Deployment, Service, the app and sandbox Routes) — not a chart
docs/       the production-readiness record, the dependency record, and concept studies — what the chemistry
            surface is for, and what it still is not
```

Three files carry most of the difficulty and are commented accordingly:

- **`src/index.css`** — the design tokens. The palette is cool near-neutrals at hue 264 with the
  chroma spent on semantics (258 brand, 158 ok, 72 warn, 22 danger), and `npm run check:contrast` is
  what proves each pair rather than the eye. There is one trap worth knowing before you add a
  theme-dependent token. **`@theme` cannot be nested to express a theme.** Tailwind v4 merges every
  `@theme` block into one map regardless of the at-rule around it, hoists the first into `:root` and
  deletes the rest, so last write wins unconditionally. This file used to carry a second `@theme`
  inside `@media (prefers-color-scheme: dark)`; it compiled to a single `:root` holding the _dark_
  values and no media query at all, and the app was dark in both OS modes. Anything theme-dependent
  is a plain custom property, and `@theme inline` maps the utility names onto it.

- **`server/proxy.ts`** — every SSE trap. Chiefly: it forces `accept-encoding: identity` (a
  compressed event stream buffers until the compressor's window fills), and it destroys the upstream
  request when the client disconnects. That last line used to be what made **Stop** work, and no
  longer is. `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop` split the two meanings the closed
  socket carried: a disconnect now only **detaches** — the turn runs to completion on the service's
  own pump task, and its answer lands in the transcript whether anyone is watching or not — while
  cancelling is a request, `POST /sessions/{id}/turn/stop`. So Stop is two acts in order
  (`stopStreaming` → `api.stopTurn`, then abort the fetch), and propagating the disconnect is still
  worth doing for a different reason: it tells the service its reader is gone, so events are
  discarded rather than buffered for nobody, and it frees this process's upstream socket.
- **`src/components/MessageList.tsx`** — `Bubble` is memoised because `updateAssistant` replaces
  the messages array every animation frame while returning the same object for messages it did not
  touch. Never give anything on this path a custom `areEqual`: one forgotten field and a streaming
  answer freezes mid-sentence, and no unit test catches it.

- **`src/state/chatStore.ts`** — the store keeps `streamedText` and `finalText` apart because
  `answer.text` is the _full concatenation_ of every token. Any code path that combined them would
  render the whole answer twice. There is deliberately none.

## Observability

Error _handling_ here is careful; error _reporting_ used to be absent — every failure this UI knew
about died in the browser. Four things close that, and each is checked by a test.

**One reference, on every turn.** The service mints a correlation id per turn and stamps it on
every JSON log record it writes. This app reads it back — from the `X-Chemclaw-Correlation-Id`
response header, from a `correlation_id` in an error body, and from any stream frame that carries
one (so a `turn_started` the service may start sending is picked up with no change on either side).
It reaches three places: every error banner (`… (reference abc123)`), the trace panel's footer on a
turn that **succeeded**, and the crash screen. It is deliberately never _sent_: the BFF strips
`x-chemclaw-*` request headers, and the service has no reader for one.

**A client-side record.** `src/lib/logger.ts` keeps the last 200 entries in memory and batches them
to `POST /api/client-events`, which the **BFF logs itself** — the Chemclaw service has no such
route. Verbosity is `CLIENT_LOG_LEVEL` (runtime, through `/config.js`), and `?debug=1` raises one
browser without a redeploy. `main.tsx` installs `unhandledrejection` and `error` listeners, which
did not exist: an unhandled rejection anywhere in the app used to be invisible.

**The BFF's own traffic.** One JSON access line per response — method, route _pattern_, status,
duration, bytes, upstream duration, correlation id — plus `GET /metrics` (request count, duration
histogram, in-flight, upstream errors). Every label is bounded: the route pattern is
`/api/sessions/{id}/messages`, never the path, because a per-session label mints a time series per
conversation, and `/metrics` is unauthenticated like every other one in this family. _Per response_
includes the ones nobody waited for: an abandoned SSE stream books `status 499` (`aborted: true`
beside it) and releases the in-flight gauge, which is what the bookkeeping ran on `finish` and
therefore did not do.

**A bound on what the browser may write here.** `POST /api/client-events` is unauthenticated by
construction — the page that posts is served before sign-in — so the pod takes at most 600 batches
a minute and answers the rest with a `429` and a `Retry-After` the browser's sink waits out. That
sink backs off and **recovers**; it used to disable itself for the life of the page after three
non-2xx replies, so one rolling restart silenced a chemist's browser for the rest of the session.

**Readiness that means something.** `GET /readyz` probes the service's own `/readyz` (cached a few
seconds, and single-flighted — 40 concurrent probes cost one upstream call, not 40). `GET /healthz` stays a literal `{"status":"ok"}` and stays what the container
`HEALTHCHECK` reads, deliberately: it is liveness, and restarting this container because the
_backend_ died would remove the one process still able to explain the outage. Point a readiness
probe or a load balancer at `/readyz`.

## Testing

```sh
npm run ci             # the whole gate, in order — what both pipelines run
npm run ci -- --list   # the steps, and why each one is there
npm run ci -- bundle   # one step by name
npm run ci:container   # build the image and assert it serves (skips without Docker)
npm run ci:all         # both halves, locally
```

There is **one** gate definition, `scripts/ci.mjs`, and neither pipeline is allowed to hold a
second edition of it. Assertions that used to be inline shell in `.github/workflows/ci.yml` — the
`/config.js` reference, the MSAL entry-chunk probe, running `dist/server.js` with no
`node_modules`, and the container's four `curl`s — are named npm scripts now, so a contributor can
run them without copy-pasting YAML. `tests/gate.test.ts` fails if a step names a script that does
not exist, if a workflow step is anything but an install or a named script, if either pipeline runs
`node` on anything but a file under `scripts/`, if the Jenkinsfile's shell grows one of the
assertion spellings, or if any script under `scripts/` is reachable from no composer — that last
one by shape rather than by the `check:` prefix, so a `verify-*` script is held to it too.

The gate leaves `dist/client` as a **production** bundle. The browser suite needs one built with
`ALLOW_DEV_AUTH=true`, and that build goes to `dist/client-dev-auth`: it used to be written over
`dist/client` with nothing rebuilding it, so `npm run ci && npm start` served a bundle that can
hand out unauthenticated sessions. The gate's last step asserts the production directory is clean,
which is the half that stops it coming back.

The individual steps, for when you want one:

```sh
npm test                # vitest — store, stream parsing, route whitelist, component contracts
npm run typecheck
npm run lint            # eslint — react-hooks/exhaustive-deps above all, plus jsx-a11y
npm run check:audit     # npm audit over the production closure only — see the workflow comment
npm run check:contrast  # WCAG ratios for every token pair the UI composes, both themes
npm run check:bundle    # /config.js survives bundling; MSAL stays out of the entry chunk
npm run check:standalone# dist/server.js runs with no node_modules, as the image expects
npm run check:no-dev-auth
npm run check:serving   # the four promises a running UI makes, against any base URL
npm run test:e2e        # Playwright — layout, focus, keyboard, theme, mobile drawer
npm run test:e2e:oidc-mock  # real MSAL sign-in against Chemclaw3_mock's tenant (CI's oidc-mock job)
```

`npm run smoke` and `npm run check:openapi` are deliberately **not** in the gate: both need a live
Chemclaw3 service and both exit non-zero when they cannot reach one, which is the honest behaviour
for a check whose whole argument is that reporting a pass it did not perform is worse than nothing.
They are `npm run check:live`, which is where to run them once a service is up.

**`check:live` is operator-run, and no pipeline calls it.** That is the whole of its status: it
gives the two scripts a name a person can type, and it does not put them on any schedule — a push
runner has no service to point them at. `tests/gate.test.ts` asserts both halves, the second by
failing if either pipeline starts naming it, so wiring it in means coming back to this paragraph.

**The wire contract is checked against the backend's source, in the gate.**
`tests/backendContract.test.ts` reads a `Chemclaw3` checkout — `CHEMCLAW3_DIR`, then `CHEMCLAW_REPO`,
and only where none of those is set, `../Chemclaw3`, which is the one resolution every
cross-repository reader in the suite asks for —
and compares five things this repo consumes against what that repo declares: the BFF's route
whitelist, every path and JSON body `src/api/` sends, every event `normalizeEvent` admits, every
field it reads off one, and the three closed sets it mirrors (`ErrorCode`, `RefusalReason`,
`AnswerCheck`). It needs no service, no port and no credential, which is the whole point: the check
that needed a running one has never been run by a pipeline. **With no checkout it checks nothing and
says so** — a warning naming what this run is therefore not evidence about, and `CHEMCLAW3_REQUIRED=1`
turns that into a failure. What it cannot see is what a _deployment_ renders rather than declares,
and the response shapes this client reads back; both are recorded in `ISSUES.md` rather than implied.

**A name this client admits and the service does not is dead code — unless it is argued**, and
there are two ways to be argued because there are two ways to be out of step. `AHEAD_OF_BACKEND` is
a reader that landed first; `RETAINED_FOR_ROLLOUT` is an old wire spelling kept until every
deployed browser has reloaded, which is the state the note event's rename is in today
(`ISSUES.md` Issue 13). An entry costs a reason, a phrase naming the `ISSUES.md` row whose deletion
retires it, and a date that fails once it has passed — an empty string used to be enough. That half
needs no checkout, so unlike the rest of the file it runs in every lane.

**What is enforced, bounded, measured and accepted is written down in one place.**
[`docs/production-readiness.md`](docs/production-readiness.md) is the record: every clause names the
test that holds it, and a clause with no test is rewritten as an accepted risk with who decides and
what would change the answer, or deleted. `tests/readinessRecord.test.ts` holds that rule — a clause
that claims something and cites nothing fails, an **Enforced** or **Bounded** clause that cites
something other than a test fails, a citation whose file has gone away fails, a clause indented
under another is parsed as a clause rather than absorbed into it, and a `§n` naming a section the
document does not have fails.

`check:contrast` converts OKLCH to sRGB rather than comparing lightness values: OKLCH's `L` is
perceptual and WCAG is defined on sRGB relative luminance, so two tokens that look far apart can
still fail. That gap is exactly how white-on-accent survived in dark mode at roughly 2:1.

**The production sign-in, in a browser: `npm run test:e2e:oidc-mock`.** Every other browser test
runs `AUTH_MODE=dev`. This one (`e2e/oidc-mock.spec.ts`, its own `playwright.oidc-mock.config.ts`)
serves the **production** bundle from the real BFF in `AUTH_MODE=msal` with `ENTRA_AUTHORITY`
pointed at Chemclaw3_mock's stand-in tenant (over https, with a certificate generated per run),
signs alice in in one browser context and bob in another through the tenant's login page, and
checks that each page shows its own person, that each sends a bearer naming its own person, and
that `e2e/oidc-upstream.ts` — which validates every forwarded bearer with Chemclaw3's four checks
before handing the request to the fixture — saw both of them and refused nothing. A second test
signs out through the tenant's end-session endpoint and checks the next sign-in asks again. Three
more sign in from `/`, from a deep link and from a signed-out `/open/<id>`, and count: one code
back on `/auth/callback`, one redeemed, and a URL that stops moving on the person's own
conversation — the sign-in loop #126 shipped made 534 navigations and redeemed nothing. It needs a
Chemclaw3_mock checkout with its venv (`MOCK_DIR`, default `../Chemclaw3_mock`;
`npm run provision:mock-tenant` makes the venv) and `npm run build` first, so it is not
in `npm run ci` (`ISSUES.md` Issue 23) — it is the workflow's own `oidc-mock` job instead, on every
pull request.

`test:e2e` runs the real BFF against `e2e/fixture-service.ts`, which emits SSE frames with real
gaps between them. Stubbing the network inside the page would hand the whole body over at once and
pass against a chain that buffers end to end — the one failure this project most wants to catch.

Unit tests stub `fetch` with canned SSE bytes — no server is started. That is the only practical way
to exercise what a healthy backend will not produce on demand: frames split across chunk boundaries,
malformed frames, unknown event types, a stream that ends without an answer, and each of
401/404/409/422/429/503 mapping to the right typed error.

Everything else is verified against the real service.

## Delivery

GitHub Actions is where the gate runs on every push; `npm run ci` is what it runs. `Jenkinsfile` is
the half Actions cannot do: publish the image to a registry and roll it out. It does not re-run the
gate by default — `RUN_GATE` defaults to `false`, an opt-in for a Jenkins-only estate, and that is
where the cross-repository contract check would gate if it gated anywhere (`ISSUES.md` Issue 14) —
but when it does, it runs the
same `npm run ci`, which it did not before: that stage used to list six commands of its own, with no
`npm audit`, no contrast check and no browser suite, so a Jenkins-only estate was gated to a
narrower bar than anybody said. It publishes **by digest** — a tag is a pointer, and a rollback that
follows one fetches bytes nobody reviewed.

Two checks there are deliberately _not_ copies of the GitHub job, because they run against the
**published image** rather than this workspace's `dist/`:

- **the bundle carries no dev auth provider** — the image builds its own bundle inside the
  Dockerfile with `ALLOW_DEV_AUTH` defaulting to false, so it is a different artifact from the one
  `npm run check:no-dev-auth` reads locally, and it is the one served to a chemist;
- **the container serves** `/healthz`, `/config.js`, the SPA fallback, and refuses `/api/metrics` —
  the proxy whitelist being the only thing between the browser and every route the BFF could
  otherwise forward. Those four assertions are `scripts/check-serving.mjs`, the same file the
  GitHub container job runs: how an image is _built_ legitimately differs per pipeline, what it
  must serve does not.

`npm run smoke` and `npm run check:openapi` remain the two checks that need a live service, run by
an operator rather than by either pipeline; see Testing above for why they are out of the gate and
what `check:live` is and is not.

This repository ships no chart, so a rollout is `oc set image` against a Deployment an operator
created; [`deploy/openshift/`](deploy/openshift/README.md) is an example of that Deployment, its
Service and its two Routes. The Deployment owes the HTML sandbox a second container port
(`SANDBOX_PORT`, default 8081), a Service port for it, and a Route on a **distinct hostname** — see
"HTML sandbox" under Configuration. The four-repository release, its ordering (the UI last — it is useless before the API it
proxies answers) and the reasoning are in Chemclaw3: `deploy/jenkins/README.md` and
`D-2026-08-26-a-release-is-a-descriptor-and-a-target`.

## Backend requirements

The UI reads more of the service than it used to, and the degradation is deliberately split in two.
**List** routes — `GET /sessions`, `GET /sessions/{id}/messages`, `GET /jobs`,
`GET /protocols`, `GET /exhibits` — swallow a 404 into an empty result, so an older service yields a
smaller app rather than a banner. `GET /sessions/{id}/exhibits` folds its 404 into
`enabled: false`, which is the same rule stated in the one field that decides whether the artefact
pane exists. **Fetch** routes — `GET /notes/{id}`,
`GET /sessions/{id}/tool-results/{ref}`, `GET /protocols/{id}`, `GET /sessions/{id}/exhibits/{xid}` —
do not, because nothing calls them
speculatively: the control only exists when the turn or the list said the thing exists, so a 404
there is a real fault.

`USER-STORIES.md` records which chemist-facing workflows this reaches and which it does not.

Conversation history also needs the service running with `CHEMCLAW_SESSION_STORE=postgres`. Under
the in-memory store there is nothing durable to list or read back.
