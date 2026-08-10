# Handoff: make `GET /sessions` answer the question a conversation list asks

**For a session in [`8fqycwdt8v-oss/Chemclaw3`](https://github.com/8fqycwdt8v-oss/Chemclaw3), not
this repo.** It lives here only because it was written here and could not be pushed there — the
session that produced it had read access to the backend and no write credential. Chemclaw3's own
`CLAUDE.md` is right that changes must not be proxied through this repo; this is a specification
and a verified patch, not the change itself.

**Status: implemented and verified, not speculative.** Everything below was run against a real
Postgres 16 before being written down — 4049 tests passed, `ruff check`, `ruff format --check` and
strict `mypy src examples tests` clean across 613 files. The patch at the end is a
`git format-patch` of that exact commit. If it still applies, `git am` it and re-run the gate; if
main has moved, the design notes are the part worth keeping and the diff is a reference.

Closes the backend half of `ISSUES.md` issues 4 and 7 in this repo.

---

## The problem

`SessionSummary` is `{session_id, created_at}`, and a sidebar cannot be built from that.

This repo proves it by working around it. Every conversation restored from another device gets the
same placeholder name, because there is nothing to name it with, and the list is ordered by when
each session was _started_. Ten conversations are ten identical rows, sorted so the one most likely
to be wanted — an old one recently returned to — sits at the bottom.

Two facts are missing and one class of row should not be there at all:

|                            | today                                          | wanted                                                 |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| name                       | absent                                         | `title`, from the message that opened the conversation |
| recency                    | `created_at`, i.e. when the session was minted | `updated_at`, the last stored message                  |
| warmed-but-unused sessions | listed                                         | not listed                                             |

The third is this repo's doing and worth stating plainly: the UI creates the backend session on the
first keystroke so the first message costs one round-trip instead of two. Every abandoned draft
therefore leaves an ownership row behind, and `GET /sessions` lists it. A client cannot filter them
out from outside — a session nobody spoke in and a session whose transcript failed to load are both
an empty array.

## Three decisions that are not obvious

Get these wrong and the change looks the same but is worse.

### 1. The name is a column, not an expression over the stored message

The tempting version extracts the first user message's text from `session_messages.message`. Do not.
`infra/sql/008_sessions.sql` is explicit that the store does not interpret that JSONB — _"a MAF
message-shape change is a value change, not a schema change"_ — so a `message->'contents'`
expression quietly converts every future MAF change into a broken conversation list.

The turn route already holds the user's message as a plain string. It writes the title from there
and nothing parses anything. This follows migration 021's precedent for `profile` exactly: the row
is already "the facts about a session that must survive the LRU", and a name is one of them.

### 2. Last activity is derived, not mirrored

`max(session_messages.created_at)`, not an `updated_at` column on `session_owners`. The turn that
would have to maintain a mirror already writes the row the derivation reads, and a second write per
turn is a second thing that can fall out of step.

### 3. The lateral join is also the filter

`max()` with no `GROUP BY` always returns a row — NULL when there is nothing to aggregate — so an
inner join on `updated_at IS NOT NULL` drops precisely the sessions nobody ever spoke in. One query
answers "what was the last activity" and "was there any". **This is why the change needs no cleanup
job for warmed sessions**, which is what `ISSUES.md` issue 7 asked for.

### And one that is obvious only once it bites

`set_title_if_absent` is called on **every** turn — the route has no cheap way to know which one is
first — so the `title IS NULL` guard in the statement is what makes that safe. Without it a sidebar
entry renames itself on every message, which is the one thing a navigation label must not do. One
conditional `UPDATE` on the primary key, not a read-then-write: the second shape costs two
round-trips to discover it has nothing to do and can lose a race between them.

## Two things the suite catches, and you should let it

Both of these were caught by running the real tests, and neither is visible from reading the code.

- **`tests/test_database_privileges.py`** fails on the new `UPDATE`. Under a split-principal
  deployment the title write raises `InsufficientPrivilege` **in production**. The grant in
  `infra/sql/grants/app_privileges.sql` said, in a comment, _"no update: `session_owners` upserts
  with `DO NOTHING`"_ — true until this change made it false. The grant is necessarily wider than
  the write, because SQL has no column-level "only while null" privilege; say so where you widen it.
- **`tests/test_schema_inventory.py`** requires `043` in the Migration cell of **both** tables the
  migration touches (`session_owners` for the column, `session_messages` for the index), not just
  the one it adds a column to. `infra/sql/README.md` lines 50 and 53.

## Running the gate offline

No Postgres in a fresh sandbox, and the distro's pgvector is too old for one of the fingerprint
migrations (`bit_jaccard_ops` needs ≥ 0.7; Ubuntu ships 0.6). This is what made the verification
above possible:

```bash
# Postgres 16 is already on the image; it refuses to run as root.
useradd -m pgrunner
mkdir -p /tmp/pgdata && chown pgrunner /tmp/pgdata && chmod 700 /tmp/pgdata
export PATH=/usr/lib/postgresql/16/bin:$PATH
su pgrunner -c "PATH=$PATH initdb -D /tmp/pgdata -U postgres --auth=trust"
su pgrunner -c "PATH=$PATH pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o '-p 5432 -k /tmp' -w start"

# pgvector 0.8 from source; 0.6 from apt fails migration 012 on bit_jaccard_ops.
apt-get update && apt-get install -y postgresql-server-dev-16 build-essential
git clone --depth 1 --branch v0.8.0 https://github.com/pgvector/pgvector.git /tmp/pgvector
cd /tmp/pgvector && make && make install

export CHEMCLAW_POSTGRES_DSN="postgresql://postgres@127.0.0.1:5432/postgres"
uv sync --frozen        # bofire[optimization] pulls BoTorch/PyTorch — several GB, several minutes
uv run pytest && uv run ruff check . && uv run ruff format --check . && uv run mypy src examples tests
```

Expect **4049 passed, 37 skipped**. The skips are the `xtb`/`crest` binaries and the Temporal test
server, none of which this change touches.

## What consumes it on this side

Once `SessionSummary` carries `title` and `updated_at`, three things here get simpler, and each is
currently carrying a comment that points at this document's absence:

- `src/components/Sidebar.tsx` sets `title: 'Earlier conversation'` unconditionally, and sorts by
  `created_at`. Both become real once the fields arrive.
- `src/state/chatStore.ts`'s `hydrateTranscript` derives the title from the first user message. That
  stays as a fallback for an older service, but stops being the only source.
- `src/api/client.ts`'s `SessionSummary` has no `title` — the phantom optional field was removed
  when the server was confirmed never to send one. Add it back as required when the server does.

None of that is blocking: the UI works against a service with or without these fields, which is why
the mitigation shipped first.

---

## The patch

`git am` this in a Chemclaw3 checkout. The commit message inside it carries the same reasoning as
the sections above, so the history stands on its own if this file is not around later.

```diff
diff --git a/infra/sql/043_session_listing.sql b/infra/sql/043_session_listing.sql
new file mode 100644
index 0000000..c67fd39
--- /dev/null
+++ b/infra/sql/043_session_listing.sql
@@ -0,0 +1,34 @@
+-- What a conversation list needs beyond "this session exists": a name, and a last-activity.
+--
+-- `GET /sessions` returned `(session_id, created_at)`, which is not enough to render the sidebar it
+-- exists to render. The companion UI showed every restored conversation as the same placeholder
+-- string and sorted them by the wrong date, and it could not do better from the outside: a title
+-- has to come from the conversation's content, and "when was this last used" is not a fact
+-- `session_owners` holds.
+--
+-- **The title is a column here rather than a query over `session_messages`.** Deriving it in SQL
+-- means reaching into the stored MAF payload for the first user message's text, and `008_sessions`
+-- is explicit that the store does not interpret that JSONB — "a MAF message-shape change is a value
+-- change, not a schema change". A SQL expression that reads `message->'contents'` would quietly
+-- convert every future MAF shape change into a broken conversation list. The front door already has
+-- the user's message as a plain string when it accepts a turn, so it writes the title from there
+-- and nothing has to parse anything.
+--
+-- Nullable, and for the same reason `owner` and `profile` are: a session that has never had a turn
+-- genuinely has no title, and NULL is the honest value. This follows 021's argument exactly — this
+-- row is "the facts about a session that must survive the LRU", and a name is one of them.
+ALTER TABLE session_owners ADD COLUMN IF NOT EXISTS title TEXT;
+
+-- The last-activity half is derived, not stored: `max(session_messages.created_at)` per session.
+-- Deriving beats denormalising here because the write path for a turn already inserts into
+-- `session_messages`, and a mirrored `updated_at` on `session_owners` would be a second write per
+-- turn that can silently fall out of step with the first.
+--
+-- This index is what makes deriving it cheap. The listing runs one lateral `max(created_at)` per
+-- session the caller owns, and neither existing index serves that: `session_messages (session_id,
+-- id)` from 008 is ordered by insertion id, and `(created_at, session_id)` from 022 leads with the
+-- wrong column for a per-session lookup. With this one each lookup is a single backwards index
+-- probe instead of a scan of that session's rows — the same reasoning 022 gave when retention grew
+-- a new access path.
+CREATE INDEX IF NOT EXISTS session_messages_session_recent_idx
+    ON session_messages (session_id, created_at DESC);
diff --git a/infra/sql/README.md b/infra/sql/README.md
index 94f7a0c..f218739 100644
--- a/infra/sql/README.md
+++ b/infra/sql/README.md
@@ -47,10 +47,10 @@ the pair applies in filename order and neither shadows the other.
 | `reaction_fingerprints` | 003 (+004) | `science/fingerprints/store.py` | — |
 | `audit_events` | 006 (+010, 011, 026) | `agent/audit_store.py` | **refused**: deleting from a hash chain is indistinguishable from the tampering it detects. Safe disposal needs archive-then-reseal — BACKLOG STO-13 |
 | `sync_cursors` | 007 | `ingest/eln/cursor.py` | — (one row per ingest source; bounded by the source count) |
-| `session_messages` | 008 (+022, 026) | `agent/session_store.py` | `durable/retention.py`, per session through the pairing closure (D-145), plus in-line compaction on write (D-151) |
+| `session_messages` | 008 (+022, 026, 043) | `agent/session_store.py` | `durable/retention.py`, per session through the pairing closure (D-145), plus in-line compaction on write (D-151) |
 | `session_events` | 009 (+014, 028) | `agent/session_events.py` | `durable/retention.py`, **consumed rows only** — an undelivered push-back must outlive the window that would have destroyed it |
 | `note_index` | 012 (+035, 039) | `retrieval/vector_index.py` | derived and rebuildable (`make reindex`, which now also heals a model change); rows for deleted notes are not removed |
-| `session_owners` | 013 (+021) | `agent/session_store.py` | — (survives its session's pruned history; BACKLOG) |
+| `session_owners` | 013 (+021, 043) | `agent/session_store.py` | — (survives its session's pruned history; BACKLOG) |
 | `user_preferences` | 015 | `agent/preferences.py` | — |
 | `predictions` | 016 | `science/calc/calibration.py` | — |
 | `subscriptions` | 017 (+029) | `agent/subscriptions.py` | deleted on unsubscribe |
diff --git a/infra/sql/grants/app_privileges.sql b/infra/sql/grants/app_privileges.sql
index abdf1c4..9ac8af1 100644
--- a/infra/sql/grants/app_privileges.sql
+++ b/infra/sql/grants/app_privileges.sql
@@ -72,12 +72,15 @@ BEGIN
     -- the sequence *is* the history (031), so an UPDATE would rewrite it.
     EXECUTE format('GRANT INSERT ON bo_suggestions TO %I', app_role);
 
-    -- Insert and delete, no update: `session_owners` upserts with `DO NOTHING` (first writer wins),
-    -- so it needs no UPDATE — but offboarding removes a departed person's ownership rows along with
-    -- the sessions they key (`chemclaw.agent.leaver`), so it does need DELETE. Kept on its own line
-    -- because that combination is unlike every other group here, and folding it into the full-DML
-    -- list below would silently hand it the UPDATE its writer deliberately does not use.
-    EXECUTE format('GRANT INSERT, DELETE ON session_owners TO %I', app_role);
+    -- Insert, delete, and now a narrow update. The row is still written once by its creator
+    -- (`ON CONFLICT DO NOTHING`, first writer wins), and offboarding removes a departed person's
+    -- ownership rows along with the sessions they key (`chemclaw.agent.leaver`), which is the
+    -- DELETE. The UPDATE is `set_title_if_absent`: a session is named after its opening question,
+    -- and that name is not known until the first turn arrives, so it cannot be part of the insert.
+    -- Guarded by `title IS NULL` in the statement itself, so the privilege is wider than the write
+    -- — SQL has no column-level "only while null" — which is the usual shape and the reason this
+    -- group is still spelled out on its own line rather than folded into the full-DML list below.
+    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON session_owners TO %I', app_role);
 
     -- Full DML, because the application genuinely deletes from these: the retention sweep prunes
     -- conversation history and spent mailbox rows, artifact eviction reclaims cold blobs, a turn
diff --git a/src/chemclaw/agent/session_store.py b/src/chemclaw/agent/session_store.py
index 6b99eb9..bc7daf7 100644
--- a/src/chemclaw/agent/session_store.py
+++ b/src/chemclaw/agent/session_store.py
@@ -111,10 +111,33 @@ _OWNER_SELECT = "SELECT owner, profile FROM session_owners WHERE session_id = %s
 # Newest first: a session list is read as "what was I just working on", and the caller pages from
 # the top. `owner IS NOT DISTINCT FROM %s` rather than `=` so the shared dev principal (a real NULL
 # owner) matches itself instead of dropping every row to SQL's three-valued logic.
+#
+# "Newest" is the last message now, not the row's `created_at`, which is when the session was
+# *started*. The two diverge exactly where it matters: a session opened last Tuesday and abandoned
+# sorted above one used an hour ago, so the top of the list was the least likely thing to be wanted.
+# `created_at` still comes back, because when a conversation began is worth showing; it just no
+# longer decides the order.
+#
+# The lateral is also the filter, deliberately rather than as a trick. `max()` with no GROUP BY
+# always returns a row — NULL when there is nothing to aggregate — so `ON m.updated_at IS NOT NULL`
+# drops precisely the sessions that have never had a turn. Those exist in bulk: the companion UI
+# creates the session on the first keystroke to save a round-trip on the first message, so every
+# abandoned draft leaves an ownership row behind. Listing them handed a caller a column of empty
+# conversations it could not tell apart from ones whose transcript had failed to load — both are an
+# empty array from outside. One join answers "what was the last activity" and "was there any".
 _OWNER_LIST = (
-    "SELECT session_id, created_at FROM session_owners "
-    "WHERE owner IS NOT DISTINCT FROM %s ORDER BY created_at DESC, session_id DESC LIMIT %s"
+    "SELECT o.session_id, o.created_at, m.updated_at, o.title FROM session_owners o "
+    "JOIN LATERAL ("
+    "  SELECT max(created_at) AS updated_at FROM session_messages WHERE session_id = o.session_id"
+    ") m ON m.updated_at IS NOT NULL "
+    "WHERE o.owner IS NOT DISTINCT FROM %s "
+    "ORDER BY m.updated_at DESC, o.session_id DESC LIMIT %s"
 )
+# First writer wins, in one statement and without a read first. A title is derived from a session's
+# opening question, so every later turn would otherwise overwrite it; `title IS NULL` is what lets
+# the turn route call this unconditionally and stay correct. Naming a conversation after how it
+# started rather than where it drifted to is what makes a sidebar scannable.
+_OWNER_TITLE = "UPDATE session_owners SET title = %s WHERE session_id = %s AND title IS NULL"
 
 
 def _crossed_new_compaction_bucket(count_before: int, count_after: int, floor: int) -> bool:
@@ -441,18 +464,43 @@ class SessionOwnerStore:
             return (False, None, None)
         return (True, row[0], row[1])
 
-    async def list_for_owner(self, owner: str | None) -> list[tuple[str, datetime]]:
-        """The owner's sessions as `(session_id, created_at)`, newest first, capped by config.
+    async def set_title_if_absent(self, session_id: str, title: str) -> None:
+        """Name a session after its opening question, once (see `_OWNER_TITLE`).
+
+        Called on every turn and expected to match nothing after the first, which is why it is one
+        conditional `UPDATE` on the primary key rather than a read followed by a write: the second
+        shape costs two round-trips to discover it has nothing to do, and can lose a race between
+        them. Against a turn that is about to spend seconds in a model, one indexed no-op write does
+        not register.
+        """
+        async with self._connection() as conn:
+            async with conn.cursor() as cur:
+                await cur.execute(_OWNER_TITLE, (title, session_id))
+            await conn.commit()
+
+    async def list_for_owner(
+        self, owner: str | None
+    ) -> list[tuple[str, datetime, datetime, str | None]]:
+        """The owner's sessions as `(session_id, created_at, updated_at, title)`, newest first.
+
+        Capped by `service_max_listed_sessions`, and ordered by `updated_at` — see `_OWNER_LIST`
+        for why that is not `created_at`, and why a session with no messages is not listed at all.
 
         This table is already the durable answer to "which sessions exist and who owns them", so
         listing reads it directly rather than adding a second registry that could disagree with the
-        one `_resolve_session` authorizes against.
+        one `_resolve_session` authorizes against. `updated_at` is derived from `session_messages`
+        rather than mirrored onto a column here, because the turn that would have to maintain a
+        mirror already writes the row the derivation reads — a second write per turn is a second
+        thing that can fall out of step.
+
+        A tuple rather than a record type, matching `lookup` above: this module is below the API
+        layer that consumes it, so a shared shape would have to live somewhere neither of them owns.
         """
         async with self._connection() as conn:
             async with conn.cursor() as cur:
                 await cur.execute(_OWNER_LIST, (owner, settings.service_max_listed_sessions))
                 rows = await cur.fetchall()
-        return [(row[0], row[1]) for row in rows]
+        return [(row[0], row[1], row[2], row[3]) for row in rows]
 
 
 class SessionTurnClaims:
diff --git a/src/chemclaw/api/routes/sessions.py b/src/chemclaw/api/routes/sessions.py
index be8a7c9..2f3008e 100644
--- a/src/chemclaw/api/routes/sessions.py
+++ b/src/chemclaw/api/routes/sessions.py
@@ -84,13 +84,20 @@ async def list_sessions(
     Empty under the in-memory session store: there is no durable registry to enumerate, and
     reporting the process's live LRU instead would answer a question about the deployment
     with a partial, eviction-dependent guess.
+
+    Ordered by last activity and carrying each session's name, because a list of ids and start
+    dates is not a conversation list — see `SessionSummary`. Sessions that were created and never
+    used are not listed at all; the query that establishes the last activity is the same one that
+    establishes there was any.
     """
     owners: SessionOwners | None = state(request).session_owners
     if owners is None:
         return []
     return [
-        SessionSummary(session_id=session_id, created_at=created_at)
-        for session_id, created_at in await owners.list_for_owner(principal.oid)
+        SessionSummary(
+            session_id=session_id, created_at=created_at, updated_at=updated_at, title=title
+        )
+        for session_id, created_at, updated_at, title in await owners.list_for_owner(principal.oid)
     ]
 
 
diff --git a/src/chemclaw/api/routes/turns.py b/src/chemclaw/api/routes/turns.py
index dd785e4..bb81e7b 100644
--- a/src/chemclaw/api/routes/turns.py
+++ b/src/chemclaw/api/routes/turns.py
@@ -22,7 +22,7 @@ from chemclaw.api.deps import CurrentSession, CurrentUser
 from chemclaw.api.events import ErrorEvent, QueuedEvent
 from chemclaw.api.middleware import _AT_CAPACITY
 from chemclaw.api.runner import run_turn
-from chemclaw.api.schemas import MessageIn
+from chemclaw.api.schemas import MessageIn, session_title
 from chemclaw.api.state import (
     _WORKER_ID,
     SessionTurns,
@@ -77,6 +77,15 @@ async def post_message(
         raise HTTPException(status_code=409, detail="a turn is already running for this session")
     semaphore = front.turn_semaphore
 
+    # Name the session after the message that opened it, so `GET /sessions` can render a
+    # conversation list rather than a column of ids. Here rather than in the history provider
+    # because here the message is still a plain string — the provider stores an opaque MAF payload
+    # it is not allowed to interpret. After the turn claim, so a rejected double-submit does not
+    # write; before the stream, so a turn that fails mid-answer still leaves the conversation named.
+    # `set_title_if_absent` is a no-op once there is a title, which is every turn after the first.
+    if front.session_owners is not None:
+        await front.session_owners.set_title_if_absent(session_id, session_title(body.message))
+
     async def _turn_events() -> AsyncIterator[dict[str, str]]:
         # Release the permit and the session's turn slot when the stream ends — normal
         # completion, error, timeout, or client disconnect (the generator is closed, running
diff --git a/src/chemclaw/api/schemas.py b/src/chemclaw/api/schemas.py
index b17104c..958173c 100644
--- a/src/chemclaw/api/schemas.py
+++ b/src/chemclaw/api/schemas.py
@@ -22,6 +22,11 @@ from chemclaw.kg.proposal import NoteProposal
 # sweep, and a reload must not ship one per call.
 _TRANSCRIPT_ARG_CHARS = 400
 
+# How much of the opening message becomes the session's name. Sized so a client can truncate to
+# whatever its sidebar is wide enough for — a server that pre-truncated to 40 would have thrown away
+# what a wider surface wanted, and nothing downstream can put it back.
+_TITLE_CHARS = 120
+
 
 class MessageIn(BaseModel):
     """One turn's user message posted to the messages endpoint."""
@@ -62,10 +67,24 @@ class SessionOut(BaseModel):
 
 
 class SessionSummary(BaseModel):
-    """One of the caller's sessions, for the conversation list."""
+    """One of the caller's sessions, for the conversation list.
+
+    `session_id` and `created_at` were the whole of this, and a sidebar cannot be built from them:
+    there is no name to show and no way to order by recency. The companion UI worked around it by
+    labelling every restored conversation with the same placeholder and renaming it only once the
+    chemist opened it and its transcript came back — so ten restored conversations were ten
+    identical rows until nine of them had been clicked.
+
+    `updated_at` is the last stored message, not this row's `created_at`, which is when the session
+    was *started* — the difference between "what have I been working on" and "what did I once open".
+    """
 
     session_id: str
     created_at: datetime
+    updated_at: datetime
+    # Null for a session whose first turn predates this field, so a client can tell "never named"
+    # from "named with an empty string" — only one of those is a bug worth reporting.
+    title: str | None = None
 
 
 class TranscriptToolCall(BaseModel):
@@ -210,6 +229,22 @@ class PlanStatusOut(BaseModel):
     decided_by: str | None = None
 
 
+def session_title(message: str) -> str:
+    """A session's name, from the message that opened it.
+
+    Here, in the pure-projections half of this module, because that is what it is: the turn route
+    hands over the user's message as a plain string and gets back the string to store. Deriving it
+    from the *stored* message instead would mean reading the MAF payload out of `session_messages`,
+    which `infra/sql/008_sessions.sql` is explicit the store must not interpret.
+
+    Collapsed and bounded, not summarised. A title that paraphrases is a title that can be wrong,
+    and this one names a row a chemist navigates by. The cap is generous — enough that a surface can
+    truncate to its own width without the server having pre-truncated to a narrower one, which is
+    the mistake that cannot be undone downstream.
+    """
+    return " ".join(message.split())[:_TITLE_CHARS]
+
+
 def _transcript(stored: "Sequence[Any]") -> list[TranscriptMessage]:
     """Flatten stored MAF messages into the transcript contract, pairing calls with their results.
 
diff --git a/src/chemclaw/api/state.py b/src/chemclaw/api/state.py
index cfe783d..f961edc 100644
--- a/src/chemclaw/api/state.py
+++ b/src/chemclaw/api/state.py
@@ -129,8 +129,18 @@ class SessionOwners(Protocol):
         """Return `(found, owner, profile)` for a session id — all-None when unknown."""
         ...
 
-    async def list_for_owner(self, owner: str | None) -> list[tuple[str, datetime]]:
-        """The owner's sessions as `(session_id, created_at)`, newest first."""
+    async def set_title_if_absent(self, session_id: str, title: str) -> None:
+        """Name a session after its opening question; a no-op once it has a name."""
+        ...
+
+    async def list_for_owner(
+        self, owner: str | None
+    ) -> list[tuple[str, datetime, datetime, str | None]]:
+        """`(session_id, created_at, updated_at, title)`, newest activity first.
+
+        Sessions with no messages are not listed — see `_OWNER_LIST` in
+        `chemclaw.agent.session_store` for both that and why the order is `updated_at`.
+        """
         ...
 
 
diff --git a/tests/test_service.py b/tests/test_service.py
index 54fa125..be6d2df 100644
--- a/tests/test_service.py
+++ b/tests/test_service.py
@@ -680,6 +680,12 @@ class _FakeOwnerStore:
         # profile survive an eviction rather than a fake supplying what the column would (REV-14).
         self.profiles: dict[str, str | None] = {}
         self.created: dict[str, datetime] = {}
+        # The two facts a conversation list is built from. `titles` is written by the turn route on
+        # a session's first turn, which is also what makes a session *listable* — the real query
+        # derives last-activity from `session_messages` and drops a session with none, so here a
+        # session with no `updated` entry is one nobody has spoken in.
+        self.titles: dict[str, str] = {}
+        self.updated: dict[str, datetime] = {}
 
     async def record(self, session_id: str, owner: str | None, profile: str | None = None) -> None:
         if session_id not in self.owners:
@@ -695,9 +701,23 @@ class _FakeOwnerStore:
             return (True, self.owners[session_id], self.profiles[session_id])
         return (False, None, None)
 
-    async def list_for_owner(self, owner: str | None) -> list[tuple[str, datetime]]:
-        rows = [(sid, self.created[sid]) for sid, own in self.owners.items() if own == owner]
-        return sorted(rows, key=lambda row: row[1], reverse=True)
+    async def set_title_if_absent(self, session_id: str, title: str) -> None:
+        self.titles.setdefault(session_id, title)
+        # Stands in for the message row the real turn would have written: a turn happened, so this
+        # session now has a last activity and starts being listed.
+        self.updated[session_id] = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
+            minutes=len(self.updated)
+        )
+
+    async def list_for_owner(
+        self, owner: str | None
+    ) -> list[tuple[str, datetime, datetime, str | None]]:
+        rows = [
+            (sid, self.created[sid], self.updated[sid], self.titles.get(sid))
+            for sid, own in self.owners.items()
+            if own == owner and sid in self.updated
+        ]
+        return sorted(rows, key=lambda row: row[2], reverse=True)
 
 
 class _SharedTurnClaims:
@@ -818,13 +838,24 @@ def test_a_failed_postgres_checkout_sheds_with_503_and_is_counted() -> None:
     assert METRICS.value("chemclaw_db_unavailable_total") == before + 1
 
 
-def test_session_list_is_owner_scoped_and_newest_first() -> None:
-    """`GET /sessions` returns the caller's own sessions, newest first — and nobody else's.
+def _turn(client: TestClient, session_id: str, message: str) -> None:
+    """Run one turn to completion, so the session has an activity and a name."""
+    with client.stream("POST", f"/sessions/{session_id}/messages", json={"message": message}) as r:
+        assert r.status_code == 200
+        for _ in r.iter_lines():
+            pass
+
+
+def test_session_list_is_owner_scoped_and_most_recently_used_first() -> None:
+    """`GET /sessions` returns the caller's own sessions, most recently used first — nobody else's.
 
     The list is how a client that lost its local state finds sessions it still owns; ids are
     minted server-side, so one it forgot is otherwise unreachable while its history sits in the
     store. Scoping is the security half: a session id is a capability, and listing someone else's
     would hand it out.
+
+    Ordered by last activity rather than by creation, which is the order a conversation list is
+    actually read in — `first` is used again below and has to come back to the top.
     """
     from chemclaw.api.auth import Principal, require_principal
 
@@ -836,18 +867,75 @@ def test_session_list_is_owner_scoped_and_newest_first() -> None:
     app.dependency_overrides[require_principal] = lambda: alice
     first = client.post("/sessions").json()["session_id"]
     second = client.post("/sessions").json()["session_id"]
+    _turn(client, first, "What is the pKa of acetic acid?")
+    _turn(client, second, "Which ligand for the Suzuki?")
     app.dependency_overrides[require_principal] = lambda: bob
     bobs = client.post("/sessions").json()["session_id"]
+    _turn(client, bobs, "Bob's question.")
 
     app.dependency_overrides[require_principal] = lambda: alice
     listed = [row["session_id"] for row in client.get("/sessions").json()]
-    assert listed == [second, first]  # newest first
+    assert listed == [second, first]
     assert bobs not in listed
 
+    # Returning to the older conversation moves it to the top. Under the previous ordering — the
+    # row's creation date — it would have stayed second forever, which is the whole complaint.
+    _turn(client, first, "And in DMSO?")
+    assert [row["session_id"] for row in client.get("/sessions").json()] == [first, second]
+
     app.dependency_overrides[require_principal] = lambda: bob
     assert [row["session_id"] for row in client.get("/sessions").json()] == [bobs]
 
 
+def test_session_list_names_each_conversation_after_its_opening_question() -> None:
+    """A conversation list needs names, and the service is the only thing that can supply them.
+
+    Without this the response was ids and dates, so every client had to invent the same
+    placeholder and every restored conversation looked identical until it was opened.
+    """
+    from chemclaw.api.auth import Principal, require_principal
+
+    app = create_app(agent_factory=lambda _profile: _FakeAgent(), owner_store=_FakeOwnerStore())
+    app.dependency_overrides[require_principal] = lambda: Principal(
+        oid="alice", upn="a@corp", roles=frozenset()
+    )
+    client = TestClient(app)
+    session_id = client.post("/sessions").json()["session_id"]
+
+    _turn(client, session_id, "  What is   the pKa\nof acetic acid? ")
+    # Collapsed, not summarised, and not re-derived from the stored MAF payload.
+    assert client.get("/sessions").json()[0]["title"] == "What is the pKa of acetic acid?"
+
+    # A conversation is named by how it started, so a later turn must not rename it — otherwise the
+    # sidebar entry a chemist navigates by changes under them on every message.
+    _turn(client, session_id, "And in DMSO?")
+    assert client.get("/sessions").json()[0]["title"] == "What is the pKa of acetic acid?"
+
+
+def test_session_list_omits_a_session_nobody_ever_spoke_in() -> None:
+    """A created-but-unused session is not a conversation, and must not be listed as one.
+
+    The companion UI mints the session on the first keystroke so the first message costs one
+    round-trip instead of two, which means every abandoned draft leaves an ownership row. Listing
+    those gave a client a column of empty conversations indistinguishable from ones whose
+    transcript had failed to load — both read as an empty array from outside.
+    """
+    from chemclaw.api.auth import Principal, require_principal
+
+    app = create_app(agent_factory=lambda _profile: _FakeAgent(), owner_store=_FakeOwnerStore())
+    app.dependency_overrides[require_principal] = lambda: Principal(
+        oid="alice", upn="a@corp", roles=frozenset()
+    )
+    client = TestClient(app)
+    used = client.post("/sessions").json()["session_id"]
+    warmed = client.post("/sessions").json()["session_id"]
+    _turn(client, used, "A real question.")
+
+    listed = [row["session_id"] for row in client.get("/sessions").json()]
+    assert listed == [used]
+    assert warmed not in listed
+
+
 def test_session_list_is_empty_without_a_durable_registry() -> None:
     """Under the in-memory store there is no durable registry, so the list is honestly empty.
 
diff --git a/tests/test_session_store.py b/tests/test_session_store.py
index 338c9e9..6916c5a 100644
--- a/tests/test_session_store.py
+++ b/tests/test_session_store.py
@@ -236,11 +236,26 @@ def test_session_owner_records_and_reattaches() -> None:
     asyncio.run(_run())
 
 
-def test_session_owner_lists_only_its_own_sessions_newest_first() -> None:
-    """Listing is owner-scoped and newest-first — what `GET /sessions` renders as the sidebar.
+async def _spoke_in(session_id: str, text: str = "a turn") -> None:
+    """Give a session one stored message, which is what makes it a conversation rather than a row.
+
+    Through the real provider rather than a raw INSERT: the listing derives last-activity from
+    `session_messages.created_at`, so the two have to agree about what a turn writes.
+    """
+    await PostgresHistoryProvider().save_messages(
+        session_id, [Message(role="user", contents=[text])]
+    )
+
+
+def test_session_owner_lists_only_its_own_sessions_most_recently_used_first() -> None:
+    """Listing is owner-scoped and most-recently-used first — the sidebar `GET /sessions` renders.
 
     A dedicated owner string per test: the table is shared across this module's cases, so scoping
     to a real owner is also what keeps the assertion independent of the other rows in there.
+
+    Ordered by the last stored message, not by when the row was created. Those disagree for exactly
+    the conversation a chemist is most likely to want — an old one they have come back to — which
+    under the previous ordering was pinned to the bottom of the list forever.
     """
 
     async def _run() -> None:
@@ -249,15 +264,84 @@ def test_session_owner_lists_only_its_own_sessions_newest_first() -> None:
         await store.record("sess-list-a", "owner-list-test")
         await store.record("sess-list-b", "owner-list-test")
         await store.record("sess-list-other", "someone-else")
+        await _spoke_in("sess-list-a")
+        await _spoke_in("sess-list-b")
+        await _spoke_in("sess-list-other")
 
         listed = await store.list_for_owner("owner-list-test")
-        assert {session_id for session_id, _ in listed} == {"sess-list-a", "sess-list-b"}
-        # created_at defaults to now(), so newest-first is a descending sort on it.
-        assert [created for _, created in listed] == sorted(
-            (created for _, created in listed), reverse=True
-        )
+        assert [session_id for session_id, *_ in listed] == ["sess-list-b", "sess-list-a"]
+        assert [row[2] for row in listed] == sorted((row[2] for row in listed), reverse=True)
         assert await store.list_for_owner("owner-with-no-sessions") == []
 
+        # The older conversation, returned to, comes back to the top.
+        await _spoke_in("sess-list-a", "and one more thing")
+        listed = await store.list_for_owner("owner-list-test")
+        assert [session_id for session_id, *_ in listed] == ["sess-list-a", "sess-list-b"]
+
+    asyncio.run(_run())
+
+
+def test_session_owner_does_not_list_a_session_nobody_spoke_in() -> None:
+    """A created-but-unused session is not a conversation and is not listed as one.
+
+    The companion UI creates the session on the first keystroke so the first message costs one
+    round-trip instead of two, so every abandoned draft leaves an ownership row behind. The lateral
+    join that establishes last-activity is what drops them: no messages, no `max(created_at)`, no
+    row. Deriving the two facts in one query is why this needs no separate cleanup job.
+    """
+
+    async def _run() -> None:
+        await migrated_db_or_skip()
+        store = SessionOwnerStore()
+        await store.record("sess-warmed-unused", "owner-warmed-test")
+        await store.record("sess-warmed-used", "owner-warmed-test")
+        await _spoke_in("sess-warmed-used")
+
+        listed = [session_id for session_id, *_ in await store.list_for_owner("owner-warmed-test")]
+        assert listed == ["sess-warmed-used"]
+
+    asyncio.run(_run())
+
+
+def test_session_owner_keeps_the_title_its_first_turn_gave_it() -> None:
+    """A conversation is named by how it started, and a later turn must not rename it.
+
+    The route calls this on every turn — it has no cheap way to know which one is first — so the
+    `title IS NULL` guard is what makes that safe. Without it a sidebar entry would change under a
+    chemist on every message, which is the one thing a navigation label must not do.
+    """
+
+    async def _run() -> None:
+        await migrated_db_or_skip()
+        store = SessionOwnerStore()
+        await store.record("sess-title", "owner-title-test")
+        await _spoke_in("sess-title")
+
+        await store.set_title_if_absent("sess-title", "What is the pKa of acetic acid?")
+        await store.set_title_if_absent("sess-title", "And in DMSO?")
+
+        listed = await store.list_for_owner("owner-title-test")
+        assert [row[3] for row in listed] == ["What is the pKa of acetic acid?"]
+
+    asyncio.run(_run())
+
+
+def test_session_owner_lists_an_unnamed_session_rather_than_dropping_it() -> None:
+    """A session whose first turn predates the title column is listed with `title=None`.
+
+    Null is the honest value and the row still belongs in the list — hiding a conversation because
+    the service cannot name it would lose history to a schema change.
+    """
+
+    async def _run() -> None:
+        await migrated_db_or_skip()
+        store = SessionOwnerStore()
+        await store.record("sess-untitled", "owner-untitled-test")
+        await _spoke_in("sess-untitled")
+
+        listed = await store.list_for_owner("owner-untitled-test")
+        assert [(row[0], row[3]) for row in listed] == [("sess-untitled", None)]
+
     asyncio.run(_run())
 
 
@@ -273,8 +357,9 @@ def test_session_owner_lists_the_null_owner_sessions() -> None:
         await migrated_db_or_skip()
         store = SessionOwnerStore()
         await store.record("sess-list-null", None)
+        await _spoke_in("sess-list-null")
         listed = await store.list_for_owner(None)
-        assert "sess-list-null" in {session_id for session_id, _ in listed}
+        assert "sess-list-null" in {session_id for session_id, *_ in listed}
 
     asyncio.run(_run())
 
```
