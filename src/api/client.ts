/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * Endpoints verified against 8fqycwdt8v-oss/Chemclaw3 (`src/chemclaw/api/routes/`).
 *
 * Two policies live here and are worth telling apart, because the difference is not stylistic.
 * The *list* routes — sessions, transcripts, jobs — swallow a 404 into an empty result, so
 * this UI runs against an older service with a smaller sidebar rather than a banner. **That policy
 * has a cost this client has now paid twice**, so it is stated beside the policy rather than
 * discovered again: a route the service *deleted* is indistinguishable from a route it never had,
 * so the screen renders an empty list where the honest answer is "this is gone". Both times
 * (durable interaction holds, then the PR gate's `/proposals`) the fix was to delete the caller,
 * and the signal that it was needed came from reading the service's changelog rather than from
 * anything here going red. The *fetch*
 * routes — one tool result, one note — do not, because nothing calls them speculatively: the
 * affordance only exists when the turn said the thing exists, so a 404 there is a real fault and
 * hiding it would leave a control that does nothing when clicked.
 */

import { config } from '../env.ts';
import { logger } from '../lib/logger.ts';
import type { AuthProvider } from '../auth/types.ts';
import type {
  DesignDiff,
  DesignOut,
  DesignStatus,
  DesignSummary,
  ExperimentDesign,
  ProtocolCheck,
} from '../../shared/protocols.ts';
import { ApiError, CORRELATION_HEADER, errorFromStatus, readFailure } from './errors.ts';
import { keys, queryClient } from './queryClient.ts';

/**
 * How a request authenticates.
 *
 * Two accepted shapes, and the second is the one every caller in this app actually has. A bare
 * `() => Promise<string | null>` can only produce a token; an auth provider can also *recover*
 * from a 401 — refresh silently, or start an interactive redirect — which is what turns an expired
 * session into a sign-in prompt instead of a dead-end error toast.
 *
 * Before this union, `handleUnauthorized` had exactly one caller in the whole app
 * (`state/sendMessage.ts`, the turn path). Every other route — the conversation list, the
 * transcript, the review queue, the jobs panel, plan decisions, attachment upload, and both
 * detail fetches — surfaced "Your session has expired. Please sign in again." with
 * no way to act on it. Widening the parameter rather than threading a second argument through
 * eighteen signatures is what makes the recovery uniform: `request` below asks once, and every
 * route inherits it.
 */
export type TokenGetter =
  (() => Promise<string | null>) | Pick<AuthProvider, 'getAccessToken' | 'handleUnauthorized'>;

/** The bearer for this request, from either accepted shape. */
export const tokenFrom = async (auth: TokenGetter): Promise<string | null> =>
  typeof auth === 'function' ? auth() : auth.getAccessToken();

/**
 * Ask the provider to recover from a 401, or report that it cannot.
 *
 * `false` for a bare token getter — it has nothing to recover with — and for a provider that
 * started an interactive redirect (navigation is in flight, so this request is abandoned) or hit
 * its re-auth cooldown. Only `true` means "a fresh token is available now, retry once".
 */
export const recoverFrom = async (auth: TokenGetter): Promise<boolean> =>
  typeof auth === 'function' ? false : auth.handleUnauthorized();

async function send(path: string, auth: TokenGetter, init: RequestInit): Promise<Response> {
  let token: string | null;
  try {
    token = await tokenFrom(auth);
  } catch (err) {
    // The provider failed before any request was opened — `msalAuth.getAccessToken` rethrows a
    // silent-refresh failure that is not `InteractionRequiredAuthError` rather than resolving it,
    // so a network blip does not force a sign-in redirect. Left uncaught, this reached every
    // caller of `request` (session creation among them) as a bare, non-`ApiError` rejection —
    // which `sendMessage`'s outer catch could only classify as `kind: 'stream'`, the same kind a
    // genuinely detached turn gets, sending a request that was never sent into a ten-minute poll
    // of a session transcript for an answer that can never land there.
    logger.warn('auth.token_acquisition_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(
      'token_unavailable',
      'Could not obtain a valid session token. Check your connection and try again.',
      undefined,
      { retryable: true },
    );
  }
  try {
    return await fetch(`${config.apiBase}${path}`, {
      ...init,
      // `no-store` unless the caller says otherwise, and almost nothing does: a session, a
      // transcript, a job list and a review queue are all mutable and session-scoped, and a stale
      // one is worse than a slow one. The exception is a content-addressed route, whose URL
      // changes when its bytes do — see `contentAddressed` below.
      cache: init.cache ?? 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('network', 'Could not reach the Chemclaw service.');
  }
}

async function request<T>(path: string, auth: TokenGetter, init: RequestInit = {}): Promise<T> {
  let res = await send(path, auth, init);
  // One retry, only on 401, only when the caller passed something that can recover. Once: a
  // second attempt after a refresh that did not help is a redirect loop, and the provider's own
  // cooldown exists because that loop is indistinguishable from a hang.
  //
  // Every body this function sends is a string, so re-sending it is safe. `uploadAttachment` does
  // not come through here — it is XHR, for upload progress — and carries its own copy of this.
  if (res.status === 401 && (await recoverFrom(auth))) {
    res = await send(path, auth, init);
  }

  if (!res.ok) {
    // Read back rather than sent: the service issues the id and stamps it on its own log records,
    // so quoting it is what joins a banner a chemist screenshotted to one line in the logs.
    const failure = await readFailure(res);
    throw errorFromStatus(
      res.status,
      failure.detail,
      res.headers.get('retry-after'),
      failure.correlationId,
      failure.code,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * `request`, for a route whose URL changes whenever its bytes do.
 *
 * All this does now is ask the browser to keep the answer: `send` sets `no-store` on everything by
 * default, which does not merely skip the HTTP cache, it forbids writing to it. **Sharing the read
 * between two components is no longer this function's job** — it was a `Map<string, Promise>`
 * deleted the moment each request settled, an in-flight join for the case where a result block and
 * the trace panel behind it cite one `result_ref` at the same instant. A `queryKey` is that join
 * and also the thing the join could never be, a cache: the old one held nothing once the answer
 * arrived, so "a remount refetched the whole payload every time" was its own docstring's admission.
 * See `queries.ts`'s `IMMUTABLE`.
 *
 * **What this still does not buy, said plainly**, because `ResultBlock`'s own docstring has claimed
 * for longer that "the browser and any cache in front of it can hold it forever": the service sets
 * no `Cache-Control` on either route, so `default` gets a revalidation at best rather than a hit.
 * This is the half that lives here; the backend half is a header on
 * `GET /sessions/{id}/tool-results/{ref}`.
 */
function contentAddressed<T>(path: string, auth: TokenGetter): Promise<T> {
  return request<T>(path, auth, { cache: 'default' });
}

/**
 * Swallow a 404 from a LIST route into an empty result, and say so somewhere.
 *
 * The degradation is deliberate and unchanged: an older service yields a smaller app rather than a
 * banner. What it never did was leave a trace — so "the sidebar is empty" and "this deployment's
 * service predates the listing route" were the same observation, and the second is a deployment
 * fault somebody should hear about. The record is a log entry rather than a banner precisely
 * because the UX decision here is right.
 */
async function orEmpty<T>(route: string, load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'session_not_found') {
      logger.warn('api.list_route_missing', { route });
      return [];
    }
    throw err;
  }
}

/**
 * One of the caller's sessions, as `GET /sessions` lists them.
 *
 * There is deliberately no `title`. It was declared optional with a note that the service does not
 * send one and that whoever removed it should fix the sidebar's copy in the same commit — this is
 * that commit. The title is now recovered from the transcript when the conversation is opened
 * (`chatStore.hydrateTranscript`), so the placeholder is genuinely temporary rather than
 * permanent, and an optional field nobody can ever populate is gone.
 *
 * `created_at` is when the session was *started*, not its last activity. Sorting a conversation
 * list by it is wrong and the sidebar does not; see ISSUES.md.
 */
export interface SessionSummary {
  session_id: string;
  created_at?: string;
  /**
   * The session's last activity — the newest stored message, not when it was started.
   *
   * The distinction is the sidebar's whole ordering problem, and the service's own schema says it
   * in as many words: "the difference between 'what have I been working on' and 'what did I once
   * open'". Optional because a service that predates the field sends nothing, and a restored
   * conversation then falls back to `created_at` as it always did.
   */
  updated_at?: string;
  /**
   * A name derived server-side from the session's first user message.
   *
   * `Sidebar.tsx` carried a comment saying the server "has never sent one, so the guard was
   * decoration in front of a constant" — true when it was written, and false since
   * `routes/sessions.py` began constructing `SessionSummary(..., title=title)`. The guard was
   * deleted one release before it became load-bearing, which is why every restored conversation
   * still read "Earlier conversation" until somebody clicked into it.
   *
   * `null` is a session whose first turn predates the field, and is deliberately distinguishable
   * from `""` — only one of those is worth reporting.
   */
  title?: string | null;
}

/** One page of `GET /sessions`, plus the cursor that continues it. */
export interface SessionPage {
  sessions: SessionSummary[];
  /**
   * `X-Next-Cursor`, or `''` when this is the last page.
   *
   * A header rather than an envelope because the service chose one — adding `{sessions, next}`
   * would have broken every deployed client — and it survives the trip because the BFF copies
   * response headers through and the SPA is same-origin with it. Absent is the service's word for
   * "there is no next page", including on a deployment whose registry cannot resume a listing at
   * all; following a cursor such a deployment did not advertise is a 422 by design.
   */
  next: string;
}

/** One tool call as the transcript records it. `arguments` and `result` are truncated server-side
 *  (400 chars) exactly as their streamed counterparts are, and are raw strings either way. */
export interface TranscriptToolCall {
  tool: string;
  arguments: string;
  result: string | null;
  /**
   * The content address of the full result, when the service still holds it.
   *
   * The fourth field of a shape this interface declared three of — and the service does a *second*
   * read (`fetchable_refs`) purely to populate it, whose own docstring calls this "the one path on
   * which the ref `D-2026-08-09-a-preview-is-not-a-result` added never reached a surface". It did
   * not, because the client's type stopped at three fields and `traceFrom` mapped three.
   *
   * The cost of dropping it is exactly one release of `USER-STORIES.md` A3 being true: live, a
   * chemist opens the hazard table, the charge table and the solvent ranking as data; after a
   * reload the same turn shows the 400-character paraphrase and no affordance at all.
   *
   * Empty means there is nothing to fetch — swept, or never stored. The service deliberately does
   * not distinguish those, because the only consumer that acts on this cannot.
   */
  result_ref?: string;
}

export interface TranscriptMessage {
  index: number;
  role: string;
  text: string;
  /**
   * The calls the agent made producing this message.
   *
   * This type used to declare `created_at` and no `tool_calls`, which was wrong in both
   * directions: the service sends no timestamp, and it does send these. The visible cost was that
   * reading a conversation back from the server — the whole point of `GET /sessions/{id}/messages`
   * — silently lost every trace row, so a transcript rehydrated on a second device showed answers
   * with no working behind them.
   */
  tool_calls: TranscriptToolCall[];
  /**
   * The turn that stored this message (`session_messages.correlation_id`) — the same id the turn's
   * response header carried, so detach recovery can find *its* answer by identity rather than by
   * text. `null` for a row stored off the request path or before the column existed; absent
   * altogether from a service older than the field, which is why it is optional here.
   */
  correlation_id?: string | null;
}

export interface AttachmentSummary {
  name: string;
  content_type: string;
  /** Parsed row count. `0` for a non-tabular format (PDF, DOCX, PPTX) — the service defaults it
   *  rather than omitting it, so treat 0 as "not a table", not as "an empty table". */
  rows: number;
  excerpt: string;
}

/**
 * One finished durable run, from the permanent job record rather than from Temporal.
 *
 * `rationale` is the field that makes this a registry rather than a log: it is why the run was
 * launched, recorded at launch, and it is what `find_past_jobs` searches. Results survive Temporal
 * history expiry here, so a job whose session is long gone is still answerable.
 */
export interface JobRecordSummary {
  job_id: string;
  connector: string;
  job: string;
  rationale: string;
  summary: string;
  note_id: string;
  /**
   * The plan step the run served, or empty when it was not launched from one.
   *
   * In the *listing* upstream so that "which step was this for" needs no second lookup — and the
   * live trace badges the same fact from `job_started.plan_step`, so dropping it here made one
   * fact render two ways in one app depending on whether the page had been reloaded.
   */
  plan_step: string;
  /**
   * How the run ended: `completed` or `failed`.
   *
   * Defaulted to `completed` upstream because that is what every row written before the column is,
   * not because a caller may omit it. It exists for one failure and it is this surface's: a failing
   * job raises before the workflow's `_finish`, so until this column a failed run wrote no row at
   * all, and the model's own docstring says that without it "a failed run appears in
   * `find_past_jobs` beside the successful ones with an empty summary and nothing saying it
   * failed, which is a worse answer than the one that omitted it". `failure_reason` is deliberately
   * not here: the listing says *that* a run failed, and opening the record says why.
   */
  state: string;
  completed_at: string | null;
}

/**
 * One page of the durable-run registry, with the cursor for the next.
 *
 * The cursor is a `job_id` rather than an opaque token, and the service says why: the anchor is a
 * row the caller already holds, so nothing about the ordering is disclosed and the cursor survives
 * the ordering gaining a third component. It is advertised only when the store actually saw a
 * further row, so following it never lands on an empty page.
 */
export interface JobPage {
  jobs: JobRecordSummary[];
  /** `''` when this page is the whole answer. */
  next: string;
}

/**
 * One standing query's finding — what a watch turned up since it last reported.
 *
 * Four fields, and no timestamp: the service does not send one, so nothing here may imply when the
 * notes were merged. `note_ids` resolve through the ordinary citation chip.
 *
 * **This declared the first two and dropped the other two, which are the ones a reader acts on.**
 * Upstream's own model says `headlines` exists because "without it this route answers with note
 * **ids** and a client can do nothing but print them" — which is what the card did. And `disputed`
 * has been computed since `D-2026-08-27` and rendered by the outbound delivery channels, so a
 * deployment with a channel configured saw it while one on the shipped default lost it on the only
 * path a UI reads: "a chemist who happens to ask is told, and a chemist watching the subject is
 * not", one layer below where that sentence was written.
 */
export interface Digest {
  query: string;
  note_ids: string[];
  /** Which of `note_ids` the corpus now disagrees with. A subset, and usually empty. */
  disputed: string[];
  /** Note id → one line of what it says. Empty for a note the service could not summarise. */
  headlines: Record<string, string>;
}

/**
 * One question of the caller's OWN that is still waiting on somebody else.
 *
 * `CheckInOut` in the service's `api/routes/streams.py`, and the opposite direction from
 * `PendingRequest`: that one is work stopped *here*, waiting on this reader; this one is work
 * stopped *somewhere else*, where the only thing to do is go and ask. They share a mailbox and
 * nothing else — the service made it a route of its own for that reason.
 *
 * Every field is defaulted upstream, so each one is always present and possibly empty. Two of them
 * are already whole days rather than timestamps: the service rounds, deliberately and downwards
 * (`FLOOR`, not a cast that rounds 4.6 days up to "5 left"), so that a deadline is not overstated
 * by two different surfaces doing the arithmetic two different ways. **Nothing here may recompute
 * them**, and there is nothing to recompute them from.
 *
 * `subject` and `rationale` are the requester's own words, truncated by the service at 1,000
 * characters with the truncation *named in the text itself* — so they are rendered as given, and a
 * renderer that shortened them further would be hiding a notice that says how much was dropped.
 *
 * **Three of the four things this used to say it does not carry are now here** (upstream's
 * `D-2026-09-18-a-wire-model-cannot-drop-a-field-that-never-arrived`, which closed Issue 16). That
 * entry — and the service's own backlog row — described all three as fields `CheckInOut` dropped.
 * Measured there before the fix, only `kind` was: `session_id` was a `pending_requests` column the
 * sweep's query never selected, and `truncated` was a `CheckIn` field the workflow never wrote
 * into the mailbox payload. Nothing here could have caught that, which is why the reading is
 * recorded rather than the outcome.
 *
 * **What it still does not carry is any timestamp**, and that is unchanged and deliberate: a
 * digest has none either, and the card is stamped with when _we_ claimed it and says "claimed",
 * never "asked".
 */
export interface CheckIn {
  request_id: string;
  /** What class of answer is wanted — the same vocabulary `PendingRequest.kind` is badged by. */
  kind: string;
  subject: string;
  rationale: string;
  /** Who owes the answer: an object id, a upn, or an entitlement. Empty means "anyone". */
  asked_of: string;
  /** Whole days open, and whole days until the wait expires. Already floored by the service. */
  open_days: number;
  days_left: number;
  /**
   * The conversation the question was asked in, or empty.
   *
   * Empty is ordinary rather than exceptional: a wait opened by a plate run or a connector job was
   * never in a conversation. Always one of this reader's own — the sweep is scoped to who asked,
   * and the route claims only the caller's mailbox.
   */
  session_id: string;
  /**
   * Whether the notice this question arrived in was short of the asker's whole blocked set.
   *
   * A property of the claimed mailbox row, which the service stamps onto every entry that row
   * carried, because its answer is a flat list flattened across rows. So it is the same value on
   * every card from one notice, and reading it off any one of them is reading it off the notice.
   */
  truncated: boolean;
}

/** One question the agent is holding a workflow open for, as an inbox renders it. */
export interface PendingRequest {
  request_id: string;
  /** What kind of answer is wanted — the service's own vocabulary, shown as given. */
  kind: string;
  subject: string;
  rationale: string;
  /** Who it was routed to: an object id, a upn, or an entitlement. Empty means "anyone". */
  asked_of: string;
  requested_by: string;
  session_id: string;
  /** `waiting` is the only state that can be answered; the rest are history. */
  state: string;
  due_at: string;
  created_at: string;
}

export interface PendingRequests {
  requests: PendingRequest[];
  /**
   * The length of `requests`, not a population.
   *
   * The service says so in as many words, and the distinction is load-bearing for the copy: "12"
   * over five rows would be describing a page as a total.
   */
  count: number;
  /**
   * Everything matching this caller's routing, before the page bound and before the gate.
   *
   * It can exceed `count` for two different reasons — rows the page did not reach, and rows this
   * caller may not answer because they raised them — and `verdict` is the service saying which.
   */
  total_routed_to_you: number;
  /** Whether waiting rows exist that this page did not carry. */
  truncated: boolean;
  /**
   * What this page *is*, in the service's own sentence, for rendering above the list.
   *
   * A `computed_field` upstream rather than a client derivation, deliberately: the arithmetic has
   * two independent reasons a total can exceed a page and the wording separates them. This client
   * declared none of the three, so 35 waiting rows rendered as 20 as though that were the inbox —
   * and the consequence the service records is a raised question that ages out because it appeared
   * in nobody's inbox. Empty from a service that predates the field, which renders as nothing.
   */
  verdict: string;
}

/** One job's live status and structured result. */
export interface DurableJobStatus {
  job_id: string;
  status: string;
  summary: string | null;
  result: Record<string, unknown>;
  /**
   * The calculation keys this run rested on, as `record_knowledge_note` takes them.
   *
   * A sibling of the result envelope rather than part of it, so the sheet's `result` dump does not
   * carry them. Empty for a run that recorded none — a report, or a run from before the refs were
   * captured — which is the honest reading either way.
   */
  calc_refs: string[];
  rationale: string;
}

/**
 * The untruncated text of one tool result, as `GET /sessions/{id}/tool-results/{ref}` returns it.
 *
 * `text` is deliberately not typed as parsed JSON, upstream and here. A tool result is whatever
 * the framework handed back, and a store that promised JSON would have to fail or lie about the
 * ones that are not — so the parsing, and the decision about what to do when it fails, belongs to
 * the renderer that wants a shape.
 */
export interface StoredToolResult {
  ref: string;
  tool: string;
  /** Joins this result to the audit trail and the logs of the turn that produced it. */
  correlation_id: string;
  byte_size: number;
  text: string;
}

/**
 * A note's identity and provenance, without its body. Also what a neighbour is.
 *
 * **Three of these are nullable upstream and were declared non-null here**, which is not a
 * pedantic difference for `confidence`: four of the five note producers in the service's `memory/`
 * package mint a note with none — a campaign, an interaction, an optimisation and a playbook — and
 * only a recorded failure scores one. So `null` is the *ordinary* value over most of the corpus,
 * and the badge that called `.toFixed(2)` on it threw, taking down the one panel whose whole job
 * is letting a chemist check a citation.
 */
export interface NoteRef {
  id: string;
  type: string;
  /** The structure the note is about, or null for a note that is not about one. */
  compound_smiles: string | null;
  tags: string[];
  created_by: string;
  /** Where it came from, or null when the producer recorded none. */
  source: string | null;
  /** The producer's own score, or null when it did not score the note. Most of the corpus. */
  confidence: number | null;
  /** Bi-temporal validity. A note outside its window is excluded from retrieval but still
   *  readable here, which is the point of showing the dates rather than a boolean. */
  valid_from: string | null;
  valid_to: string | null;
}

/** One note as `GET /notes/{id}` returns it: itself, its body, and its neighbourhood. */
export interface NoteView {
  note: NoteRef;
  body: string;
  neighbors: NoteRef[];
}

/** The plan a session is proposing, and the hash a decision on it must be bound to. */
export interface PlanStatus {
  session_id: string;
  plan_hash: string;
  plan: string[];
  /**
   * What approving this plan would authorize: every tool its steps declare.
   *
   * The half of the plan a person is deciding about that the steps do not state, and the service
   * puts it in the same payload for that reason —
   * `D-2026-09-12-an-approval-that-names-no-tool-authorizes-every-tool` says in as many words that
   * "a surface that showed the steps alone would be asking a person to approve a thing it had not
   * shown them". The gate enforces it, so this is disclosure rather than decoration: a
   * state-changing tool no step declared is refused even under a live approval.
   *
   * Absent — not empty — from a service that predates the field, which a reader must treat as
   * "unknown" rather than as "this authorizes nothing". The `plan` event carries it too; this read
   * is the fallback for a service that sends none there, and for the re-read after a 409.
   */
  scope: string[];
  /** `plan_only` until a human approves; `execute` afterwards. */
  mode: string;
  approved: boolean;
  decided_by: string | null;
}

/** One conversation whose plan nobody has decided, as the cross-session inbox lists it. */
export interface PendingPlan {
  session_id: string;
  title: string | null;
  updated_at: string;
  plan_hash: string;
  plan: string[];
  /** What approving it would authorize — see `PlanStatus.scope`. The inbox carries it for the same
   *  reason the card does, and here it arrives in the same payload as the steps, so there is no
   *  revision to check it against. */
  scope: string[];
}

/**
 * `GET /plans/pending` — undecided plans, with what the service's scan actually covered.
 *
 * The counts are why this is an object rather than an array, and they are the whole difference
 * between this screen and the one it replaces. `plans: []` has four meanings: `gated === 0` is
 * "this deployment has no plan gate, so nothing can ever be here", `unread > 0` is "the answer is
 * partial", `truncated` is "we stopped looking before the end", and none of those is "nothing is
 * waiting on you". The deleted holds inbox rendered every one of them as the last — see the note
 * at the top of `ReviewQueue.tsx`.
 */
/**
 * One change to what the agent does, waiting on the person it would act on.
 *
 * The **body is here and is not optional**, which is the service's decision and the reason this
 * screen can decide in place where the plan section deliberately cannot. A plan is approved on the
 * strength of the reasoning that produced it, which lives in a conversation; a skill *is* the
 * document, and the service returns it whole precisely so nobody is asked to approve something
 * unseen (`api/routes/proposals.ProposalOut`).
 */
export interface BehaviourProposal {
  /** `skill` or `profile`. Only `skill` has a destination a route can write. */
  kind: string;
  name: string;
  /** The identity of this exact document — a decision is bound to it, not to the name. */
  content_hash: string;
  /** The whole `SKILL.md`, frontmatter included. */
  content: string;
  /** Why the agent thinks it is worth keeping, in its own words. */
  rationale: string;
  state: string;
  /** The conversation it came out of, so a reader can go and look at the work. */
  session_id: string;
  decided_by?: string;
  reason?: string;
}

/**
 * One skill a chemist keeps, or one the organisation publishes.
 *
 * The same shape for both tiers because it is the same document; what differs is who may change it
 * and how far it reaches, which is the caller's business rather than the type's.
 */
export interface SkillDocument {
  name: string;
  body: string;
}

/** One body that was once the organisation's active judgment, and who made it so. */
export interface OrgSkillVersion {
  content_hash: string;
  body: string;
  activated_by: string;
  activated_at: string;
}

export interface PendingPlans {
  plans: PendingPlan[];
  /** Sessions of the caller's the service looked at — the same set `GET /sessions` lists. */
  considered: number;
  /** Of those, the ones running a plan-gated profile: the only ones that can hold a decision. */
  gated: number;
  /** Gated sessions whose plan was not read, so the list is short by an unknown amount. */
  unread: number;
  /**
   * Whether the service's walk through the caller's conversations stopped before the end.
   *
   * The fourth reading of an empty `plans`, and the one `unread` cannot carry: `unread` counts
   * *gated* sessions whose plan went unread, and a walk that stopped early never learned whether
   * the conversations beyond it were gated at all. So there is no number here — folding it into
   * `unread` would invent plans that may not exist, which is what the service's own schema says
   * about why it is a separate field.
   *
   * Optional because a service that predates the field sends nothing. Absent is read as "not
   * reported" and changes no copy — the screen says exactly what it said before the field
   * existed. It is deliberately NOT read as "the scan was complete": the version before this one
   * walked the whole listing and had nothing to admit, but the version before *that* read only
   * the first page and was silently short, which is the defect the field was added to end.
   */
  truncated?: boolean;
}

/**
 * One design at one revision, plus every revision of it — as `GET /protocols/{id}` returns them.
 *
 * The history rides along with the document rather than living on a route of its own, and that is
 * what makes the revision picker free: opening a design at revision 3 already knows there is a 4,
 * so a reader can never be looking at an old revision without the screen being able to say so.
 * The header row rides along for the same reason, which is why nothing here fetches the list a
 * second time to find out what status to draw.
 *
 * **It is `DesignOut` — the service's own FLAT shape — and it used to be a nested one this app
 * invented.** `{ revision: DesignRevision }` reads better and was never what came back: the
 * service puts the revision's fields at the top level, so `view.revision` is a *number* and
 * `revision.design` was `undefined` against the real front door — the document page threw on its
 * first field. The unit stubs, the component stub and the end-to-end fixture all emitted the
 * invented shape, so nothing in this repository could see it. Holding the service's shape is the
 * fix; a translation layer would only be one more place to be confidently wrong about somebody
 * else's contract.
 */
export type ProtocolView = DesignOut;

/** What `POST /protocols/{id}/revisions` answers with: the revision it wrote, re-checked. */
export interface RevisionWritten {
  revision: number;
  /** Re-run against the saved document, so an edit that introduced a blocker says so at once. */
  checks: ProtocolCheck[];
  changed_paths: string[];
}

/**
 * POST one file to a session's attachment route, reporting progress.
 *
 * XHR rather than `fetch`, which is the one place in this client that deviates: `fetch` still
 * cannot report upload progress in any shipping browser, and an SOP or a large CSV over a lab VPN
 * is exactly where an indeterminate spinner stops being honest. Everything else here stays on
 * `fetch`.
 *
 * A module function rather than a method, because `uploadAttachment` has to be able to call it
 * twice — once, and once more after a recovered 401.
 */
function upload(
  sessionId: string,
  file: File,
  token: string | null,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<AttachmentSummary> {
  const form = new FormData();
  form.append('file', file);

  return new Promise<AttachmentSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${config.apiBase}/sessions/${encodeURIComponent(sessionId)}/attachments`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('accept', 'application/json');
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as AttachmentSummary);
        return;
      }
      const body =
        typeof xhr.response === 'object' && xhr.response !== null
          ? (xhr.response as { detail?: unknown; correlation_id?: unknown })
          : {};
      // The same read-back as `request` above, through XHR's own accessor — an upload that fails
      // is exactly as worth joining to the service's logs as a turn that does, and it is refused
      // by the same per-principal limiter, so it honours the same `Retry-After`.
      const correlationId =
        xhr.getResponseHeader(CORRELATION_HEADER)?.trim() ||
        (typeof body.correlation_id === 'string' ? body.correlation_id : '');
      reject(
        errorFromStatus(
          xhr.status,
          typeof body.detail === 'string' ? body.detail : undefined,
          xhr.getResponseHeader('retry-after'),
          correlationId,
        ),
      );
    };
    xhr.onerror = () => reject(new ApiError('network', 'Could not reach the Chemclaw service.'));
    xhr.onabort = () => reject(new ApiError('aborted', 'Upload cancelled.'));

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export const api = {
  /**
   * What is waiting on this person to decide about the agent's own behaviour.
   *
   * **Deliberately not wrapped in `orEmpty`, and that is the whole lesson of this page's history.**
   * `ReviewQueue.tsx` has had to delete two inboxes for decisions that could not occur, and both
   * times the failure was identical and quiet: a list route 404s, the client folds it into `[]`,
   * and the section renders a confident permanently-empty queue that reads as "you are up to
   * date". This tier answers **503** where a deployment keeps no proposals
   * (`CHEMCLAW_AGENT_MEMORY_ENABLED` off, or an in-memory session store), and that is a different
   * fact from "nothing is waiting". It is allowed to throw so the screen can say which.
   */
  listProposals(getToken: TokenGetter, state = 'open'): Promise<BehaviourProposal[]> {
    return request<{ proposals: BehaviourProposal[] }>(
      `/proposals?state=${encodeURIComponent(state)}`,
      getToken,
    ).then((page) => page.proposals ?? []);
  },

  /**
   * Accept or decline one proposal, bound to the document that was shown.
   *
   * `content_hash` is required by the service and is the point: a decision naming only the skill
   * would authorize whatever that name currently holds, and the proposer can supersede an open
   * proposal between the read and the click.
   */
  decideProposal(
    getToken: TokenGetter,
    kind: string,
    name: string,
    contentHash: string,
    accepted: boolean,
    reason = '',
  ): Promise<BehaviourProposal> {
    return request<BehaviourProposal>(
      `/proposals/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
      getToken,
      {
        method: 'POST',
        body: JSON.stringify({ content_hash: contentHash, accepted, reason }),
      },
    );
  },

  /** The names of the skills acting on this chemist's own turns. Throws on 503, for `listProposals`' reason. */
  listMySkills(getToken: TokenGetter): Promise<string[]> {
    return request<{ skills: string[] }>('/skills/mine', getToken).then(
      (page) => page.skills ?? [],
    );
  },

  /** One of this chemist's own skills, verbatim — the body a turn is actually given. */
  readMySkill(getToken: TokenGetter, name: string): Promise<SkillDocument> {
    return request<SkillDocument>(`/skills/mine/${encodeURIComponent(name)}`, getToken);
  },

  /**
   * Stop one of this chemist's own skills acting.
   *
   * The half that makes the rest worth having: `D-2026-09-05` grants the personal tier its
   * exemption from review on the condition that its owner can see what is acting on them *and
   * remove it*, and until this screen existed the only thing that could exercise that was `curl`.
   */
  forgetMySkill(getToken: TokenGetter, name: string): Promise<string[]> {
    return request<{ skills: string[] }>(`/skills/mine/${encodeURIComponent(name)}`, getToken, {
      method: 'DELETE',
    }).then((page) => page.skills ?? []);
  },

  /** The names of the skills acting on every turn in this deployment. Open to any caller. */
  listOrgSkills(getToken: TokenGetter): Promise<string[]> {
    return request<{ skills: string[] }>('/skills/org', getToken).then((page) => page.skills ?? []);
  },

  /** One organisation skill, verbatim. */
  readOrgSkill(getToken: TokenGetter, name: string): Promise<SkillDocument> {
    return request<SkillDocument>(`/skills/org/${encodeURIComponent(name)}`, getToken);
  },

  /**
   * Every body ever activated under this name, newest first.
   *
   * The blame half of a rollback story for a tier with no commit log, and open to everyone rather
   * than to administrators: this tier acts on people who did not approve it, so all of them can
   * see what it says and what it replaced.
   */
  listOrgSkillVersions(getToken: TokenGetter, name: string): Promise<OrgSkillVersion[]> {
    return request<{ versions: OrgSkillVersion[] }>(
      `/skills/org/${encodeURIComponent(name)}/versions`,
      getToken,
    ).then((page) => page.versions ?? []);
  },

  /**
   * Keep one skill for yourself, replacing any earlier version of that name.
   *
   * The whole `SKILL.md` goes up and the name comes from its frontmatter, as with the organisation
   * tier. Two refusals are the reader's to see rather than this client's to reword — a **409** for
   * a name a skill this deployment ships already uses, or for the row cap (every personal skill is
   * in the prompt of every turn its owner takes), and a **422** for a document that is not a
   * `SKILL.md` or is over the length cap — so the service's own sentence is what surfaces.
   */
  saveMySkill(getToken: TokenGetter, body: string): Promise<SkillDocument> {
    return request<SkillDocument>('/skills/mine', getToken, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  /** Publish one skill to the whole deployment. 403 without the privileged role. */
  publishOrgSkill(getToken: TokenGetter, body: string): Promise<SkillDocument> {
    return request<SkillDocument>('/skills/org', getToken, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  /**
   * Make a body this tier already holds the active one again.
   *
   * A hash the service does not hold is a 404 — the pointer can only point at history, which is
   * what makes this a rollback rather than a write.
   */
  revertOrgSkill(getToken: TokenGetter, name: string, contentHash: string): Promise<SkillDocument> {
    return request<SkillDocument>(`/skills/org/${encodeURIComponent(name)}/revert`, getToken, {
      method: 'POST',
      body: JSON.stringify({ content_hash: contentHash }),
    });
  },

  /** Stop one organisation skill acting, keeping its history. 403 without the privileged role. */
  retireOrgSkill(getToken: TokenGetter, name: string): Promise<string[]> {
    return request<{ skills: string[] }>(`/skills/org/${encodeURIComponent(name)}`, getToken, {
      method: 'DELETE',
    }).then((page) => page.skills ?? []);
  },
  async health(): Promise<boolean> {
    try {
      await request<{ status: string }>('/healthz', async () => null);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Mint a backend session, optionally on a named agent profile.
   *
   * A profile narrows the agent — `property-lookup` is a cheap one that converts a pKa without
   * running a research loop. The service 400s a name it does not know, which is why the picker
   * that supplies this reads `listProfiles` rather than carrying a list of its own.
   */
  createSession(getToken: TokenGetter, profile?: string): Promise<{ session_id: string }> {
    return request<{ session_id: string }>('/sessions', getToken, {
      method: 'POST',
      // Omitted rather than sent as null when there is no profile: the service's `SessionIn` is
      // optional in full, and an explicit null is a different thing from an absent field.
      ...(profile ? { body: JSON.stringify({ profile }) } : {}),
    });
  },

  /** The profiles this deployment offers. Degrades to `[]`, which the picker reads as "do not
   *  offer a choice" — a service without the route has exactly one profile. */
  listProfiles(getToken: TokenGetter): Promise<string[]> {
    return orEmpty('/profiles', () => request<string[]>('/profiles', getToken));
  },

  /** The caller's sessions. Returns `[]` if the backend predates this endpoint (404) or has
   *  nothing durable to list, so the sidebar simply stays local-only. */
  listSessions(getToken: TokenGetter): Promise<SessionSummary[]> {
    return orEmpty('/sessions', () => request<SessionSummary[]>('/sessions', getToken));
  },

  /**
   * One page of sessions, with the cursor for the next.
   *
   * Separate from `listSessions` rather than replacing it: the service caps a page at
   * `service_max_listed_sessions` (100), so conversation 101 was simply unreachable — not below a
   * fold, not fetched. The plain form stays because it is what every caller that wants "the recent
   * ones" should use, and because degrading a *paged* read to an empty array on a 404 would hide
   * the difference between "no more pages" and "this service has no such route".
   */
  async pageSessions(getToken: TokenGetter, after?: string): Promise<SessionPage> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    try {
      let res = await send(`/sessions${query}`, getToken, {});
      // **The one route that skipped 401 recovery**, because it calls `send` directly to reach the
      // `X-Next-Cursor` header rather than going through `request`. Under MSAL `recoverFrom` is
      // what *fires the sign-in redirect* — it always resolves `false`, and the retry is a side
      // effect rather than the point — so the first authenticated call on boot (`Sidebar`'s
      // listing) 401'd, logged `sessions.list_failed`, showed "showing local conversations only",
      // and never asked the user to sign in, while every other route on the page did.
      if (res.status === 401 && (await recoverFrom(getToken))) {
        res = await send(`/sessions${query}`, getToken, {});
      }
      if (!res.ok) {
        const failure = await readFailure(res);
        throw errorFromStatus(
          res.status,
          failure.detail,
          res.headers.get('retry-after'),
          failure.correlationId,
          failure.code,
        );
      }
      return {
        sessions: (await res.json()) as SessionSummary[],
        next: res.headers.get('x-next-cursor') ?? '',
      };
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/sessions' });
        return { sessions: [], next: '' };
      }
      throw err;
    }
  },

  /**
   * Stop the session's running turn — the explicit act a closed stream no longer performs.
   *
   * The backend detaches on disconnect (its turn runs to completion unwatched), so Stop is a
   * request of its own. `false` when there was nothing to stop: the turn may have finished in
   * the race between pressing Stop and the request landing, which is an outcome, not an error —
   * and an older backend without the route answers the same way, degrading Stop to the old
   * disconnect-only behaviour rather than surfacing a banner.
   */
  /**
   * Cancel the running turn.
   *
   * `keepalive` is for the one caller that is being torn down as it asks: a `pagehide` handler has
   * until the document is discarded, and an ordinary `fetch` started there is cancelled with the
   * page. It is not the default because `keepalive` requests are capped at 64 KiB by the browser
   * and share a small per-page budget with the log sink's own final batch, and because every other
   * caller is alive to await the answer.
   */
  async stopTurn(
    sessionId: string,
    getToken: TokenGetter,
    options: { keepalive?: boolean } = {},
  ): Promise<boolean> {
    try {
      await request<{ stopped: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/turn/stop`,
        getToken,
        {
          method: 'POST',
          ...(options.keepalive ? { keepalive: true } : {}),
        },
      );
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return false;
      throw err;
    }
  },

  /** A session's transcript. Same graceful degradation as `listSessions`: a backend without this
   *  route, or a session whose history is gone, yields an empty transcript rather than an error. */
  getMessages(sessionId: string, getToken: TokenGetter): Promise<TranscriptMessage[]> {
    return orEmpty('/sessions/{id}/messages', () =>
      request<TranscriptMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`, getToken),
    );
  },

  /**
   * Upload a working file, reporting progress and honouring a cancel.
   *
   * The body is `upload` below; this half is only the one-shot 401 recovery `request` gives every
   * other route. It cannot share that path — see `upload`'s docstring for why this one is XHR —
   * so it carries its own copy, which is the same shape and the same "once, never twice" rule.
   * A `File` is re-readable, so a retry costs the bytes again and nothing else.
   */
  async uploadAttachment(
    sessionId: string,
    file: File,
    auth: TokenGetter,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<AttachmentSummary> {
    try {
      return await upload(sessionId, file, await tokenFrom(auth), options);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized' && (await recoverFrom(auth))) {
        return upload(sessionId, file, await tokenFrom(auth), options);
      }
      throw err;
    }
  },

  /**
   * The full text of one tool result.
   *
   * Called only when a reader asks for one — that is the whole design of the ref/payload split,
   * and prefetching every result of every turn would re-open exactly the question the 200-character
   * preview closed.
   *
   * Nothing is swallowed here. Unlike the list routes, there is no "the backend might not have
   * this yet" case worth papering over: the affordance that calls this is only rendered when the
   * turn carried a `result_ref`, and a service that emits a ref it will not serve is a fault the
   * caller should see.
   */
  getToolResult(sessionId: string, ref: string, getToken: TokenGetter): Promise<StoredToolResult> {
    return contentAddressed<StoredToolResult>(
      `/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(ref)}`,
      getToken,
    );
  },

  /**
   * One knowledge note, with its neighbourhood.
   *
   * `hops` is clamped upstream; 1 is the service's own default and the depth a citation chip
   * wants — the note plus what it is directly linked to.
   *
   * The id is encoded rather than interpolated raw: unlike a session id, a note id is
   * `note-{slug}` built from what the note is about, so it can carry characters that would
   * otherwise change the shape of the path. The BFF's pattern accepts exactly what
   * `encodeURIComponent` emits.
   */
  getNote(noteId: string, getToken: TokenGetter, hops = 1): Promise<NoteView> {
    return contentAddressed<NoteView>(
      `/notes/${encodeURIComponent(noteId)}?hops=${encodeURIComponent(String(hops))}`,
      getToken,
    );
  },

  /**
   * Delete one conversation on the service, not only in this browser.
   *
   * "Delete conversation" was a local map delete: the server session, its transcript, its
   * checkpoints, its attachments and its ownership row all survived. The chemist who deleted it
   * *because* it held something they did not want kept had been told something untrue — and the
   * service has a twelve-table transactional sweep for exactly this case, whose own docstring
   * frames it as "I do not want this conversation any more".
   *
   * A 404 is success here, deliberately. The service answers 404 for both "no such session" and
   * "not yours", refusing to be an id oracle — and a conversation this browser holds a stale id
   * for is a conversation that is already gone. Every other failure is the caller's to report,
   * because a delete that silently did not happen is the failure this method exists to end.
   */
  async deleteSession(sessionId: string, getToken: TokenGetter): Promise<void> {
    try {
      await request<void>(`/sessions/${encodeURIComponent(sessionId)}`, getToken, {
        method: 'DELETE',
      });
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return;
      throw err;
    }
  },

  /**
   * Branch this conversation onto a new session carrying its whole history.
   *
   * "Try a different direction from here without losing this thread" — and the nearest thing the
   * service offers to editing a question and re-asking it while keeping both branches.
   *
   * Three refusals worth carrying, because each is a different fact: **409** a turn is in flight
   * (a fork reads five of the parent's tables, and a turn committing partway through would land a
   * child that resumes with holes), **501** this deployment has no durable session store so there
   * is no thread to copy, and **404** which is the service refusing to say whether the id exists.
   */
  forkSession(sessionId: string, getToken: TokenGetter): Promise<{ session_id: string }> {
    return request<{ session_id: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/fork`,
      getToken,
      { method: 'POST' },
    );
  },

  /**
   * Claim the standing-query digests waiting for this chemist.
   *
   * **The read is the consume.** The service's mailbox claim is destructive by design — a row this
   * call returns is marked consumed and is never re-delivered — so the caller must persist what it
   * gets before anything can drop it. That is why this is read once at boot into the store rather
   * than polled from a component effect that can unmount mid-flight.
   *
   * The cost of losing one is bounded and worth stating, because it is what makes the destructive
   * read acceptable: a digest is a *notification*. The notes it names are already merged knowledge
   * and the query that found them is a saved watch, so losing the notification is not losing the
   * knowledge.
   *
   * Swallowed to empty on a 404 like the other list routes: a service without standing queries is
   * a smaller app, not an error.
   */
  listDigests(getToken: TokenGetter): Promise<Digest[]> {
    return orEmpty('/digests', () => request<Digest[]>('/digests', getToken));
  },

  /**
   * Claim the check-ins waiting for this chemist — their own work, still blocked.
   *
   * The same mailbox as `listDigests`, the same destructive contract, and therefore the same shape:
   * **the read is the consume**, so the caller claims once at the top of the app straight into
   * persisted state rather than polling it from a screen that can unmount mid-flight.
   *
   * What differs is the cost of losing one, and it is higher. A digest is a notification about
   * knowledge that is already merged — the notes stay, the watch stays, so losing the notice is not
   * losing the finding. A check-in has nothing behind it to re-find: the service's own handler says
   * an unreported one is a blocked question "a chemist simply does not learn about until it
   * expires", which is the gap the sweep exists to close. That is why the failure of this claim is
   * recorded in the store and said on screen rather than only logged.
   *
   * Swallowed to empty on a 404 like the other list routes — a service that predates the check-in
   * sweep is a smaller app, not an error. Nothing else is swallowed.
   */
  /**
   * Claim the check-in mailbox, reporting *which* emptiness happened.
   *
   * Every other list route folds a 404 into `[]` through `orEmpty`, and for those that is right:
   * an empty sidebar and a service that predates the route look the same to a reader and neither
   * is a claim. This one is different, because the section it feeds says **"nothing of yours is
   * blocked"** — an assertion about the chemist's work, on the one surface whose whole purpose is
   * that a blocked question is not missed.
   *
   * Two ways to arrive at zero rows and only one of them supports that sentence:
   *
   * - The service answered `200 []`. The mailbox is genuinely empty.
   * - The service has no such route (404), **or** it has the route and the sweep behind it is off
   *   — `check_in_enabled` defaults to `false` upstream while `GET /check-ins` is mounted
   *   unconditionally, so a deployment that has not turned the sweep on answers `200 []` for ever.
   *
   * The 404 is detectable here and is reported as `absent`. The second case is not visible from
   * this side at all: the response model carries no "the sweep is running" signal. This used to say
   * that was "recorded as a fifth bullet on `ISSUES.md` Issue 16 rather than guessed at" — it was
   * not; that entry had four bullets and none of them was this. It is recorded now, on the closed
   * entry, as the one thing the fix did not reach.
   */
  async listCheckIns(getToken: TokenGetter): Promise<CheckIn[] | 'absent'> {
    try {
      return await request<CheckIn[]>('/check-ins', getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/check-ins' });
        return 'absent';
      }
      throw err;
    }
  },

  /**
   * What is waiting on this chemist to answer — across every conversation.
   *
   * The inbox for `request_external_input`, for `BoCampaignWorkflow._measure` pausing at the bench
   * for measured yields, and for the connector-job path. **Not the deleted `/approvals`**: that
   * mechanism had three consumers and no producer, which is what made an empty list a lie. This one
   * has three live producers, and the service filters the listing to what this caller may actually
   * answer, so a row here is a row they can act on.
   *
   * Not swallowed into an empty list. "Nothing is waiting on you" and "we could not ask" are
   * opposite things to tell somebody whose bench work is blocked — the same argument
   * `listPendingPlans` makes, and the mistake the holds inbox made before it.
   */
  listPendingRequests(getToken: TokenGetter): Promise<PendingRequests> {
    return request<PendingRequests>('/pending', getToken);
  },

  /**
   * Answer one held-open question, releasing whatever is waiting on it.
   *
   * The service distinguishes four refusals and each is a different fact: 404 no such request, 403
   * not routed to you, **409 already decided**, 503 the broker did not take it. The 409 is the one
   * worth carrying to a surface — two chemists at one bench answering the same question is the
   * ordinary case, and the second must be told rather than have their answer dropped.
   */
  answerPendingRequest(
    requestId: string,
    payload: Record<string, unknown>,
    getToken: TokenGetter,
  ): Promise<void> {
    return request<void>(`/pending/${encodeURIComponent(requestId)}/answer`, getToken, {
      method: 'POST',
      body: JSON.stringify({ payload }),
    });
  },

  /**
   * The durable-run registry.
   *
   * Deliberately not scoped to the caller upstream — a run is a fact about the lab, and "what did
   * we already compute for this substrate" is the question it exists to answer. `text` searches
   * the recorded rationale, which is why a run three months old is findable at all.
   */
  async listJobs(
    getToken: TokenGetter,
    options: { text?: string; connector?: string } = {},
  ): Promise<JobRecordSummary[]> {
    const query = new URLSearchParams();
    if (options.text) query.set('text', options.text);
    if (options.connector) query.set('connector', options.connector);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return orEmpty('/jobs', () => request<JobRecordSummary[]>(`/jobs${suffix}`, getToken));
  },

  /**
   * One page of durable runs, with the cursor for the next — the same shape `pageSessions` has.
   *
   * Separate from `listJobs` for the same reason that pair is separate, and needed for the same
   * reason: the search is capped at `job_record_search_limit` (20 in the shipped config), the
   * service advertises `X-Next-Cursor` when it saw a further row, and nothing here read it — so a
   * chemist with more finished runs than the cap could not reach the older ones from any client and
   * the listing looked complete. `send` rather than `request`, because the cursor is a header.
   */
  async pageJobs(
    getToken: TokenGetter,
    options: { text?: string; connector?: string; after?: string } = {},
  ): Promise<JobPage> {
    const query = new URLSearchParams();
    if (options.text) query.set('text', options.text);
    if (options.connector) query.set('connector', options.connector);
    if (options.after) query.set('after', options.after);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    try {
      let res = await send(`/jobs${suffix}`, getToken, {});
      // The one-shot 401 recovery every route gets, written out here for the same reason
      // `pageSessions` writes it out: reaching a response header means not going through `request`.
      if (res.status === 401 && (await recoverFrom(getToken))) {
        res = await send(`/jobs${suffix}`, getToken, {});
      }
      if (!res.ok) {
        const failure = await readFailure(res);
        throw errorFromStatus(
          res.status,
          failure.detail,
          res.headers.get('retry-after'),
          failure.correlationId,
          failure.code,
        );
      }
      return {
        jobs: (await res.json()) as JobRecordSummary[],
        next: res.headers.get('x-next-cursor') ?? '',
      };
    } catch (err) {
      // The registry's own degradation, unchanged from `listJobs`: a service without the route
      // answers an empty page rather than an error, because this panel renders a failed search as
      // an empty result deliberately.
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/jobs' });
        return { jobs: [], next: '' };
      }
      throw err;
    }
  },

  getJob(jobId: string, getToken: TokenGetter): Promise<DurableJobStatus> {
    return request<DurableJobStatus>(`/jobs/${encodeURIComponent(jobId)}`, getToken);
  },

  /**
   * Ask the service to cancel a running job.
   *
   * 202, not 204: cancellation is *requested*, and a workflow already past its last cancellation
   * point will finish anyway. The caller must not tell the chemist it stopped.
   */
  cancelJob(jobId: string, getToken: TokenGetter): Promise<void> {
    return request<void>(`/jobs/${encodeURIComponent(jobId)}`, getToken, { method: 'DELETE' });
  },

  /** The plan a session is proposing, read for the hash that binds a decision to it. */
  getPlan(sessionId: string, getToken: TokenGetter): Promise<PlanStatus> {
    return request<PlanStatus>(`/sessions/${encodeURIComponent(sessionId)}/plan`, getToken);
  },

  /**
   * Every plan of the caller's that nobody has decided — the only plan read not tied to a session.
   *
   * Deliberately not error-swallowing into an empty inbox. `listApprovals` folded its 404 into
   * `[]` and the screen said "nothing is waiting on you" for a release; a failure here reaches the
   * caller so the screen can say it could not ask.
   */
  listPendingPlans(getToken: TokenGetter): Promise<PendingPlans> {
    return request<PendingPlans>('/plans/pending', getToken);
  },

  /**
   * Approve or reject a harness plan, bound to the exact plan the human was shown.
   *
   * `planHash` is required by the service and is deliberately not defaulted to "whatever the plan
   * is now": a plan that changed after being displayed is a different plan. A mismatch comes back
   * as 409 and is re-kinded here, because on this route that status means the plan moved, while
   * on the message route it means a turn is already running — one number, two meanings, and only
   * the caller knows which route it asked.
   */
  async decidePlan(
    sessionId: string,
    approved: boolean,
    planHash: string,
    getToken: TokenGetter,
  ): Promise<void> {
    try {
      await request<void>(`/sessions/${encodeURIComponent(sessionId)}/plan/decision`, getToken, {
        method: 'POST',
        body: JSON.stringify({ approved, plan_hash: planHash }),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        throw new ApiError('plan_changed', err.message, 409);
      }
      throw err;
    } finally {
      // Whatever the outcome, the inbox's answer is now suspect: an approval removes a row, and a
      // 409 means the plan moved under the reader. Invalidating is what keeps
      // `PENDING_PLANS_STALE_MS` from being a staleness window on the one action that invalidates
      // it. **After the write settles, never before it**: invalidating refetches an active
      // observer at once, so a read issued before the POST could be answered with the plan still
      // pending and cached as fresh for the whole window. `void`ed rather than awaited because the
      // caller is waiting on the decision, not on a re-read of a list it may not be looking at.
      void queryClient.invalidateQueries({ queryKey: keys.pendingPlans });
    }
  },

  /**
   * Experiment designs, newest activity first as the service orders them.
   *
   * A list route, so it degrades to `[]` on a 404 like every other one: a deployment whose service
   * predates protocols yields a screen that says nothing is here rather than a banner about a
   * feature that does not exist for it.
   *
   * The envelope is unwrapped here rather than at the caller. `{"designs": [...]}` is the service's
   * shape and `orEmpty` is written over arrays; unwrapping inside it is what lets the 404 fold into
   * an empty *list* instead of into an object nobody can read a length off.
   */
  async listProtocols(
    getToken: TokenGetter,
    options: { status?: DesignStatus; project?: string; limit?: number } = {},
  ): Promise<DesignSummary[]> {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.project) query.set('project', options.project);
    // Floored to an integer: the service validates it, but a fractional or `NaN` limit is a bug on
    // this side and sending it would get a 422 back describing the wrong problem.
    if (options.limit !== undefined && Number.isFinite(options.limit)) {
      query.set('limit', String(Math.trunc(options.limit)));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return orEmpty('/protocols', async () => {
      const body = await request<{ designs: DesignSummary[] }>(`/protocols${suffix}`, getToken);
      return body.designs;
    });
  },

  /**
   * One design — at its head, or at the revision asked for.
   *
   * Not swallowed. Unlike the list, this is opened by a click on a row that exists, so a 404 here
   * is a design that vanished between the list and the open, which is a fault a reader should see
   * rather than an empty document that looks like a design with nothing in it.
   */
  getProtocol(designId: string, getToken: TokenGetter, revision?: number): Promise<ProtocolView> {
    // Coerced rather than interpolated: `revision` reaches this from a URL and from a history row,
    // and the BFF forwards the query string untouched, so this is where it stops being arbitrary.
    const suffix =
      revision !== undefined && Number.isFinite(revision)
        ? `?revision=${encodeURIComponent(String(Math.trunc(revision)))}`
        : '';
    return request<ProtocolView>(`/protocols/${encodeURIComponent(designId)}${suffix}`, getToken);
  },

  /**
   * Write a new revision of a design.
   *
   * `parentRevision` is the revision the edit was written against and is deliberately not defaulted
   * to "whatever the head is now" — that is the same argument `decidePlan` makes about `planHash`,
   * and it has the same failure if it is dropped: a save that silently rebased onto somebody else's
   * revision would discard their edit while telling this chemist theirs succeeded. The service
   * answers 409 when it is not the head, and that is re-kinded to `revision_conflict` here, because
   * 409 on the message route means a turn is already running and only the caller knows which route
   * it asked.
   *
   * `changeNote` is required by the surface rather than by this function: a revision with no stated
   * reason tells the next reader nothing about why the numbers moved.
   */
  async putProtocolRevision(
    designId: string,
    document: ExperimentDesign,
    parentRevision: number,
    changeNote: string,
    getToken: TokenGetter,
  ): Promise<RevisionWritten> {
    try {
      return await request<RevisionWritten>(
        `/protocols/${encodeURIComponent(designId)}/revisions`,
        getToken,
        {
          method: 'POST',
          body: JSON.stringify({
            document,
            parent_revision: parentRevision,
            change_note: changeNote,
          }),
        },
      );
    } catch (err) {
      // **The rebuild carries the correlation id, and it used to drop it.** `errorFromStatus` had
      // just read the service's own reference off the failed response and attached it; a
      // constructor call with no `options` silently returned it to `''`, so this route — and the
      // status route below, which copied this shape — was the one place a banner could not say
      // "(reference …)". `api/errors.ts` states the rule the rest of this file keeps: every banner
      // carries a reference. `retryable` is deliberately not copied: it is derived from the kind,
      // and the kind is what this line changes.
      if (err instanceof ApiError && err.status === 409) {
        throw new ApiError('revision_conflict', err.message, 409, {
          correlationId: err.correlationId,
        });
      }
      throw err;
    }
  },

  /** What changed between two revisions. Opened by a click, so nothing is swallowed. */
  getProtocolDiff(
    designId: string,
    from: number,
    to: number,
    getToken: TokenGetter,
  ): Promise<DesignDiff> {
    // **`from_revision`/`to_revision`, which is what the route binds.** These were `from`/`to`;
    // FastAPI ignores an unknown query parameter, so every comparison silently answered **200**
    // with the route's defaults — revision 1 against the head — while `RevisionDiff`'s header
    // printed the two numbers the chemist had actually clicked. A wrong diff is worse than a
    // failed one here: the diff is the record of what an expert changed.
    const query = new URLSearchParams({
      from_revision: String(Math.trunc(from)),
      to_revision: String(Math.trunc(to)),
    });
    return request<DesignDiff>(
      `/protocols/${encodeURIComponent(designId)}/diff?${query.toString()}`,
      getToken,
    );
  },

  /**
   * Move a design's status, against the revision *and the status* the chemist was reading, with the
   * reason beside it.
   *
   * 204: the service records the move and returns nothing. `reason` is what makes an `abandoned`
   * design readable a year later — it is the only field that says why a design nobody ran exists.
   *
   * **`expectedRevision` is the revision on screen, and the service refuses anything else with a
   * 409.** It is `parent_revision`'s twin for a sign-off: without it the service stamped whatever
   * the head had become, so a chemist who read revision 1, thought about it, and clicked Approve
   * after a colleague saved revision 2 had their name recorded against a document they never saw —
   * with no race required, just the seconds between reading and clicking.
   *
   * **`expectedStatus` is the badge on screen, and it closes the half `expectedRevision` cannot
   * see.** That compare-and-set is on the *document*, so it says nothing about the decision: two
   * people looking at revision 1 could approve and abandon it and both were told 204, measured 100
   * of 100, and a design retired because the starting material decomposes came back into the draft
   * listing without anybody being told. The service now refuses the second move with
   * `{"code": "status_conflict"}`, which `errorFromStatus` turns into its own kind — the document
   * did not move, so sending the chemist to a diff would show them nothing.
   *
   * The `catch` is the older-deployment case, and it is `putProtocolRevision`'s for the same
   * reason: a service that answers 409 with a bare string carries no code, and on this route a
   * service that predates `expected_status` can only have refused the revision.
   */
  async setProtocolStatus(
    designId: string,
    status: DesignStatus,
    expectedRevision: number,
    expectedStatus: DesignStatus,
    reason: string,
    getToken: TokenGetter,
  ): Promise<void> {
    try {
      await request<void>(`/protocols/${encodeURIComponent(designId)}/status`, getToken, {
        method: 'POST',
        body: JSON.stringify({
          status,
          expected_revision: expectedRevision,
          expected_status: expectedStatus,
          reason,
        }),
      });
    } catch (err) {
      // The reference is carried across the re-kind for `putProtocolRevision`'s reason, and this
      // is the site where losing it costs most: a refused sign-off is the failure a chemist is
      // likeliest to have to ask somebody about.
      if (err instanceof ApiError && err.status === 409 && err.kind === 'turn_in_flight') {
        throw new ApiError('revision_conflict', err.message, 409, {
          correlationId: err.correlationId,
        });
      }
      throw err;
    }
  },
};
