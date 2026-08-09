# Backend changes this frontend needs

Five requests against [`8fqycwdt8v-oss/chemclaw3`](https://github.com/8fqycwdt8v-oss/chemclaw3),
written as a specification rather than as a pull request because this session could not be granted
push access to that repository. Every anchor below was read from a checkout at **`8a47952`** — the
same revision `shared/backend-contract.json` was generated from — so the line numbers are real, but
check them against `main` before acting on any of this.

Each item states the frontend limitation it closes, and each corresponds to an entry in
[`ISSUES.md`](../ISSUES.md). **None of them is a bug report.** Three are deliberate positions the
backend has taken and documented in its own comments; what is offered here is the case for
revisiting them, from the one place that has to render the consequence.

Repository conventions worth knowing before writing any of this (from `CLAUDE.md`):
`make lint type test` must be green; tests prove behaviour rather than mocks; every threshold goes
through the `pydantic-settings` config rather than being a literal; a decision of any weight wants
an ADR under `docs/decisions/D-YYYY-MM-DD-<slug>.md` with a row in that directory's README, checked
by `tests/test_decision_log.py`. Migrations are **forward-only numbered SQL** under `infra/sql/`
(currently 000–041), never Alembic, never edited once applied — `tests/test_migrations_are_additive.py`
enforces the first rule and a checksum ledger enforces the second. A new migration must also update
the table inventory in `infra/sql/README.md`, which `tests/test_schema_inventory.py` checks in both
directions.

---

## 1. `GET /jobs` — an opt-in `requested_by=me` filter

**Closes:** `ISSUES.md` §1. The Runs panel filters by `requested_by` in the browser, over whatever
page the backend happened to return. That is a display convenience wearing the costume of a privacy
control, and it is labelled as such in the UI — but a chemist looking for their own run still pages
through everyone's.

**Why this is not simply a bug.** `src/chemclaw/api/routes/jobs.py:29-33` states the position
directly: the list is _not_ owner-scoped, and that is deliberate, because `find_past_jobs` — the
agent tool over the same table — is unscoped so that knowledge crosses projects. Nothing here asks
for that to change. The request is for an **opt-in filter**, default unchanged.

**Where:**

|                |                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Handler        | `src/chemclaw/api/routes/jobs.py:18-35` — takes `text` and `connector` today, nothing else      |
| Query          | `src/chemclaw/durable/job_record.py:146-161` → `src/chemclaw/durable/job_record_store.py:60-67` |
| Response model | `JobRecordSummary`, `src/chemclaw/durable/job_record.py:77-95`                                  |
| Table          | `infra/sql/023_job_records.sql:23-46`                                                           |

**The two-part problem.** `requested_by` is already on every row and is mandatory
(`job_record.py:59`, `Field(min_length=1)`; populated from the Entra actor at
`connector_job.py:235`). But it is absent from **both** the `SELECT` projection
(`job_record_store.py:60-67`) and `JobRecordSummary` — so `GET /jobs` does not merely fail to
filter on it, it does not return it at all. The frontend's "Mine" filter therefore has nothing to
match against unless the deployment is one where the field happens to arrive by another route.

**Suggested shape.** A `requested_by: str = ""` query parameter on `list_jobs`, threaded through
`search_job_records` into the `WHERE` clause in the same `(%s = '' OR col = %s)` style the two
existing filters use, plus `requested_by` added to the projection and to `JobRecordSummary`. The
literal string `me` is best resolved server-side to `principal.oid` rather than having the client
send an oid it should not need to know; an explicit oid could be refused or allowed as the
deployment prefers.

**Cost.** One new numbered migration for an index on `requested_by` — `023` creates none, and
`ORDER BY completed_at DESC LIMIT n` with a new predicate will otherwise scan. Worth measuring
before adding: on a small table the index is not obviously a win.

---

## 2. An answerable MAF `approval_request`

**Closes:** `ISSUES.md` §4, which is the most consequential of the five. The UI receives an
approval prompt it can display and **cannot answer**, so a turn that reaches for
`run_skill_script` stalls with a card the chemist can only read.

**Why it is structurally unanswerable**, not merely unimplemented. Two different things emit
`approval_request`:

- **The durable hold** — `src/chemclaw/api/runner.py:828-843`. Carries `approval_id`, which is a
  Temporal workflow id, and is answered at `POST /approvals/{approval_id}/decision`.
- **MAF's own `function_approval_request`** — `src/chemclaw/api/runner.py:342-343`:

  ```python
  for request in getattr(update, "user_input_requests", None) or []:
      yield ApprovalRequestEvent(prompt=approval_prompt(request))
  ```

  No `approval_id` is passed, so it defaults to `""` (`src/chemclaw/api/events.py:153`).

The empty id cannot be routed around, and it is worth being precise about why, because "add an
endpoint" understates it:

1. All three approval routes are keyed on a `{approval_id}` path parameter
   (`routes/approvals.py:76-82`). `POST /approvals//decision` matches nothing.
2. Every backing call resolves that id as a **Temporal workflow handle**
   (`agent/interaction_tools.py:104`, `:114`, `:153`). A MAF approval has no workflow.
3. The `owned_approval` dependency (`api/deps.py:161-180`) resolves an owner before the handler
   runs; with `""` it raises `ValueError` → 404. A MAF request carries no owner either.
4. `GET /approvals` cannot even list it: `list_pending_approvals`
   (`agent/interaction_tools.py:121-147`) is a Temporal visibility query over
   `InteractionApprovalWorkflow` executions.
5. Nothing feeds a decision back into the running `agent.run` stream — there is no
   `ToolApprovalMiddleware`. `agent/chemclaw_agent.py:519-534` says so and works around it by
   disabling approval on two of the three tools that would otherwise require it:

   ```python
   # MAF registers `load_skill`/`read_skill_resource` with `approval_mode="always_require"`
   # by default, and nothing here answers an approval (no `ToolApprovalMiddleware`, no
   # front-door decision endpoint) — so every turn that reaches for a skill would otherwise
   # stall on an unanswerable `user_input_requests` entry.
   disable_load_skill_approval=True,
   ```

`run_skill_script` is deliberately left at `always_require`, and
`tests/test_agent.py:139-141` asserts it — so the stall is reachable by design, not by accident.

**What would close it.** Either an answer channel for MAF approvals (a decision route keyed on
session id plus a per-request token, with the turn loop awaiting it), or — if that is not wanted —
an explicit signal on the event that this prompt is informational, so the UI can say "this turn is
waiting and cannot be released from here" instead of showing controls that do nothing.

**A smaller, free fix regardless of the above.** The docstring on `ApprovalRequestEvent`
(`api/events.py:150-152`) says an empty id means "a plan-approval prompt, which is answered by the
next turn". That is wrong, and `runner.py:840-842` already contains the correction — plan approval
is `chemclaw.agent.plan_gate` and never reaches this stream. The stale docstring is what a frontend
reads first.

---

## 3. Persist `confidence` / `review_required` / `verified_by`

**Closes:** `ISSUES.md` §3. A conversation reloaded from the transcript renders its answers
**without** the badges that qualified them. The UI leaves them blank rather than defaulting to
"clean", which is the right call — but it means a caveated answer and an unqualified one look
identical after a reload, which is precisely the "a qualified answer renders as a clean one"
failure this frontend has now been through twice.

**Where:**

|           |                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Produced  | `src/chemclaw/api/runner_answer.py:111-117`                                                          |
| Emitted   | `src/chemclaw/api/runner.py:455`, as the `answer` SSE event                                          |
| Stored    | `src/chemclaw/agent/session_store.py:283-315` — `Jsonb(message.to_dict())`, the MAF message verbatim |
| Table     | `infra/sql/008_sessions.sql:10-15`                                                                   |
| Read back | `src/chemclaw/api/schemas.py:213-250`                                                                |

The backend already states the position, at `schemas.py:220-225`:

> Plan snapshots, attachment references and the answer's `confidence`/`review_required` were
> **never persisted** — they are turn-time events computed and streamed, and nothing writes them to
> `session_messages`. Recovering those is a change to what a turn _stores_, not to how it is read,
> so it is a separate decision rather than something this can quietly approximate.

That is exactly right, and this is the request to make that separate decision. Three fields, all
already computed, all currently discarded at the moment the stream ends.

**Note the shape constraint.** `session_messages.message` holds `Message.to_dict()` verbatim, and
`008_sessions.sql`'s own header says the store does not interpret it — so a MAF message-shape
change is a value change, not a schema change. Writing verification metadata into MAF's
`additional_properties` would honour that and need no migration; a sidecar table or a new column
would be cleaner to query but is a schema change with the full migration ceremony. That trade is
the backend's to make.

**The frontend is ready either way.** `TranscriptMessage` in `src/api/client.ts` already documents
these three as not-persisted, and `MessageList` renders the badges from live events today — so this
becomes three optional fields on the transcript model and nothing else.

---

## 4. `Retry-After` in `expose_headers`

**Closes:** nothing user-visible yet, and that is the point — this is cheap and prevents a future
bug rather than fixing a current one.

`src/chemclaw/api/middleware.py:206-215` configures `CORSMiddleware` with `allow_origins`,
`allow_methods` and `allow_headers`, and **no `expose_headers`** — so Starlette's default of `()`
applies and a cross-origin caller can read only the CORS-safelisted response headers.
`Retry-After` is not one of them.

It does not bite this repo, because the BFF is same-origin with the browser and forwards
`retry-after` itself. It bites any other browser client, and it makes the header's one setter
misleading: `src/chemclaw/api/auth.py:255-264` computes a precise backoff —

```python
headers={"Retry-After": str(max(1, int(exc.retry_after_seconds + 0.999)))},
```

— specifically "so a client backs off by the right amount rather than guessing", and a
cross-origin client cannot read it.

**Two adjacent inconsistencies found while confirming this**, both worth folding in:

- The comment at `auth.py:260-262` says the value is "the same courtesy the budget guard's 429
  already extends". The budget guard does not: `routes/turns.py:212` raises a bare
  `HTTPException(status_code=429, detail=str(exc))` with no headers. The comment asserts a property
  the code does not have.
- `routes/streams.py:91` — the concurrent-stream cap — also answers 429 with no `Retry-After`.
  This one is the frontend's most-hit 429 by a wide margin: `useJobFeed` backs off on it, and it
  currently guesses because it must (`src/hooks/useJobFeed.ts`, `backoff(6, …)`).

---

## 5. `WWW-Authenticate` on 401

**Closes:** nothing that is broken, and this is the weakest of the five. Recorded because it is one
line and because the frontend now has a place to use it.

`src/chemclaw/api/auth.py:224` and `:236` construct both 401s, and a repository-wide search for
`WWW-Authenticate` returns zero matches. RFC 9110 §11.6.1 makes the header a **MUST** on a 401, and
its `error="invalid_token", error_description=…` form (RFC 6750 §3) is the only machine-readable
way for a client to distinguish an expired token from an invalid one.

**Why the frontend cares now.** Under `AUTH_MODE=bff` a 401 means one of two very different things:
the session is genuinely gone (sign in again) or the backend refused a perfectly good token for its
own reason — an audience or issuer mismatch, most likely — in which case redirecting to Entra
succeeds, returns, and hits the same 401 forever. `src/auth/bffAuth.ts` currently disambiguates by
asking `/auth/me`, which works but is an extra round trip inferring something the 401 could simply
have said.

**Careful about the security posture.** `auth.py:232-236` deliberately withholds the specific
failure reason from the caller (SEC-7), logging it instead. That is a good decision and this must
not undo it. The ask is only for the standard `Bearer realm="…", error="invalid_token"` — the
coarse category, not the audience/issuer/expiry detail.

---

## Cross-reference

| #   | `ISSUES.md` | Backend anchor             | Frontend limitation                       |
| --- | ----------- | -------------------------- | ----------------------------------------- |
| 1   | §1          | `routes/jobs.py:18-35`     | "Mine" filters client-side over one page  |
| 2   | §4          | `runner.py:342-343`        | An approval card that can only be read    |
| 3   | §3          | `runner_answer.py:111-117` | A reloaded answer loses its caveats       |
| 4   | —           | `middleware.py:206-215`    | `Retry-After` unreadable cross-origin     |
| 5   | —           | `auth.py:224`, `:236`      | Expired vs invalid needs a second request |
