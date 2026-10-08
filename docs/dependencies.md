# Dependencies

Decisions about dependencies that are not local to one file. The argument for a dependency
otherwise lives at its call site.

## Policies

### `valibot` in `shared/events.ts`

Each event is a valibot schema, generated from the pinned contract (`shared/generated/events.ts`),
and its type is `v.InferOutput` of it, so a field cannot exist in the type and be missing from the
decoder (hand-written decoders silently dropped unknown fields).
Chosen over zod for size (~2–4 kB gz vs ~13 kB); `shared/` is bundled into the SPA.

- **Enforced.** Every `ChemclawEvent` member survives normalisation with every field
  (`tests/eventContract.test.ts`).
- **Bounded.** The bundle budget (`scripts/check-bundle.mjs`, `tests/bundleBudget.test.ts`).
- **Bounded.** The BFF bundle inlines it, so the image needs no `node_modules`
  (`scripts/check-standalone-server.mjs`).

`src/env.ts` stays schema-free: `RuntimeConfig` is the only declaration, read once at boot, and a
missing key is a default.

### `openapi-typescript` for the wire types

Dev only: `npm run generate:api` turns the pinned contract (`docs/api-contract.md`) into
`shared/generated/api.ts`. Chosen over hand-mirroring, which drifted three times in production
(`capability_degraded`, `tool_failed`, `job_failed`). Its output is types, erased at build, so it
adds nothing to the bundle.

- **Enforced.** The committed output is what the pinned document produces (`npm run generate:check`).

### `@tanstack/react-query` for reads

Reads go through one module-scoped `QueryClient` (`src/api/queryClient.ts`), used as
`useQuery(options, queryClient)` with no provider, instead of hand-written `useEffect` fetch
triads, which got cancellation and StrictMode wrong.

- **Enforced.** No duplicate requests for one content-addressed ref; the plan inbox refetches after
  a decision but not on focus or bounce (`tests/requestEconomy.test.ts`); the health probe does
  refetch on focus and reconnect (`tests/serviceHealth.test.tsx`).
- **Enforced.** A list route's 404 folds to `[]` with a log line; `listPendingPlans` lets its
  failure through (`tests/requestEconomy.test.ts`, `tests/reviewQueue.test.tsx`).
- `useRemoteTranscript` (`src/App.tsx`) is an ordered procedure (plan read before hydrate) and stays
  a plain effect.

## Declined

| Declined                                                         | Argued in                                                        | Short version                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `msw`, `page.route` for the fixture service                      | `e2e/fixture-service.ts`                                         | It must be a real listening server to catch buffering             |
| `@microsoft/fetch-event-source`                                  | `src/api/streamTurn.ts`                                          | Unmaintained; its auto-retry would re-send a turn                 |
| `broadcast-channel` (npm)                                        | `src/state/jobStreamLeader.ts`                                   | ~10 kB+ gz; `BroadcastChannel` and `navigator.locks` are built in |
| `postcss` in the contrast gate                                   | `scripts/check-contrast.mjs`                                     | A build-tool dependency for a brace match                         |
| A schema library in `src/env.ts`                                 | `src/env.ts`                                                     | One declaration, read once                                        |
| A charting library                                               | `src/components/Sparkline.tsx`, `src/components/chem/Charts.tsx` | —                                                                 |
| `rehype-raw`, `papaparse`, `file-saver`, `@tanstack/react-table` | their call sites                                                 | —                                                                 |
| A web framework for the BFF; compression middleware              | `server/app.ts`                                                  | —                                                                 |

## Where taken dependencies land

`npm run check:bundle` asserts chunk shape and size; the budget and its rationale are in
`scripts/check-bundle.mjs` (`BUDGET`). Raising it is a decision recorded there.

| Dependency              | Lands in                                                       |
| ----------------------- | -------------------------------------------------------------- |
| `valibot`               | entry chunk (`shared/events.ts`)                               |
| `@tanstack/react-query` | entry chunk                                                    |
| `comlink`               | entry chunk (`src/chem/rdkit.client.ts`)                       |
| `immer`                 | the lazy `ProtocolDocument` chunk                              |
| `events`                | the lazy sketcher chunk (`ketcher-core` imports it undeclared) |
| `culori`, `js-yaml`     | dev only (contrast gate; manifest test)                        |
| `openapi-typescript`    | dev only (`scripts/generate-api.mjs`)                          |
