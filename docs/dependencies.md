# Dependencies — what this repository takes, what it declines, and the two policies reversed

The record for `Chemclaw3_ui`'s dependency choices. It is a short document on purpose: most of the
argument for a dependency lives in the file that uses it, because that is where somebody changing
the code will be, and this file exists for the decisions that are **not** local to one file — the
two written-down policies that were deliberately reversed, and the declines that keep being
re-proposed.

**The rule this document is written under** is `docs/production-readiness.md`'s: a claim names the
test that holds it, or it is rewritten as something softer that says so. A dependency argued with
"it is smaller" and nothing measured is an argument about its author's afternoon.

---

## 1. Two reversals

Both were approved by the repository owner. Both reverse a rule that was written down, argued, and
correct when it was written — so the point of this section is not that the rule was wrong, it is
**what changed**.

### `valibot` in `shared/events.ts`

`shared/events.ts` said: "imported by both the SPA (bundled by Vite) and the mock backend (bundled
by esbuild). Keep it dependency-free." `shared/protocols.ts` adds a third consumer, the e2e fixture
service run under `node --experimental-strip-types`.

**What changed is that the constraint turned out to be policy rather than physics.** All three of
those resolve an ordinary npm dependency; nothing about Vite, esbuild or type-stripping made the
rule necessary. What made it _worth keeping_ was that nothing in the file needed one.

**What made it worth reversing** is the file's own header, which is a nine-incident changelog of one
seam failing the same way. Six events — `capability_degraded`, `tool_failed`, `job_failed`,
`evidence_source`, `handoff`, `awaiting_answer` — and three fields — `plan.plan_hash`,
`tool_failed.reason`, `evidence_source.failed` — shipped upstream and were **deleted in transit**,
because `normalizeEvent` rebuilt every event field by field: a field the mirror did not know about
was not merely untyped, it was dropped, and a well-formed event reached a surface with its
qualifying half removed. Every one of those was a hand-written switch branch failing to keep up
with a hand-written interface beside it.

Each member is now a schema and its exported type is `v.InferOutput` of that schema. **A field
cannot exist in the type and be absent from the decoder, because there is nowhere for it to
exist.** That is the reason, and it is not "less code" — the file's prose grew.

- **Enforced.** Every member of `ChemclawEvent` survives normalisation carrying every declared
  field, and the fixture that proves it is checked against the schemas rather than trusted —
  `tests/eventContract.test.ts`.
- **Measured.** `valibot` over `zod`: ~2-4 kB gz for this surface against zod classic's ~13 kB, and
  `shared/` is bundled into the SPA. The bundle budget that holds it is
  `scripts/check-bundle.mjs`, pinned by `tests/bundleBudget.test.ts`.
- **Bounded.** The BFF's esbuild bundle inlines it (`packages: 'bundle'`), so the runtime image
  still needs no `node_modules` — `scripts/check-standalone-server.mjs`.
- **Accepted.** A field's documentation now sits above its schema entry rather than above an
  interface member, so an editor hovering `event.plan_hash` no longer shows it. The prose is in the
  same place in the file, one construct over. Who decides: whoever finds hover more valuable than
  the derivation; what would change it is a way to have both.

**`src/env.ts` is not covered by this and was deliberately left alone** — but for one of its two
reasons, not both. The byte argument it was first written on ("a dozen string checks, and a schema
library would be more bytes than the rest of this module") is **retired by this very reversal**:
`env.ts` imports `shared/events.ts`, so `valibot` is already in the graph and costs that module
nothing further. What survives is the reason that was never about size, and it is the one the table
below now gives: there is no second declaration to drift from. `events.ts` took a schema because a
field could exist in the hand-written interface and be missing from the hand-written decoder beside
it, nine times; here `RuntimeConfig` is the only shape, the keys are read once at boot, and a
missing one is a default rather than a dropped field a surface renders around. `src/env.ts` says
the same thing at the point of use.

### `@tanstack/react-query` for the app's reads

This repository declined a data-fetching library, and every read was `useEffect` + `let cancelled =
false` + `useState<view | null>` + `useState(failed)`: the same four lines in ten components.

**What changed is that two of the ten had already been got wrong**, in ways that cost a rendered
answer, and both are recorded in the files they happened in. `ResultBlock` needed a `requested` ref
because writing the effect the obvious way — `state.status` in the dependency list — made it cancel
the fetch its own previous run had started; and it needed a _second_ ref, re-armed on every mount,
because React 19's StrictMode double-invoke leaves a plain `mounted` flag `false` for the life of
the component. A 200 that renders nothing, in development, for ever.

Those are not mistakes somebody made. They are what the shape costs.

- **Enforced.** The plan inbox is not rescanned on a bounce into `/review`, not rescanned when the
  window regains focus, and rescanned at once after a decision — `tests/requestEconomy.test.ts`.
  The focus case is driven _past_ the staleness window, because a version that alt-tabs straight
  back passes with the option deliberately turned on.
- **Enforced.** Two components citing one content-addressed ref make one request, and a remount
  makes none — `tests/requestEconomy.test.ts`.
- **Enforced.** `orEmpty` still folds a list route's 404 into `[]` **with its log line**, and
  `listPendingPlans` still lets its failure through, because "we could not ask" and "nothing is
  waiting" are opposite things to tell somebody whose work is blocked —
  `tests/requestEconomy.test.ts`, `tests/reviewQueue.test.tsx`.
- **Enforced.** The health probe refetches on focus and on reconnect, which is the positive control
  for `queryClient.mount()` — without it nothing subscribes to focus, both options are inert
  everywhere, and the _negative_ control above passes for the wrong reason
  (`tests/serviceHealth.test.tsx`).
- **Bounded.** There is one `QueryClient`, no `QueryClientProvider`, and `useQuery(options,
queryClient)` is upstream's own API for that. The cache is module-scoped exactly as `inFlight`
  and `pendingPlansCache` were, and `tests/setup.ts` clears it between cases for the reason
  `resetPendingPlansCache` existed.
- **Accepted.** `src/App.tsx`'s `useRemoteTranscript` keeps the four-line shape. It is a procedure
  with an ordering constraint — the plan must be read back before hydrating, because hydrating
  trips one of the hook's own guards — and its failure path writes a banner to the store rather
  than rendering an error state. A query would move the ordering into a dependency array. Who
  decides: whoever next changes that hook; what would change it is the transcript and plan reads
  becoming independent of each other.

---

## 2. What is declined, and why it keeps being re-proposed

Each of these is argued at the point of use. Listed here so a proposal meets the measurement before
it meets the reviewer.

| Declined                                                         | Where the argument is                                            | The short version                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `msw`, `page.route` for the fixture service                      | `e2e/fixture-service.ts`                                         | It argues for being a real listening server; intercepting would test a different thing                     |
| `@microsoft/fetch-event-source`                                  | `src/api/streamTurn.ts`                                          | Unmaintained since 2021, and its auto-retry would double-spend the turn budget or hit the 409 session lock |
| `broadcast-channel` (npm)                                        | `src/state/jobStreamLeader.ts`                                   | ~10 kB+ gz, and it carries Node/IndexedDB methods this app cannot use. `navigator.locks` is zero bytes     |
| `postcss` in the contrast gate                                   | `scripts/check-contrast.mjs`                                     | A build-tool dependency bought for a `{...}` match, and Tailwind v4 no longer guarantees it is in the tree |
| A schema library in `src/env.ts`                                 | `src/env.ts`                                                     | No second declaration to drift from: read once at boot, one shape, a missing key is a default              |
| A charting library                                               | `src/components/Sparkline.tsx`, `src/components/chem/Charts.tsx` | —                                                                                                          |
| `rehype-raw`, `papaparse`, `file-saver`, `@tanstack/react-table` | their call sites                                                 | —                                                                                                          |
| A web framework for the BFF; compression middleware              | `server/app.ts`                                                  | —                                                                                                          |

---

## 3. What is taken, and where it lands

`scripts/check-bundle.mjs` asserts the shape _and_ the size; `tests/bundleBudget.test.ts` holds the
budget against the gate. The numbers below are what the budget was set from and are a claim about
one commit — the live figures are whatever `npm run check:bundle` prints.

| Dependency              | Where it lands                           | What it replaced                                                  |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `valibot`               | entry chunk (`shared/events.ts`)         | six coercers and a 130-line switch                                |
| `@tanstack/react-query` | entry chunk                              | ten `useEffect`/`cancelled` triads, an in-flight map, a TTL cache |
| `comlink`               | entry chunk (`src/chem/rdkit.client.ts`) | a request-id counter, a pending map, a dispatch and an envelope   |
| `immer`                 | the lazy `ProtocolDocument` chunk        | ~90 lines of nested spread chains                                 |
| `culori`                | nowhere — `devDependencies`              | 15 hand-transcribed matrix constants and the WCAG formulas        |
