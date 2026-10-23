# Open issues — Chemclaw3_ui

Open items and accepted risks. A closed item is deleted in the change that closes it; git keeps
the history. File new ones at https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new.

## Open

### The contract is looser than the service in places the UI works around

- Fields with a default are not `required` in the document and carry no `default` when it is
  `None` or a factory, so the generated types say "may be absent" while the service always sends
  them; `Served` in `shared/wire.ts` reads responses as complete. Marking them required in core is
  not a flag: fifteen models (`ExperimentDesign` and the models inside it, `Setpoints` among them)
  are both request and response bodies, so required response fields need core to publish separate
  input and output schemas, which renames those components.
- Sent and not read by any surface: `NoteRef.artifact_refs` / `calc_refs`, `NeighborRef.relations_in`
  / `relations_out`, `ArmRow`'s `atmosphere`, `concentration_molar`, `ph`, `pressure_bar`,
  `PendingRequestOut.reminders`, and `DesignListOut.total` / `.truncated` (the protocols panel has no
  copy for a truncated listing; its owner decides).

### Issue 28: ESLint 10 waits on eslint-plugin-jsx-a11y

`@eslint/js` 10 requires `eslint` 10, and `eslint-plugin-jsx-a11y` (6.10.2, its latest) admits
`eslint` up to 9, so `npm ci` fails with ERESOLVE. `typescript-eslint` and
`eslint-plugin-react-hooks` already admit 10. Move `eslint` and `@eslint/js` together once it does.

### Issue 29: RDKit 2026.9 breaks its own drawing after a long chain

`@rdkit/rdkit` 2026.9.1 canonicalises a chain of ~590 carbons (inside `MAX_PARSED_SMILES_CHARS`)
where 2025.3.4 throws a `RangeError` (`too-complex`), and afterwards every depiction in that runtime
fails (`table index is out of bounds`, or a `WebAssembly.Exception`) while `get_mol` still parses,
so `stillAlive` does not poison it and each structure on the page draws as nothing. Held at
2025.3.4 until upstream fixes it, or the engine's liveness probe draws as well as parses and the cap
is re-measured on the new build. The bump also needs `Mol` / `MainModule` for `JSMol` /
`RDKitModule`, and the binary from the exported subpath `@rdkit/rdkit/RDKit_minimal.wasm`.

### Issue 20: TypeScript 7 waits on typescript-eslint

`npm ci` fails with ERESOLVE until typescript-eslint's peer range admits TypeScript 7. The
migration is its own PR, not a lockfile bump.

### Issue 22: shared sessions — what still needs the service

Queued turns, withdraw, the `turn_started` hand-over, `stream_lagged` reattach and live following
of another member's turn, named by the line's `running_turn`, are built (`src/state/sharedSync.ts`).
Upstream ask: a push hint instead of the 5 s queue poll.

### Issue 23: the OIDC browser lanes' limits

`e2e/bff-auth.spec.ts` (default suite) signs in against a fixture provider and `e2e/oidc-mock.spec.ts`
(the `oidc-mock` CI job) against Chemclaw3_mock's tenant. Open: `e2e/oidc-upstream.ts` is a stand-in
for core's token validator, not core; the mock lane signs in as a public client
(`ENTRA_CLIENT_AUTH=none`) and so does not exercise the client-secret exchange of a Web
registration; both lanes run on one site (`127.0.0.1`), so a browser's cross-site cookie rule for
the redirect back from the provider is checked by hand (`docs/operations.md`, "What a human
verifies").

### Known gaps

- **Flaky once:** `e2e/protocols.spec.ts` ("an edit becomes a new revision…") timed out once on the
  mobile project. Keep the trace from the next occurrence.
- **No screenshot baselines.** The axe pass covers accessibility, not layout regressions.
- **`check:live` is on no schedule.** `smoke` and `check:live-contract` need a live service and run only when an
  operator types them; `tests/gate.test.ts` keeps it out of both pipelines.
- **The sketcher canvas (Ketcher) has no accessible path.** The SMILES field and `.mol`/`.sdf` drop
  are the accessible alternatives, announced in the dialog (`SKETCHER_ALTERNATIVE`); axe excludes
  only `[data-sketcher-canvas]`. Changes if Ketcher ships keyboard editing.

## Accepted risks

### Issue 26: sessions live in one pod's memory

The BFF holds each signed-in person's tokens in its own memory (`AUTH_MODE=bff`, `docs/operations.md`
§8). A release or a dead pod forgets them, so people sign in again (silently while the identity
provider's session lasts), and more than one replica needs the router to keep a browser on one pod
(OpenShift's default cookie affinity does; `deploy/openshift/routes.yaml` states it). Chosen over a
sealed cookie, a core API and Postgres; revisit when releases are frequent enough that the silent
re-sign-in is noticed, or a deployment needs replicas affinity cannot serve.

### Issue 27: no cap on sessions per account

`SESSION_MAX_SESSIONS` bounds a pod's sessions, evicting the least recently used, but nothing
bounds one account's: a person (or an attacker holding valid credentials) who signs in repeatedly
can push others' sessions out of a pod that is near its cap. Accepted because the cap is far above
the pod's load (10,000 sessions for ~200 people), each sign-in needs the identity provider's
consent, and the provider's own policy is where an account's session count is governed. Revisit
if sessions move to a shared store (Issue 26), which can count per account cheaply.

### Issue 11: `canonicalSmiles` may answer "too complex" for a legal long chain

The answer depends on the JavaScript stack at the moment of the call, not only on the input. Every
consumer drops such a molecule rather than keying it by its raw spelling, and the UI says a retry
may differ (`TOO_COMPLEX_EXPLANATION`) without offering one.

### Issue 15: encoding is not a character policy

`%00` / `%0A` inside a wide-class id (`NOTE`, `JOB`, `PENDING` in `server/routes.ts`) is forwarded
encoded; traversal is refused by `isTraversal`. A URL base that is not a compile-time string is
outside the path-encoding scan. Changes if an ingress normalises paths before the service.

### Issue 25: HTML artefact scripts run by default, and WebRTC is outside every wall

Owner decision. Artefact scripts run in an opaque-origin frame on `SANDBOX_ORIGIN` under
`connect-src 'none'`, but can still send data (including anything typed into the page) over
WebRTC and write the clipboard after a click. Controls, strongest first: `HTML_SCRIPTS_DEFAULT=off`;
browser policy (`WebRtcIPHandling=disable_non_proxied_udp`, `media.peerconnection.enabled=false`);
a sandbox host on a separate registrable domain. See README, "HTML sandbox (artefacts)".
