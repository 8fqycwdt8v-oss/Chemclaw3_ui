# CLAUDE.md

Guidance for Claude Code in `Chemclaw3_ui`, the browser frontend and Node BFF for
[Chemclaw3](https://github.com/8fqycwdt8v-oss/Chemclaw3). Companion repos: `Chemclaw3` (backend),
`Chemclaw3-mcp` (tool fleet), `Chemclaw3_mock` (stand-in services). A change belonging to another
repo is a PR there, not a workaround here.

## Stack

- **SPA:** React 19, Vite, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind v4, Radix +
  `class-variance-authority`, zustand (client state), `@tanstack/react-query` (reads, one
  module-scoped `QueryClient`), RDKit-WASM in a worker via comlink, Ketcher for drawing.
- **BFF:** plain Node `http` plus `sirv` for static files (`server/`), bundled with esbuild to `dist/server.js`, which runs with
  no `node_modules`. It serves the SPA and `/config.js`, proxies a **whitelist** of `/api` routes to
  the service, and runs the HTML-sandbox listener.
- Node ≥ 22.12. `valibot` schemas for the event contract.

## Where things go

| Path              | What                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `server/`         | BFF: config (`config.ts`), route whitelist (`routes.ts`), proxy, CSP |
| `src/api/`        | HTTP client, SSE turn stream, typed errors, query client             |
| `src/state/`      | zustand stores and turn/job logic                                    |
| `src/components/` | UI; `ui/` primitives, `chem/` composites, `exhibits/` artefact pane  |
| `src/results/`    | tool-result renderers, keyed on payload shape                        |
| `src/chem/`       | RDKit client/worker/engine, sketcher, entity extraction              |
| `shared/`         | imported by SPA and BFF: wire types, event readings, constants       |
| `contracts/`      | the pinned core API contract and its lock                            |
| `tests/`, `e2e/`  | vitest unit tests; Playwright specs + `e2e/fixture-service.ts`       |
| `scripts/`        | the gate (`ci.mjs`) and every check it runs; each has an npm script  |
| `docs/`           | `operations.md`, `production-readiness.md`, `dependencies.md`        |

A new `/api` route the browser needs is a pattern in `server/routes.ts` plus a test in
`tests/routes.test.ts`. Runtime config is environment read in `server/config.ts` and served to the
browser via `/config.js` — never `import.meta.env` for deploy-time values.

## API types and the backend

The wire types are **generated** from core's API contract, pinned at a commit:
`contracts/core-openapi.json` (verbatim copy) + `contracts/core.lock` (commit, version, sha256),
generated into `shared/generated/` (never edit). `shared/wire.ts` aliases the models under the
UI's names; `shared/events.ts` holds the tolerant readings. Don't hand-write a wire type: if the
document lacks one, say why in `shared/wireUntyped.ts`. To bump the contract: `docs/api-contract.md`
(copy, lock, `npm run generate:api`, `npm run ci`).

## Commands

```sh
npm run dev           # Vite :5173 + BFF :8787 + sandbox :8788
npm run lint          # eslint
npm run typecheck     # tsc -b
npm test              # vitest
npm run format:check  # prettier (npm run format to fix)
npm run build         # client + server bundles
npm run test:e2e      # Playwright against the real BFF and the fixture service
npm run generate:api  # regenerate shared/generated/ from the pinned contract
npm run contract:check # the copy matches its lock, and core's file at the pinned commit
npm run ci            # the whole gate, as CI runs it (npm run ci -- --list)
```

Single test: `npx vitest run tests/<file>.test.ts -t "<name>"`.

## Comments and docs

- Comments and docstrings say **what and why**, and the invariant a reader must not break. Keep a
  block to ~6 lines. No history: no "used to", dates, measurements of past runs, review rounds or
  corrections of earlier text — that belongs in the commit message and PR.
- Docs describe what is true today. `ISSUES.md` holds only open items and accepted risks; delete an
  entry in the change that closes it.
- Do not write tests that police prose.

## Workflow

Branch, make the change with tests, run lint, typecheck, test (and build/e2e when touched), open a
PR, and merge it once CI is green. Ask first only when a change is destructive, ambiguous, or
outside what was asked.
