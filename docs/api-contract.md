# The API contract

The wire types of this UI are generated from the API contract that Chemclaw3 (core) publishes as
`schema/api/openapi.json` (OpenAPI 3.1, versioned by `API_CONTRACT_VERSION`; core's
`schema/api/README.md` has its bump rules). Nothing about the service's HTTP surface or turn events
is declared by hand here.

## Decision: pin a verbatim copy, by commit

**Options.** (1) Fetch core's file at build time: the build then depends on a network and on a
branch that moves. (2) A git submodule of core: carries the whole backend tree into this one. (3) A
committed copy plus a lock naming the core commit it was taken at.

**Chosen: (3).** A contract bump is then a reviewable diff of the document itself, builds are
offline and repeatable, and a core that has moved on cannot red this repository.

| File                          | Holds                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `contracts/core-openapi.json` | core's `schema/api/openapi.json`, byte for byte                                             |
| `contracts/core.lock`         | `commit` (full sha in core), `contract_version`, `sha256` of the copy, `repository`, `path` |
| `shared/generated/api.ts`     | every route and model, by `openapi-typescript`                                              |
| `shared/generated/events.ts`  | one tolerant valibot schema per member of the `TurnEvent` union, from the document          |

## What holds it

- `npm run contract:check` (gate step `contract`). The copy's hash and `info.version` must equal
  the lock. With a Chemclaw3 checkout (`CHEMCLAW3_DIR`, else a sibling `../Chemclaw3`) it also reads
  core's file **at the pinned commit** with `git show` — never core's `main` — and requires it to
  equal the copy. `CHEMCLAW3_REQUIRED=1` (CI and the Jenkins gate set it) turns "no checkout" and
  "pinned commit unreachable" into failures; without it the comparison is skipped with a message and
  the lock is still checked. Only a checkout named by `CHEMCLAW3_DIR` is ever fetched into.
- `npm run generate:check` (gate step `generate`) regenerates in memory and fails if a file under
  `shared/generated/` differs. `tests/pinnedContract.test.ts` holds the same in `npm test`.
- `tests/pinnedContract.test.ts` also holds what generation cannot see: the BFF whitelist and every
  request `src/api/` makes against the document's routes, an exhaustive case for every event kind,
  and the lists this UI keeps (`EXHIBIT_KINDS`, `DESIGN_STATUSES`) against the document's enums.
- `npm run check:live-contract <service url>` (part of operator-run `check:live`) diffs the contract a
  deployment serves at `/openapi.json` with the pin; it needs the service directly, not the BFF.
- The design-lifecycle table is compared with core's `protocols/store.py` at the pinned commit
  (`tests/protocolStatusTransitions.test.ts`), by the same reader and the same required/skip rule.
- Request bodies are `satisfies` their generated request model at the call site, so `tsc` holds the
  keys and the required fields.

## What is not generated, and why

- `shared/events.ts` — the readings that are a UI decision: the fallback for a closed set the
  document does not give one for, a field read as open text where the document narrows it, the
  `note_proposed` → `note_recorded` alias, and `normalizeEvent`'s drop of an unknown kind (the union
  is designed to grow). Each is a `refine` call, listed in `STATED_READINGS`.
- `shared/wire.ts` — aliases under the names the UI uses. `Served` reads a response as complete (the
  document marks fields with a default optional; the service serialises them all); `Loosen` keeps a
  field optional where this UI tolerates an older service.
- `shared/wireUntyped.ts` — bodies the document types as a bare `object` (`/healthz`, turn stop).
- `shared/exhibits.ts` — the artefact decoders. The document types `spec` as `unknown`, and the UI
  validates it per kind; the decoders' fields are held against the document in `pinnedContract`.
- `shared/protocols.ts` keeps the lifecycle table (`LEGAL_STATUS_MOVES`), which is not on the wire.
- The BFF's own routes (`/api/client-events`, `/config.js`).

## How to bump the contract

When core publishes a new `schema/api/openapi.json` (its `API_CONTRACT_VERSION` moved):

1. Take the commit sha of core's `main` that carries it, and copy the file verbatim:
   `git -C ../Chemclaw3 show <sha>:schema/api/openapi.json > contracts/core-openapi.json`.
2. Edit `contracts/core.lock`: `commit` to that sha, `contract_version` to the document's
   `info.version`, `sha256` to `sha256sum contracts/core-openapi.json`.
3. `npm run generate:api`, then `npm run typecheck`. A removed field, an added event kind or a
   narrowed type fails here, in the file that has to decide: `shared/events.ts` (a new kind needs a
   member), `src/state/chatStore.ts` `traceEntryFor` and the table in `tests/pinnedContract.test.ts`
   (what the reducer does with it).
4. `npm run contract:check` with `CHEMCLAW3_DIR` set to a checkout that has the sha, then `npm run ci`.
5. Commit the copy, the lock and `shared/generated/` together. Order a rollout as core's README says:
   a UI reader for an added field ships before core sends it; for a removal, core stops sending last.
