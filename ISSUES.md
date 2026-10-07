# Open issues — Chemclaw3_ui

Open items and accepted risks. A closed item is deleted in the change that closes it; git keeps
the history. File new ones at https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/issues/new.

`tests/backendContract.test.ts` reads this file: an argued wire name in `AHEAD_OF_BACKEND`,
`RETAINED_FOR_ROLLOUT` or `FIELDS_AHEAD_OF_BACKEND` must quote a phrase from an entry here, so
deleting that entry retires the exemption.

## Open

### A maintainer's `CHEMCLAW3_REF` pin may not survive a fork PR

CI resolves the Chemclaw3 checkout ref as dispatch input → `vars.CHEMCLAW3_REF` → `main`
(`scripts/chemclaw3-ref.mjs`, which logs the ref, the arm it came from and whether the run is a
fork PR). Unverified: whether GitHub passes `vars` to fork pull requests. If not, a pinned ref
silently becomes `main` there. To close: run one fork PR while `CHEMCLAW3_REF` is set and read the
first step's log.

### Issue 12: a job ending read off a stream and not yet relayed dies with the tab that read it

The service's mailbox claim is destructive, so a `job_completed` frame read by a tab that dies
before `tab.publish` is lost. `src/state/jobReconcile.ts` recovers the _fact_ on the next takeover
from `GET /jobs/{id}` (seven-day window, ten newest), but not the push-back payload. The remaining
fix is upstream: acknowledge before the claim, or store the push-back payload on the run record.

### Issue 13: the note event is renamed in two repositories, and the last step waits on a rollout

The service now emits `note_recorded`; this client accepts both it and the old `note_proposed`
(normalised to the internal `note_proposed`). Step 3 — remove `note_proposed` from `EVENT_TYPES`
and `normalizeEvent` and rename the internal type — waits until the service's rename has rolled
out to every deployment. `RETAINED_FOR_ROLLOUT` in `tests/backendContract.test.ts` holds the
exemption and its review date.

### Issue 14: what the contract check does not see

`tests/backendContract.test.ts` compares this client against a Chemclaw3 checkout's declarations
(see `docs/production-readiness.md` §2). Outside it:

- **No checkout, no check.** It warns and passes unless `CHEMCLAW3_REQUIRED=1`. The GitHub push
  lane checks Chemclaw3 out; the Jenkins `Gate` stage runs it only when `RUN_GATE` is set. Both
  lanes therefore red on an upstream rename — accepted; the owner of CI decides.
- **Nested element types** are compared only where some route returns them by name; non-model
  responses (`dict`, `list[str]`, `Response`) are printed, not compared. Query parameters are not
  compared.
- **Declared, not served.** What a deployment actually serves is `npm run check:openapi`, which is
  operator-run.
- **`DesignListOut.total` / `.truncated`** are sent and not read (argued in `NOT_READ`): the
  protocols panel has no copy for a truncated listing. The panel's owner decides.

### Issue 20: TypeScript 7 waits on typescript-eslint

`npm ci` fails with ERESOLVE until typescript-eslint's peer range admits TypeScript 7. The
migration is its own PR, not a lockfile bump.

### Issue 21: three unit tests time out on a loaded machine

`tests/turnStall.test.tsx`, `tests/backendContract.test.ts` and `tests/serverLimits.test.ts` fail
under heavy host load and pass alone. Make the first assert order rather than elapsed time, and
give the contract test a timeout derived from what it reads.

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
- **`check:live` is on no schedule.** `smoke` and `check:openapi` need a live service and run only
  when an operator types them; `tests/gate.test.ts` keeps them out of both pipelines.
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
