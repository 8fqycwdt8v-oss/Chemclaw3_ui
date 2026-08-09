# Open Issues — Chemclaw3_ui

File these at: https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new

---

## Resolved, and why this file was rewritten

The three issues previously listed here were all closed or wrong, and two of them were
actively misleading:

- **happy-dom blocked by Replit's package policy.** Resolved: `happy-dom` is pinned to `^15.x`
  in `package.json` and the suite runs.
- **`GET /sessions` and `GET /sessions/{id}/messages` missing from the backend.** No longer true.
  Both exist (`api/routes/sessions.py`). The transcript route additionally gained `index` and
  `tool_calls`, which the frontend now reads.
- **`GET /approvals` and the decision route missing from the backend.** No longer true either
  (`api/routes/approvals.py`). The Approve/Reject buttons reach a real endpoint.

Stale "the backend does not have this yet" notes are worse than no notes: they justify defensive
code that then hides real failures. `client.ts` swallowed 404s on both session routes for exactly
this reason. The guard against a repeat is now mechanical rather than documentary —
`shared/backend-contract.json` is generated from the running service and
`scripts/check-contract.mjs` fails the build when this repo drifts from it.

---

## Known limitations

Five of the entries below can only be closed in the backend. They are written up as a
specification — with the real file and line anchors, and the reasoning the backend has already
recorded for the positions it took — in [`docs/backend-requests.md`](docs/backend-requests.md).

### 1. `GET /jobs` is not owner-scoped, so "Everyone's" is the honest default

This is the backend's stated position rather than a bug: `find_past_jobs`, the agent tool over the
same table, is deliberately unscoped so knowledge crosses projects. The Runs panel therefore offers
a client-side "Mine" filter on `requested_by` and labels the unfiltered view as everyone's. If the
deployment ever wants a genuinely private job list, that has to be a backend change; filtering here
would only _look_ like privacy.

### 2. Cancelling a durable run needs a privileged role

`DELETE /jobs/{id}` answers 403 for most callers, and the UI says so plainly. A job's workflow id
hashes its inputs and excludes the requester, so two chemists asking for the same campaign join one
run and neither is entitled to end it for the other. A chemist cannot stop their own runaway run
without an operator. Stated rather than hidden behind a scope check that would read as ownership.

### 3. A rehydrated transcript cannot show verification signals

The backend persists messages and tool calls, not `confidence`, `review_required`, plan snapshots
or attachment references. A conversation restored after a reload therefore renders without those
badges — deliberately blank rather than defaulted to "clean", which would assert something the
stored data cannot support.

### 4. `approval_request` with an empty `approval_id` is not answerable

That shape is a MAF request with no durable hold behind it, and no endpoint exists that could
answer it. It renders read-only. Making it actionable needs a backend change.

### 5. The plan-approval fallback is unaudited, and still exists

When the service has no plan route at all, the UI can still answer the gate with an ordinary chat
message ("Approved — go ahead."), which leaves no `plan_approvals` row. That path is now reached
only from a 404 — every other failure (401, 403, 5xx, timeout) renders as an error with a retry and
offers no shortcut, because a failure to _reach_ the gate is not a service that lacks one. It also
takes an explicit acknowledgement and renders as visibly degraded rather than as an ordinary
Approve/Decline pair.

The remaining limitation is the honest one: against a service that genuinely has no plan route,
a decision made here is not in the audit trail. A deployment that cares should ensure the plan
routes are reachable rather than relying on this.

### 6. No revocation for a BFF session

`AUTH_MODE=bff` is now the default and the browser holds no bearer token — the previous entry here
described the opposite posture and is obsolete. What replaces it is a narrower limitation: the
session is a sealed cookie with no server-side store, so it is valid until it expires. `/auth/logout`
clears the browser's copy rather than invalidating a record, and a cookie stolen before then remains
usable for the life of the access token inside it (bounded by the Entra token lifetime, typically an
hour, and by the refresh token thereafter).

That is the accepted cost of a stateless design that survives a restart and scales across replicas
with nothing new to run. A deployment needing real revocation would have to add a session store,
which is a different trade and not one this repo has made.

`msal-spa` remains available and has the old property: tokens in `sessionStorage`, readable by any
script on the origin. It is not the default for that reason.

### 7. Verification against a live agent is partial

`npm run test:e2e` drives the real BFF and the real built bundle, but against a mock backend: a
genuine turn needs a model credential. The mock speaks the generated contract, so its shapes cannot
drift silently — but "the agent answered sensibly" is not something this suite can assert.
