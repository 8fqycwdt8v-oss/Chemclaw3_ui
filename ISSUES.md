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

## Issue 2: ~~GET /api/sessions and GET /api/sessions/{id}/messages missing from backend~~ — RESOLVED

Both exist upstream (`src/chemclaw/api/routes/sessions.py`), and `GET /sessions/{id}/messages`
returns more than this issue asked for: each message carries `tool_calls` with the tool, its
arguments and its result, so a reload restores the agent's work and not only its prose.

Conversation history still needs the service running with `CHEMCLAW_SESSION_STORE=postgres` —
under the in-memory store there is nothing durable to list or read back.

---

## Issue 3: ~~GET /approvals and POST /approvals/{id}/decision missing from backend~~ — RESOLVED

The REST surface exists upstream (`src/chemclaw/api/routes/approvals.py`). The Approve/Reject
buttons reach a real endpoint.

---

## Issue 4: ~~backend routes the BFF does not forward~~ — RESOLVED

All seven are whitelisted and consumed by the workbench views (`src/views/`). Recorded here because
the shape is worth remembering: none of these was a missing backend feature, and the gap was
invisible from either side alone — the backend's tests passed, the UI's tests passed, and nothing
compared the two.

One thing the implementation corrected: `GET /jobs` lists *finished* runs only (it reads
`job_records`, whose rows are written on completion), so a running job is reachable only by its id.

These were the routes:

| Route | What it carries |
| --- | --- |
| `GET /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}` | Durable runs — status, result, rationale — and an operator-gated cancel. A job outlives the conversation that started it, which is the whole reason the surface exists. |
| `GET /proposals`, `GET /proposals/{id}`, `POST /proposals/{id}/decision` | The PR-gate's review queue: the proposed note's full content, its dependencies, and the human sign-off. The GxP spine of the architecture, which had no UI at all. |
| `GET /profiles` | The narrowed agents a session can be started as — `data/profiles/property-lookup.yaml` is a ready-made calculator mode. |

---

## Issue 5: two npm scripts reference files that do not exist

`package.json` declares:

- `test:e2e: playwright test` — there is no `playwright.config.*` in the repo, though
  `@playwright/test` is a devDependency.
- `check:openapi: node scripts/check-openapi.mjs` — `scripts/` holds only `build-server.mjs`,
  `dev.mjs` and `smoke.mjs`.

Both fail on invocation. The OpenAPI check is worth building rather than deleting: three separate
events (`capability_degraded`, `tool_failed`, `job_failed`) each reached production missing from
`shared/events.ts`, and the third was found only by reading the two contracts side by side.
