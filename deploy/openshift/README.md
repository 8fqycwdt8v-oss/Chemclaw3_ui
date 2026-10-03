# `deploy/openshift/` — example manifests

An **example** of what the UI owes an OpenShift namespace, not a chart: this repository ships none
(README, "Delivery"). Jenkins re-points the Deployment on every release with
`oc set image deployment/chemclaw3-ui ui=<registry>/<image>@sha256:…`, so the names here are the
ones `Jenkinsfile` uses. Copy the three files, change the hosts, the tenant and the image, and
apply them once:

```sh
oc apply -n chemclaw -f deploy/openshift/
```

| File              | What it is                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `deployment.yaml` | the BFF with **two container ports** — `http` (`PORT`) and `sandbox` (`SANDBOX_PORT`) — and env |
| `service.yaml`    | one Service, two named ports, `http` and `sandbox`                                              |
| `routes.yaml`     | two Routes on two hosts, both edge TLS with http redirected                                     |

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
- **`APP_ORIGIN` and `SANDBOX_ORIGIN` are the Routes' hosts, over https, exactly.** The shell takes
  content only from `APP_ORIGIN`; a chemist reaching the app at another address sees the artefact as
  source with both origins named.

## Probes

| Probe     | Port      | Path             | Why                                                                     |
| --------- | --------- | ---------------- | ----------------------------------------------------------------------- |
| readiness | `http`    | `/readyz`        | asks the service's own `/readyz`; 503 while draining on SIGTERM         |
| liveness  | `http`    | `/healthz`       | the process serves; consults nothing upstream                           |
| startup   | `sandbox` | `/sandbox/frame` | the sandbox is on — a config that turned it off fails here, not quietly |

## What holds this file to the code

`tests/openshiftManifests.test.ts` parses these YAML files and checks every env name against
`server/config.ts`, the container ports against `PORT`/`SANDBOX_PORT`, the Service's and Routes'
port names, both origins against the Routes' hosts, the names against `Jenkinsfile`, and — booting
`server/config.ts` with this Deployment's environment — that the BFF would start with the sandbox
on and no refusal.
