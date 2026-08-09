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

### 5. The plan-approval fallback is unaudited

When `GET /sessions/{id}/plan` is unavailable, the UI falls back to answering the gate with an
ordinary chat message ("Approved — go ahead."). That is one tap and it leaves no
`plan_approvals` row. It is labelled as the degraded path, but a deployment that cares about the
audit trail should ensure the plan routes are reachable rather than relying on it.

### 6. Browser-held access tokens

MSAL runs in the browser with `cacheLocation: 'sessionStorage'`, and the BFF forwards the bearer
token without inspecting it. This is a proxy, not a token-custody BFF, so an XSS in the SPA could
exfiltrate an access token; the strict CSP (`script-src 'self'`, no inline scripts, no
`rehype-raw`) is what stands between the two. Moving custody into the BFF would close that, at the
cost of session cookies and the CSRF surface this design currently has none of. Recorded as a
deliberate trade-off, not an oversight.

### 7. Verification against a live agent is partial

`npm run test:e2e` drives the real BFF and the real built bundle, but against a mock backend: a
genuine turn needs a model credential. The mock speaks the generated contract, so its shapes cannot
drift silently — but "the agent answered sensibly" is not something this suite can assert.
