# Open issues — Chemclaw3_ui

Open items and accepted risks. A closed item is deleted in the change that closes it; git keeps
the history. File new ones at https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new.

## Open

### Issue 12: a job ending read off a stream and not yet relayed dies with the tab that read it

The service's mailbox claim is destructive, so a `job_completed` frame read by a tab that dies
before `tab.publish` is lost. `src/state/jobReconcile.ts` recovers the _fact_ on the next takeover
from `GET /jobs/{id}` (seven-day window, ten newest), but not the push-back payload. The remaining
fix is upstream: acknowledge before the claim, or store the push-back payload on the run record.

### Issue 13: the old spelling of the note event is still admitted

The service emits `note_recorded` (the pinned contract's name). This client also admits the old
`note_proposed` and normalises it onto `note_recorded` (`WIRE_ALIASES` in `shared/events.ts`, pinned
by `tests/eventContract.test.ts`). Remove the alias once the rename has rolled out to every
deployment.

### The design lifecycle is a transcription

`LEGAL_STATUS_MOVES` and `STATUSES_NEEDING_A_PROTOCOL` (`shared/protocols.ts`) copy rules core
enforces in `require_movable`, which the API contract does not carry, and nothing compares them with
core any more (`tests/protocolStatusTransitions.test.ts` holds only that the table is total and
consistent). A wrong table is a button that 422s or a missing one. Needs core to publish the
transitions in the document (an `x-` extension on `StatusIn`, or a route); then generate the table.

### The contract is looser than the service in places the UI works around

Found by typing the UI from the pinned document; each is a request to core, not a UI fix.

- Fields with a default are not `required` and carry no `default` when it is `None` or a factory
  (`Setpoints.ph`, `DesignListOut.designs`, `NoteRef.tags`, ...), so the generated types say
  "may be absent" while the service always sends them. `Served` in `shared/wire.ts` reads responses
  as complete; core marking them required (or emitting the default) would let that go.
- `ExhibitView.spec` / `raw_spec` are `unknown`, so the per-kind specs the document does declare
  (`TableSpec`, `ChartSpec`, ...) are not reachable from the view; the UI validates in
  `shared/exhibits.ts`.
- `DesignOut.kind` and `RevisionSummary.kind` are bare strings; the UI reads `request` or `protocol`.
- `GET /healthz` and `POST /sessions/{id}/turn/stop` answer an unconstrained `object`
  (`shared/wireUntyped.ts`).
- Sent and not read by any surface: `NoteRef.artifact_refs` / `calc_refs`, `NeighborRef.relations_in`
  / `relations_out`, `ArmRow`'s `atmosphere`, `concentration_molar`, `ph`, `pressure_bar`,
  `PendingRequestOut.reminders`, and `DesignListOut.total` / `.truncated` (the protocols panel has no
  copy for a truncated listing; its owner decides).

### Issue 20: TypeScript 7 waits on typescript-eslint

`npm ci` fails with ERESOLVE until typescript-eslint's peer range admits TypeScript 7. The
migration is its own PR, not a lockfile bump.

### Issue 21: two unit tests time out on a loaded machine

`tests/turnStall.test.tsx` and `tests/serverLimits.test.ts` fail under heavy host load and pass
alone. Make the first assert order rather than elapsed time.

### Issue 22: shared sessions — what still needs the service

Queued turns, withdraw, `stream_lagged` reattach and live following of another member's turn are
built (`src/state/sharedSync.ts`). Upstream asks: a `turn_started` frame (or `running_sender` on
`GET /queue`) carrying the sender and question, so a watched turn can say whose it is from the first
token; a push hint instead of the 5 s queue poll; and an explicit "queued turn started" event
(Chemclaw3 #503 item 9) so Withdraw does not race the hand-over.

### Issue 23: the OIDC browser lane's limits

`e2e/oidc-mock.spec.ts` (the `oidc-mock` CI job) signs in against Chemclaw3_mock's tenant. Open:
`e2e/oidc-upstream.ts` is a stand-in for core's token validator, not core; silent renewal is not
exercised in a browser; and a signed-out first load logs a burst of `interaction_in_progress`
warnings because several panels request a token at once — one shared in-flight sign-in would fix it.

### An HTTP surface for subscriptions

`watch_for` / `list_watches` / `stop_watching` are agent tools only, so a chemist cannot see or
cancel a standing query. Needs routes in Chemclaw3 before this UI can show them.

### Known gaps

- **Flaky once:** `e2e/protocols.spec.ts` ("an edit becomes a new revision…") timed out once on the
  mobile project. Keep the trace from the next occurrence.
- **No screenshot baselines.** The axe pass covers accessibility, not layout regressions.
- **`check:live` is on no schedule.** `smoke` needs a live service and runs only when an operator
  types it; `tests/gate.test.ts` keeps it out of both pipelines.
- **The sketcher canvas (Ketcher) has no accessible path.** The SMILES field and `.mol`/`.sdf` drop
  are the accessible alternatives, announced in the dialog (`SKETCHER_ALTERNATIVE`); axe excludes
  only `[data-sketcher-canvas]`. Changes if Ketcher ships keyboard editing.

## Accepted risks

### Issue 8: the access token lives in the browser

Any script on this origin can read the MSAL token, and silent refresh uses a hidden iframe that
third-party-cookie blocking breaks ("people keep getting logged out", Safari/Firefox first). BFF
token custody is built (PR #11, closed, branch retained) and not adopted: it needs a
confidential-client registration (Web platform, client secret, `<origin>/auth/callback`) and two
managed secrets with a rotation owner. The tenant administrator and this app's operations owner
decide; reopen PR #11 rather than rebuild.

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
