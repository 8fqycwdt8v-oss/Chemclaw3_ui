# Open Issues — Chemclaw3_ui

File these at: https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new

---

## Issue 1: happy-dom@^16.0.0 blocked by Replit security policy — prevents full devDependency install

**Repo:** Chemclaw3_ui

When running `npm install` on Replit, `happy-dom@16.8.1` (resolved from `^16.0.0`) is blocked by
the platform's package security policy:

```
npm error 403 Forbidden - GET http://package-firewall.replit.local/npm/happy-dom/-/happy-dom-16.8.1.tgz - Blocked by Security Policy
```

This prevents installing any devDependencies (including `vite`, `@vitejs/plugin-react`, etc.) because
npm resolves the full dependency tree before installing.

**Workaround applied on Replit:** Removed `happy-dom` and `vitest` from `package.json`
devDependencies so `vite build` can run. Tests currently cannot be run on Replit.

**Fix options:**
1. Pin `happy-dom` to an older version not flagged by the CVE scanner (e.g. `^15.x`)
2. Replace `happy-dom` with `jsdom` as the vitest environment
3. Use `npm overrides` to pin to a non-flagged patch release

**Impact:** `npm test` (vitest) cannot run on Replit without this fix. Build and server are fine.

---

## Issue 2: GET /api/sessions and GET /api/sessions/{id}/messages whitelisted in BFF but missing from backend

The BFF route whitelist (`server/routes.ts`) includes:
- `GET /api/sessions` → `/sessions` (list sessions)
- `GET /api/sessions/{sid}/messages` → `/sessions/{sid}/messages` (read transcript)

Both return `404`/`405` from the Chemclaw3 FastAPI backend (only `POST /sessions` and
`POST /sessions/{id}/messages` exist).

**Impact:** Sidebar conversation list is local-only; transcripts fall back to `localStorage`.

**Fix:** Add to `service/app.py` in Chemclaw3:
- `GET /sessions` — list sessions for current principal (needs `CHEMCLAW_SESSION_STORE=postgres`)
- `GET /sessions/{session_id}/messages` — return stored transcript

---

## Issue 3: GET /approvals and POST /approvals/{id}/decision missing from backend

The BFF whitelists:
- `GET /api/approvals` → `/approvals`
- `GET /api/approvals/{id}` → `/approvals/{id}`
- `POST /api/approvals/{id}/decision` → `/approvals/{id}/decision`

All return `404`. The `InteractionApprovalWorkflow` exists in the backend but has no HTTP surface.

**Impact:** Approve/Reject buttons in the UI 404 when clicked; approval holds cannot be completed
via the browser.

**Fix:** Implement the REST surface in `service/app.py`:
- `GET /approvals` — list pending holds
- `GET /approvals/{hold_id}` — describe one hold
- `POST /approvals/{hold_id}/decision` — signal the Temporal workflow
