# `deploy/openshift/` — example manifests

An **example** of what the UI owes an OpenShift namespace, not a chart: this repository ships none
(README, "Delivery"). Jenkins re-points the Deployment on every release with
`oc set image deployment/chemclaw3-ui ui=<registry>/<image>@sha256:…`, so the names here are the
ones `Jenkinsfile` uses. Copy the three files, change the hosts, the tenant and the image, and
apply them once:

```sh
oc apply -n chemclaw -f deploy/openshift/
```

The full operator story — building the image, every variable, Entra registration, what the backend
must be configured with, verification and troubleshooting — is
[`docs/operations.md`](../../docs/operations.md). This file covers only what the manifests encode.

## What to change before applying

- **The two hosts** in `routes.yaml`, and `APP_ORIGIN` / `SANDBOX_ORIGIN` in `deployment.yaml` to
  `https://` plus exactly those hosts.
- **`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `API_SCOPE`, `REVIEWER_ROLES`** — the placeholders are
  zeros and ones. The BFF's registration is a **Web** application with a client secret and the
  redirect URIs `https://<app host>/auth/callback` and `https://<app host>/`.
- **The client secret** — `oc create secret generic chemclaw3-ui-oidc
--from-literal=client-secret=<value>`; the Deployment mounts it read-only and names the file in
  `ENTRA_CLIENT_SECRET_FILE`. It is not in this repository.
- **`CHEMCLAW_API_URL`** — `http://chemclaw-service:8080` is Chemclaw3's chart Service under its
  default name in the **same namespace**; from another namespace use
  `http://chemclaw-service.<namespace>.svc:8080`. The service root only, never a path. The BFF
  reaches the backend over the cluster network; no Route to the backend is involved, and a
  NetworkPolicy on the backend must admit this Deployment's pods.
- **The image** — anything; Jenkins replaces it by digest on the first release.

Nothing in the manifests is secret (the client secret is the Secret above), so the `env` block can
equally be a ConfigMap. The pod needs egress to the identity provider (`login.microsoftonline.com`
by default). Before this UI is ready, the backend must answer its own `/readyz`, and under
`AUTH_MODE=bff` it must refuse an anonymous `GET /sessions`
(`CHEMCLAW_ENTRA_REQUIRED=true`) — otherwise `/readyz` here stays 503 with
`"detail":"upstream accepts anonymous"`, by design.

| File              | What it is                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `deployment.yaml` | the BFF with **three container ports** — `http` (`PORT`), `sandbox` (`SANDBOX_PORT`) and `metrics` (`METRICS_PORT`) — and env |
| `service.yaml`    | one Service, three named ports, `http`, `sandbox` and `metrics`                                                               |
| `routes.yaml`     | two Routes on two hosts, both edge TLS with http redirected; none targets `metrics`                                           |

**`metrics` is for an in-cluster scraper only.** `GET /metrics` has no authentication and says how
many people are signed in, so it is served on its own port (the `http` port answers it 404) and no
Route may target that port. Point a `ServiceMonitor` at the Service's `metrics` port
(`docs/operations.md` §6).

## Sessions are in the pod, which is why the app Route keeps affinity

The BFF holds each signed-in person's tokens in its own memory (`docs/operations.md`, "Token
custody"), and this Deployment runs two replicas. The app Route therefore keeps the router's
affinity cookie (`haproxy.router.openshift.io/disable_cookies: 'false'`, the default, stated on
purpose). A release replaces the pods and people sign in again, silently while the identity
provider's session lasts.

## The HTML sandbox, which is why there are two of everything

An `html` artefact runs in a frame from a **different origin** from the app's — the BFF's second
listener, which serves `GET /sandbox/frame` and nothing else (README, "HTML sandbox"). So:

- **A second container port and a Service port named `sandbox`.** The app port never serves
  `/sandbox/frame` (it answers 404, enforced), and the sandbox port serves nothing else.
- **A separate Route with its own host**, edge TLS, `insecureEdgeTerminationPolicy: Redirect`, and
  `haproxy.router.openshift.io/disable_cookies: "true"` so the router's affinity cookie is not the one
  cookie the sandbox origin ever sets. Prefer a host under a **separate registrable domain**
  (`*.example-usercontent.net` beside `*.apps.example.com`): then the two are different _sites_, not
  just different origins.
- **Nothing in front of the sandbox host that authenticates or rewrites.** No oauth-proxy, no SSO:
  the browser loads the frame with no credential. And a proxy must pass the sandbox page's own
  `Content-Security-Policy` through untouched and must not add `X-Frame-Options` or the app's CSP to
  it — the page's `frame-ancestors` names `APP_ORIGIN`, the app's says `'none'`, and either
  substitution makes the frame a blank box.
- **Monitor and renew the sandbox's domain exactly as you do the app's.** It is a second domain
  the app posts every HTML artefact to: one that lapses, or is taken over, receives the artefacts.
- **`APP_ORIGIN` and `SANDBOX_ORIGIN` are the Routes' hosts, over https, exactly.** The shell takes
  content only from `APP_ORIGIN`; a chemist reaching the app at another address sees the artefact as
  source with both origins named.

## Probes

| Probe     | Port      | Path             | Why                                                                     |
| --------- | --------- | ---------------- | ----------------------------------------------------------------------- |
| readiness | `http`    | `/readyz`        | asks the service's own `/readyz`; 503 while draining on SIGTERM         |
| liveness  | `http`    | `/healthz`       | the process serves; consults nothing upstream                           |
| startup   | `sandbox` | `/sandbox/frame` | the sandbox is on — a config that turned it off fails here, not quietly |

## Streaming through the router

Both Routes use the router's defaults. Turn and job streams are long-lived SSE responses; the BFF
sends a comment frame on any stream idle for `SSE_HEARTBEAT_MS` (15 s), which is under the
OpenShift router's default 30 s timeout, so no `haproxy.router.openshift.io/timeout` annotation is
needed. Raise one only if you also raise the heartbeat above it.

## What holds this file to the code

`tests/openshiftManifests.test.ts` parses these YAML files and checks every env name against
`server/config.ts`, that the client secret is mounted from a Secret and not set as a value, that the
app Route keeps affinity, the container ports against `PORT`/`SANDBOX_PORT`/`METRICS_PORT`, the
Service's and Routes' port names (no Route on `metrics`), both origins against the Routes' hosts, the names against `Jenkinsfile`, and — booting
`server/config.ts` with this Deployment's environment — that the BFF would start with the sandbox
on and no refusal.
