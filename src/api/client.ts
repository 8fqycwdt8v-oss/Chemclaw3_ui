/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * List routes (sessions, transcripts, jobs) fold a 404 into an empty result so an older service
 * yields a smaller app; note that a deleted route then looks like an empty list. Fetch routes (one
 * tool result, one note) do not: they are only called when the turn said the thing exists, so a 404
 * is a real fault.
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
import {
  ApiError,
  CORRELATION_HEADER,
  StaleRevisionError,
  errorFromStatus,
  readFailure,
} from './errors.ts';
import type {
  ExhibitDiff,
  ExhibitHeader,
  ExhibitListOut,
  ExhibitRevision,
  ExhibitRevisionsOut,
  ExhibitSpec,
  ExhibitView,
  RawExhibitSpec,
  ExportFormat,
  ExhibitIndexOut,
} from '../../shared/exhibits.ts';
import { keys, queryClient } from './queryClient.ts';
import { CALC_ARTIFACT_REF } from '../../shared/exhibitConstants.ts';
import { SESSION_ID_RE } from '../../shared/events.ts';

/**
 * The artefact decoders (`shared/exhibits.ts`), loaded on the first artefact body rather than in
 * the first load, so deployments without artefacts never pay for the valibot schema.
 */
const exhibitDecoders = () => import('../../shared/exhibits.ts');

/**
 * How a request authenticates: a bare token getter, or an auth provider that can also recover from
 * a 401 (silent refresh or interactive redirect). `request` asks once, so every route gets the same
 * recovery.
 */
export type TokenGetter =
  (() => Promise<string | null>) | Pick<AuthProvider, 'getAccessToken' | 'handleUnauthorized'>;

/** The bearer for this request, from either accepted shape. */
export const tokenFrom = async (auth: TokenGetter): Promise<string | null> =>
  typeof auth === 'function' ? auth() : auth.getAccessToken();

/**
 * Ask the provider to recover from a 401. Only `true` means "a fresh token is available, retry
 * once"; a bare getter, a redirect in flight or a re-auth cooldown all give `false`.
 */
export const recoverFrom = async (auth: TokenGetter): Promise<boolean> =>
  typeof auth === 'function' ? false : auth.handleUnauthorized();

async function send(path: string, auth: TokenGetter, init: RequestInit): Promise<Response> {
  let token: string | null;
  try {
    token = await tokenFrom(auth);
  } catch (err) {
    // Token acquisition failed before any request was sent (e.g. a silent-refresh network error).
    // Surface it as an `ApiError` so callers do not mistake it for a detached stream.
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
      // `no-store` by default: sessions, transcripts and lists are mutable and session-scoped.
      // Content-addressed routes opt out (`contentAddressed`).
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
  // One retry, only on 401, only when the caller can recover; a second attempt would be a redirect
  // loop. Bodies here are strings, so re-sending is safe. `uploadAttachment` (XHR) carries its own
  // copy.
  if (res.status === 401 && (await recoverFrom(auth))) {
    res = await send(path, auth, init);
  }

  if (!res.ok) {
    // Read back rather than sent: the service issues the id and stamps it on its own log records,
    // so quoting it is what joins a banner a chemist screenshotted to one line in the logs.
    const failure = await readFailure(res);
    // The one refusal that carries a number the caller acts on, so it is raised as its own type
    // here — the body is consumed by `readFailure`, and nothing after this line can read it again.
    if (res.status === 409 && failure.code === 'stale_revision') {
      throw new StaleRevisionError(
        failure.headRevision ?? null,
        failure.detail || 'This artefact was revised after you opened it.',
        failure.correlationId,
      );
    }
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
 * `request` for a listing whose continuation is the `X-Next-Cursor` header (`''` on the last page).
 * The body is cast here to the wire model so the contract check can read it.
 */
async function requestPage<T>(path: string, auth: TokenGetter): Promise<{ body: T; next: string }> {
  let res = await send(path, auth, {});
  // Under MSAL `recoverFrom` triggers the sign-in redirect, so listings must call it like every
  // other route.
  if (res.status === 401 && (await recoverFrom(auth))) {
    res = await send(path, auth, {});
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
  return { body: (await res.json()) as T, next: res.headers.get('x-next-cursor') ?? '' };
}

/**
 * `request` for a route whose URL changes whenever its bytes do: lets the browser cache the answer
 * (`default` instead of `no-store`). Sharing a read between components is react-query's job
 * (`queries.ts`, `IMMUTABLE`). The service sets no `Cache-Control` on these routes, so this gets
 * revalidation at best.
 */
function contentAddressed<T>(path: string, auth: TokenGetter): Promise<T> {
  return request<T>(path, auth, { cache: 'default' });
}

/**
 * Fold a 404 from a list route into `[]`, and log it: an empty sidebar and a service that predates
 * the route should not be indistinguishable to an operator.
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
 * One of the caller's sessions, as `GET /sessions` lists them. `created_at` is when it started, not
 * its last activity; sort by `updated_at`.
 */
export interface SessionSummary {
  session_id: string;
  created_at?: string;
  /**
   * The session's last activity (newest stored message). Optional for older services; callers fall
   * back to `created_at`.
   */
  updated_at?: string;
  /**
   * A name derived server-side from the first user message. `null` (first turn predates the field)
   * is distinct from `""`.
   */
  title?: string | null;
}

/** One page of `GET /sessions`, plus the cursor that continues it. */
export interface SessionPage {
  sessions: SessionSummary[];
  /**
   * `X-Next-Cursor`, or `''` on the last page. Following a cursor the service did not advertise is
   * a 422.
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
   * Content address of the full result, when the service still holds it; empty means nothing to
   * fetch (swept or never stored). Without it a reloaded transcript can only show the preview.
   */
  result_ref?: string;
  /**
   * The model was shown a cut of this result (as `ToolResultEvent.result_cut` live); `result_ref`
   * then opens the full text. Absent means not cut.
   */
  result_cut?: boolean;
}

export interface TranscriptMessage {
  index: number;
  role: string;
  text: string;
  /**
   * The calls the agent made producing this message, so a rehydrated transcript keeps its trace
   * rows.
   */
  tool_calls: TranscriptToolCall[];
  /**
   * The turn that stored this message (`session_messages.correlation_id`), matching the turn's
   * response header, so detach recovery can find its answer by identity. `null` or absent for rows
   * without it.
   */
  correlation_id?: string | null;
  /**
   * Who wrote this message: the person it was for and the agent that wrote it (`agent` null for a
   * person's own words). In a shared session a user bubble uses it to say whose question it is.
   */
  author?: Authorship | null;
  /**
   * How the turn this question opened has ended so far: `running`, `done`, `failed`, `stopped`, or
   * `interrupted` (the process died). The service writes the question ahead of the turn. `null` on
   * non-questions; absent from older services, read as before.
   */
  turn_status?: TranscriptTurnStatus | null;
}

/** The ways a written-ahead turn can stand (`TranscriptMessage.turn_status`). */
export type TranscriptTurnStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';

/** The person a thing was written for, and the agent that wrote it (`null`: a human did). */
export interface Authorship {
  actor?: string | null;
  agent?: string | null;
}

/** One person the owner has let into a session, and since when. */
export interface SessionMemberOut {
  actor: string;
  added_at: string;
}

/**
 * Who may reach a session: its owner and the members the owner admitted. `owner` is `null` for a
 * session with no recorded owner, which has no members.
 */
export interface SessionMembersOut {
  owner: string | null;
  members: SessionMemberOut[];
}

/**
 * One message waiting in a shared session's line — an entry of `GET /sessions/{id}/queue`
 * (Chemclaw3 #499). No text: the line holds the order and never the message.
 */
export interface QueuedMessageOut {
  ticket: number;
  sender: string;
  enqueued_at: string;
  /** How many are ahead of it; `0` is next. */
  position: number;
  /** Whether the caller sent it. */
  mine: boolean;
}

/**
 * A session's line, and whether a turn is running on the replica that answered — `GET
 * /sessions/{id}/queue`. Polled by an open shared conversation.
 */
export interface SessionQueueOut {
  running: boolean;
  waiting: QueuedMessageOut[];
}

/**
 * A session somebody else owns that the caller was let into (`GET /sessions/shared`). `owner` and
 * `title` are `null` under the in-process store.
 */
export interface SharedSessionSummary {
  session_id: string;
  owner?: string | null;
  title?: string | null;
  added_at: string;
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
 * One finished durable run from the permanent job record. `rationale` (why it was launched) is what
 * `find_past_jobs` searches; results outlive Temporal history.
 */
export interface JobRecordSummary {
  job_id: string;
  connector: string;
  job: string;
  rationale: string;
  summary: string;
  note_id: string;
  /** The plan step the run served, or empty. Matches `job_started.plan_step` live. */
  plan_step: string;
  /**
   * How the run ended: `completed` or `failed`. `failure_reason` is on the full record, not the
   * listing.
   */
  state: string;
  completed_at: string | null;
}

/**
 * One page of the durable-run registry. The cursor is a `job_id`, advertised only when a further
 * row exists.
 */
export interface JobPage {
  jobs: JobRecordSummary[];
  /** `''` when this page is the whole answer. */
  next: string;
}

/**
 * One standing query's finding since it last reported. No timestamp is sent. `headlines` and
 * `disputed` are what a reader acts on; `note_ids` resolve through the citation chip.
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
 * One of the caller's own questions still waiting on somebody else (`CheckInOut`,
 * `api/routes/streams.py`) — the opposite direction from `PendingRequest`.
 *
 * Every field is always present, possibly empty. The day counts are whole days rounded down by the
 * service; never recompute them. `subject` and `rationale` are truncated by the service with the
 * truncation named in the text, so render them as given. There is no timestamp; the card says when
 * it was claimed.
 */
export interface CheckInOut {
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
   * The conversation the question was asked in, or empty (a plate run or connector job has none).
   */
  session_id: string;
  /**
   * Whether the notice carrying this question was short of the asker's whole blocked set. Same
   * value on every card from one notice.
   */
  truncated: boolean;
}

/** What the check-in section renders: the wire row as it arrives. */
export type CheckIn = CheckInOut;

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

export interface PendingRequestsOut {
  requests: PendingRequest[];
  /** The length of `requests`, not a total. */
  count: number;
  /**
   * Everything matching this caller's routing before the page bound and the gate; `verdict` says
   * why it exceeds `count`.
   */
  total_routed_to_you: number;
  /** Whether waiting rows exist that this page did not carry. */
  truncated: boolean;
  /**
   * What this page is, in the service's own sentence, rendered above the list (a `computed_field`
   * upstream). Empty from older services.
   */
  verdict: string;
}

export type PendingRequests = PendingRequestsOut;

/** One job's live status and structured result. */
export interface DurableJobStatus {
  job_id: string;
  status: string;
  summary: string | null;
  result: Record<string, unknown>;
  /**
   * Calculation keys the run rested on, as `record_knowledge_note` takes them. Empty when none were
   * recorded.
   */
  calc_refs: string[];
  rationale: string;
}

/**
 * The untruncated text of one tool result. `text` is not typed as JSON: parsing belongs to the
 * renderer that wants a shape.
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
 * A note's identity and provenance, without its body; also a neighbour. `confidence` and the other
 * nullable fields are `null` for most notes.
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
export interface PlanStatusOut {
  session_id: string;
  plan_hash: string;
  plan: string[];
  /**
   * What approving this plan would authorize: every tool its steps declare. Absent (older service)
   * means unknown, not "nothing". The `plan` event carries it too; this read is the fallback and
   * the re-read after a 409.
   */
  scope?: string[];
  /** `plan_only` until a human approves; `execute` afterwards. */
  mode: string;
  approved: boolean;
  decided_by: string | null;
  /**
   * Whose turn last wrote this plan — the only person who may decide it (others get 403). `null` or
   * absent: the session owner decides.
   */
  author?: string | null;
}

export type PlanStatus = PlanStatusOut;

/** One conversation whose plan nobody has decided, as the cross-session inbox lists it. */
export interface PendingPlan {
  session_id: string;
  title: string | null;
  updated_at: string;
  plan_hash: string;
  plan: string[];
  /** What approving it would authorize — see `PlanStatus.scope`. */
  scope?: string[];
  /**
   * The session owner's actor id. Opening a plan in a conversation the reader was only let into
   * adopts it as shared. `null` when unknown; absent from older services, which fall back to
   * `/sessions/shared`.
   */
  owner?: string | null;
}

/**
 * One change to what the agent does, waiting on the person it would act on. The body is always
 * included so nobody approves something unseen.
 */
export interface ProposalOut {
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

export type BehaviourProposal = ProposalOut;

/** `GET /proposals`: the envelope `listProposals` unwraps. */
export interface ProposalsOut {
  proposals: ProposalOut[];
}

/** One skill a chemist keeps or the organisation publishes; one shape for both tiers. */
export type SkillDocument = LocalSkillOut | OrgSkillOut;

/** A personal skill on the wire. Two models upstream for one shape, so two names here. */
export interface LocalSkillOut {
  name: string;
  body: string;
}

/** An organisation skill on the wire. */
export interface OrgSkillOut {
  name: string;
  body: string;
}

/** `GET`/`DELETE /skills/mine`: the names, in the envelope the list and the forget both answer. */
export interface LocalSkillsOut {
  skills: string[];
}

/** `GET`/`DELETE /skills/org`: the same envelope for the organisation tier. */
export interface OrgSkillsOut {
  skills: string[];
}

/** One body that was once the organisation's active judgment, and who made it so. */
export interface OrgSkillVersion {
  content_hash: string;
  body: string;
  activated_by: string;
  activated_at: string;
}

/** `GET /skills/org/{name}/versions`: the envelope `listOrgSkillVersions` unwraps. */
export interface OrgSkillVersionsOut {
  versions: OrgSkillVersion[];
}

/** `POST /sessions` and `POST /sessions/{id}/fork`: the one field a new session is. */
export interface SessionOut {
  session_id: string;
}

export interface PendingPlansOut {
  plans: PendingPlan[];
  /** Sessions of the caller's the service looked at — the same set `GET /sessions` lists. */
  considered: number;
  /** Of those, the ones running a plan-gated profile: the only ones that can hold a decision. */
  gated: number;
  /** Gated sessions whose plan was not read, so the list is short by an unknown amount. */
  unread: number;
  /**
   * Whether the service's walk through the caller's conversations stopped early — an empty `plans`
   * that may be incomplete. Absent (older service) changes no copy and does not mean "complete".
   */
  truncated?: boolean;
}

export type PendingPlans = PendingPlansOut;

/**
 * `GET /protocols`: the envelope `listProtocols` unwraps. `total` and `truncated` are not declared
 * because nothing reads them yet; they are argued in `tests/backendContract.test.ts`'s `NOT_READ`.
 */
export interface DesignListOut {
  designs: DesignSummary[];
}

/**
 * One design at one revision plus its whole revision history — `DesignOut`, the service's flat
 * shape (`view.revision` is a number). Kept as the wire shape rather than translated.
 */
export type ProtocolView = DesignOut;

/** What `POST /protocols/{id}/revisions` answers with: the revision it wrote, re-checked. */
export interface RevisionOut {
  /** The design written to — the one the caller posted against, echoed. */
  design_id: string;
  revision: number;
  /** Re-run against the saved document, so an edit that introduced a blocker says so at once. */
  checks: ProtocolCheck[];
  changed_paths: string[];
}

export type RevisionWritten = RevisionOut;

/**
 * POST one file to a session's attachment route with progress. XHR because `fetch` cannot report
 * upload progress. A function so `uploadAttachment` can call it again after a recovered 401.
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
      // Read the correlation id back as `request` does, so upload failures join the service's logs.
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
   * Behaviour proposals waiting on this person. Not wrapped in `orEmpty`: the service answers 503
   * where proposals are disabled, which must not read as "nothing is waiting".
   */
  listProposals(getToken: TokenGetter, state = 'open'): Promise<BehaviourProposal[]> {
    return request<ProposalsOut>(`/proposals?state=${encodeURIComponent(state)}`, getToken).then(
      (page) => page.proposals ?? [],
    );
  },

  /**
   * Accept or decline one proposal, bound to the shown document by `content_hash`, so a superseded
   * proposal is not authorized by name.
   */
  decideProposal(
    getToken: TokenGetter,
    kind: string,
    name: string,
    contentHash: string,
    accepted: boolean,
    reason = '',
  ): Promise<ProposalOut> {
    return request<ProposalOut>(
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
    return request<LocalSkillsOut>('/skills/mine', getToken).then((page) => page.skills ?? []);
  },

  /** One of this chemist's own skills, verbatim — the body a turn is actually given. */
  readMySkill(getToken: TokenGetter, name: string): Promise<SkillDocument> {
    return request<LocalSkillOut>(`/skills/mine/${encodeURIComponent(name)}`, getToken);
  },

  /** Stop one of this chemist's own skills acting. */
  forgetMySkill(getToken: TokenGetter, name: string): Promise<string[]> {
    return request<LocalSkillsOut>(`/skills/mine/${encodeURIComponent(name)}`, getToken, {
      method: 'DELETE',
    }).then((page) => page.skills ?? []);
  },

  /** The names of the skills acting on every turn in this deployment. Open to any caller. */
  listOrgSkills(getToken: TokenGetter): Promise<string[]> {
    return request<OrgSkillsOut>('/skills/org', getToken).then((page) => page.skills ?? []);
  },

  /** One organisation skill, verbatim. */
  readOrgSkill(getToken: TokenGetter, name: string): Promise<SkillDocument> {
    return request<OrgSkillOut>(`/skills/org/${encodeURIComponent(name)}`, getToken);
  },

  /**
   * Every body ever activated under this name, newest first; readable by everyone because this tier
   * acts on everyone.
   */
  listOrgSkillVersions(getToken: TokenGetter, name: string): Promise<OrgSkillVersion[]> {
    return request<OrgSkillVersionsOut>(
      `/skills/org/${encodeURIComponent(name)}/versions`,
      getToken,
    ).then((page) => page.versions ?? []);
  },

  /**
   * Keep one skill for yourself, replacing any earlier version of that name (from its frontmatter).
   * The service's 409 (reserved name or row cap) and 422 (not a valid `SKILL.md`) messages are
   * surfaced as-is.
   */
  saveMySkill(getToken: TokenGetter, body: string): Promise<SkillDocument> {
    return request<LocalSkillOut>('/skills/mine', getToken, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  /** Publish one skill to the whole deployment. 403 without the privileged role. */
  publishOrgSkill(getToken: TokenGetter, body: string): Promise<SkillDocument> {
    return request<OrgSkillOut>('/skills/org', getToken, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  /** Make a body this tier already holds active again; a hash it does not hold is a 404. */
  revertOrgSkill(getToken: TokenGetter, name: string, contentHash: string): Promise<SkillDocument> {
    return request<OrgSkillOut>(`/skills/org/${encodeURIComponent(name)}/revert`, getToken, {
      method: 'POST',
      body: JSON.stringify({ content_hash: contentHash }),
    });
  },

  /** Stop one organisation skill acting, keeping its history. 403 without the privileged role. */
  retireOrgSkill(getToken: TokenGetter, name: string): Promise<string[]> {
    return request<OrgSkillsOut>(`/skills/org/${encodeURIComponent(name)}`, getToken, {
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
   * Mint a backend session, optionally on a named agent profile (a name the service does not know
   * is a 400).
   */
  createSession(getToken: TokenGetter, profile?: string): Promise<SessionOut> {
    return request<SessionOut>('/sessions', getToken, {
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
   * One page of sessions with the next cursor. Separate from `listSessions` (which folds 404 to
   * `[]`) so "no more pages" and "no such route" stay distinguishable.
   */
  async pageSessions(getToken: TokenGetter, after?: string): Promise<SessionPage> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    try {
      // Through `requestPage` so the first authenticated call on boot can trigger sign-in.
      const page = await requestPage<SessionSummary[]>(`/sessions${query}`, getToken);
      return { sessions: page.body, next: page.next };
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/sessions' });
        return { sessions: [], next: '' };
      }
      throw err;
    }
  },

  /**
   * Stop the session's running turn; closing the stream only detaches. `false` when there was
   * nothing to stop (finished in the race, or an older service).
   *
   * `keepalive` is for a `pagehide` caller (requests are capped at 64 KiB and share a budget with
   * the log sink). `reason: 'unload'` lets the service defer the stop and cancel it if a reload
   * reattaches; older services ignore it and stop at once.
   */
  async stopTurn(
    sessionId: string,
    getToken: TokenGetter,
    options: { keepalive?: boolean; reason?: 'unload' } = {},
  ): Promise<boolean> {
    const reason = options.reason ? `?reason=${encodeURIComponent(options.reason)}` : '';
    try {
      await request<{ stopped: boolean; deferred?: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/turn/stop${reason}`,
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

  /**
   * Withdraw this person's queued message from a shared conversation (`DELETE
   * /sessions/{id}/queue/{ticket}`). Not `stopTurn`: the running turn is somebody else's. `false`
   * on 404 — it already started or was withdrawn; the caller then falls back to stopping.
   */
  async withdrawQueued(
    sessionId: string,
    ticket: number,
    getToken: TokenGetter,
    options: { keepalive?: boolean } = {},
  ): Promise<boolean> {
    try {
      await request<void>(
        `/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(String(ticket))}`,
        getToken,
        {
          method: 'DELETE',
          ...(options.keepalive ? { keepalive: true } : {}),
        },
      );
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return false;
      throw err;
    }
  },

  /**
   * A shared session's line — `GET /sessions/{id}/queue`. `null` on 404 (older service or no longer
   * a member): the caller stops polling without a banner.
   */
  async getQueue(sessionId: string, getToken: TokenGetter): Promise<SessionQueueOut | null> {
    try {
      return await request<SessionQueueOut>(
        `/sessions/${encodeURIComponent(sessionId)}/queue`,
        getToken,
      );
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') return null;
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
   * Upload a working file with progress and cancel; adds the one-shot 401 recovery around `upload`.
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
   * The full text of one tool result, fetched only on demand. Not swallowed: it is only called when
   * the turn carried a `result_ref`.
   */
  getToolResult(sessionId: string, ref: string, getToken: TokenGetter): Promise<StoredToolResult> {
    return contentAddressed<StoredToolResult>(
      `/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(ref)}`,
      getToken,
    );
  },

  /**
   * One knowledge note with its neighbourhood (`hops` clamped upstream; 1 = direct links). The id
   * is encoded: note slugs may contain path-significant characters.
   */
  getNote(noteId: string, getToken: TokenGetter, hops = 1): Promise<NoteView> {
    return contentAddressed<NoteView>(
      `/notes/${encodeURIComponent(noteId)}?hops=${encodeURIComponent(String(hops))}`,
      getToken,
    );
  },

  /**
   * Delete one conversation on the service (transcript, checkpoints, attachments). A 404 counts as
   * success: the service answers 404 for unknown and not-yours alike. Every other failure is
   * reported.
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
   * Branch this conversation onto a new session carrying its history. Refusals: 409 turn in flight,
   * 501 no durable session store, 404 unknown or not yours.
   */
  forkSession(sessionId: string, getToken: TokenGetter): Promise<SessionOut> {
    return request<SessionOut>(`/sessions/${encodeURIComponent(sessionId)}/fork`, getToken, {
      method: 'POST',
    });
  },

  /**
   * Who is in a session. Not swallowed: a 404 means removed or an older service, and the panel says
   * it could not tell.
   */
  listMembers(sessionId: string, getToken: TokenGetter): Promise<SessionMembersOut> {
    return request<SessionMembersOut>(
      `/sessions/${encodeURIComponent(sessionId)}/members`,
      getToken,
    );
  },

  /**
   * Let `actor` into this session (owner only). Refusals keep the service's sentence: 403 not
   * owner, 409 owner named themself, 422 blank id. A repeat is a 204.
   */
  async addMember(sessionId: string, actor: string, getToken: TokenGetter): Promise<void> {
    await request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(actor)}`,
      getToken,
      { method: 'PUT' },
    );
  },

  /** Remove `actor` (owner) or leave (own id). 404 "not a member" stays an error. */
  async removeMember(sessionId: string, actor: string, getToken: TokenGetter): Promise<void> {
    await request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(actor)}`,
      getToken,
      { method: 'DELETE' },
    );
  },

  /** Sessions others own that the caller was let into, newest first; 404 folds to `[]`. */
  listSharedSessions(getToken: TokenGetter): Promise<SharedSessionSummary[]> {
    return orEmpty('/sessions/shared', () =>
      request<SharedSessionSummary[]>('/sessions/shared', getToken),
    );
  },

  /**
   * Claim the standing-query digests for this chemist. The read is destructive (claimed rows are
   * never re-delivered), so the caller persists the result immediately; it is read once at boot.
   * Losing one loses a notification, not knowledge. 404 folds to `[]`.
   */
  listDigests(getToken: TokenGetter): Promise<Digest[]> {
    return orEmpty('/digests', () => request<Digest[]>('/digests', getToken));
  },

  /**
   * Claim the check-in mailbox (destructive, like `listDigests`), reporting which emptiness
   * happened: `'absent'` on a 404 rather than `[]`, because the section says "nothing of yours is
   * blocked". A deployment with the sweep off also answers `200 []`, which is not detectable here.
   */
  async listCheckIns(getToken: TokenGetter): Promise<CheckIn[] | 'absent'> {
    try {
      return await request<CheckInOut[]>('/check-ins', getToken);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/check-ins' });
        return 'absent';
      }
      throw err;
    }
  },

  /**
   * Questions waiting on this chemist to answer, across conversations, filtered by the service to
   * what the caller may answer. Not swallowed: "nothing waiting" and "could not ask" must differ.
   */
  listPendingRequests(getToken: TokenGetter): Promise<PendingRequestsOut> {
    return request<PendingRequestsOut>('/pending', getToken);
  },

  /**
   * Answer one held-open question. Refusals: 404 unknown, 403 not routed to you, 409 already
   * decided (surfaced to the reader), 503 broker did not take it.
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

  /** The durable-run registry, not scoped to the caller. `text` searches the recorded rationale. */
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
   * One page of durable runs with the `X-Next-Cursor` cursor; needed because the search is capped
   * (`job_record_search_limit`).
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
      const page = await requestPage<JobRecordSummary[]>(`/jobs${suffix}`, getToken);
      return { jobs: page.body, next: page.next };
    } catch (err) {
      // An older service without the route answers an empty page, as `listJobs` does.
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/jobs' });
        return { jobs: [], next: '' };
      }
      throw err;
    }
  },

  /**
   * One run's status from the registry. `sessionId` is the card's conversation: the service returns
   * a result's `exhibit_id` only to a caller naming the run's origin session. Only a session id is
   * ever sent; the BFF refuses other queries.
   */
  getJob(jobId: string, getToken: TokenGetter, sessionId?: string): Promise<DurableJobStatus> {
    const suffix =
      sessionId && SESSION_ID_RE.test(sessionId)
        ? `?session_id=${encodeURIComponent(sessionId)}`
        : '';
    return request<DurableJobStatus>(`/jobs/${encodeURIComponent(jobId)}${suffix}`, getToken);
  },

  /**
   * Request cancellation of a running job (202): a workflow past its last cancellation point still
   * finishes, so do not tell the chemist it stopped.
   */
  cancelJob(jobId: string, getToken: TokenGetter): Promise<void> {
    return request<void>(`/jobs/${encodeURIComponent(jobId)}`, getToken, { method: 'DELETE' });
  },

  /** The plan a session is proposing, read for the hash that binds a decision to it. */
  getPlan(sessionId: string, getToken: TokenGetter): Promise<PlanStatusOut> {
    return request<PlanStatusOut>(`/sessions/${encodeURIComponent(sessionId)}/plan`, getToken);
  },

  /**
   * Every undecided plan of the caller's. Not folded to `[]`: a failure must let the screen say it
   * could not ask.
   */
  listPendingPlans(getToken: TokenGetter): Promise<PendingPlansOut> {
    return request<PendingPlansOut>('/plans/pending', getToken);
  },

  /**
   * Approve or reject a plan, bound to the exact plan shown by `planHash`. A 409 here means the
   * plan moved and is re-kinded, since 409 on the message route means a turn is running.
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
      // Invalidate the inbox after the write settles, never before (an early refetch could cache
      // the still-pending plan). Not awaited: the caller waits on the decision only.
      void queryClient.invalidateQueries({ queryKey: keys.pendingPlans });
    }
  },

  /**
   * Experiment designs, newest activity first. Unwrapped inside `orEmpty` so a 404 folds to an
   * empty list.
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
      const body = await request<DesignListOut>(`/protocols${suffix}`, getToken);
      return body.designs;
    });
  },

  /** One design at its head or a given revision. Not swallowed: opened from a row that exists. */
  getProtocol(designId: string, getToken: TokenGetter, revision?: number): Promise<ProtocolView> {
    // Coerced rather than interpolated: `revision` reaches this from a URL and from a history row,
    // and the BFF forwards the query string untouched, so this is where it stops being arbitrary.
    const suffix =
      revision !== undefined && Number.isFinite(revision)
        ? `?revision=${encodeURIComponent(String(Math.trunc(revision)))}`
        : '';
    return request<DesignOut>(`/protocols/${encodeURIComponent(designId)}${suffix}`, getToken);
  },

  /**
   * Write a new revision of a design against `parentRevision`, never defaulted to the current head,
   * so a save cannot silently overwrite someone else's revision. A 409 is re-kinded to
   * `revision_conflict`.
   */
  async putProtocolRevision(
    designId: string,
    document: ExperimentDesign,
    parentRevision: number,
    changeNote: string,
    getToken: TokenGetter,
  ): Promise<RevisionOut> {
    try {
      return await request<RevisionOut>(
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
      // Carry the correlation id across the re-kind so the banner keeps its reference. `retryable`
      // follows from the kind.
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
    // The route binds `from_revision`/`to_revision`; FastAPI silently ignores unknown parameters.
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
   * Move a design's status (204), with a reason. `expectedRevision` (the revision on screen) and
   * `expectedStatus` (the badge on screen) are compare-and-set guards: the service refuses a stale
   * revision with 409 and a stale status with `status_conflict`. The `catch` handles older services
   * whose 409 carries no code.
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
      // Keep the correlation id across the re-kind, as in `putProtocolRevision`.
      if (err instanceof ApiError && err.status === 409 && err.kind === 'turn_in_flight') {
        throw new ApiError('revision_conflict', err.message, 409, {
          correlationId: err.correlationId,
        });
      }
      throw err;
    }
  },

  /*
   * ── Artefacts ── The service's `exhibit` routes. Each body is cast to the contract's model name
   * (paired by `tests/backendContract.test.ts`) and then decoded, so a malformed spec becomes a
   * message rather than a `TypeError`.
   */

  /**
   * One session's artefacts and whether this deployment has them. A 404 folds to `enabled: false`
   * (logged), not an empty enabled list.
   */
  async listExhibits(sessionId: string, getToken: TokenGetter): Promise<ExhibitListOut> {
    try {
      const body = await request<ExhibitListOut>(
        `/sessions/${encodeURIComponent(sessionId)}/exhibits`,
        getToken,
      );
      return (await exhibitDecoders()).decodeExhibitList(body);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'session_not_found') {
        logger.warn('api.list_route_missing', { route: '/sessions/{id}/exhibits' });
        return { enabled: false, html_enabled: false, exhibits: [] };
      }
      throw err;
    }
  },

  /** One artefact at its head or a given revision (`0`/absent = head). Not swallowed. */
  async getExhibit(
    sessionId: string,
    exhibitId: string,
    getToken: TokenGetter,
    revision?: number,
  ): Promise<ExhibitView> {
    // Coerced rather than interpolated, for `getProtocol`'s reason: the number reaches this from a
    // picker and from a stream frame, and the BFF forwards the query string untouched.
    const suffix =
      revision !== undefined && Number.isFinite(revision) && revision > 0
        ? `?revision=${encodeURIComponent(String(Math.trunc(revision)))}`
        : '';
    const body = await request<ExhibitView>(
      `/sessions/${encodeURIComponent(sessionId)}/exhibits/${encodeURIComponent(exhibitId)}${suffix}`,
      getToken,
    );
    return (await exhibitDecoders()).decodeExhibitView(body);
  },

  /** Every revision of one artefact, ascending — what the revision picker lists. */
  async listExhibitRevisions(
    sessionId: string,
    exhibitId: string,
    getToken: TokenGetter,
  ): Promise<ExhibitRevision[]> {
    const body = await request<ExhibitRevisionsOut>(
      `/sessions/${encodeURIComponent(sessionId)}/exhibits/${encodeURIComponent(exhibitId)}/revisions`,
      getToken,
    );
    return (await exhibitDecoders()).decodeExhibitRevisions(body).revisions;
  },

  /**
   * What changed between two revisions, in `DesignDiff`'s shape for `RevisionDiff`. Parameter
   * spelling `from`/`to` is pinned by the contract test.
   */
  async getExhibitDiff(
    sessionId: string,
    exhibitId: string,
    from: number,
    to: number,
    getToken: TokenGetter,
  ): Promise<ExhibitDiff> {
    const query = new URLSearchParams({
      from: String(Math.trunc(from)),
      to: String(Math.trunc(to)),
    });
    const body = await request<ExhibitDiff>(
      `/sessions/${encodeURIComponent(sessionId)}/exhibits/${encodeURIComponent(exhibitId)}/diff?${query.toString()}`,
      getToken,
    );
    return (await exhibitDecoders()).decodeExhibitDiff(body);
  },

  /**
   * Write a chemist's revision of an artefact against `parentRevision` (never defaulted to the
   * head). A 409 raises `StaleRevisionError` carrying the head. `title` is sent only when it
   * changes.
   */
  async postExhibitRevision(
    sessionId: string,
    exhibitId: string,
    edit: { parentRevision: number; spec: RawExhibitSpec; changeNote: string; title?: string },
    getToken: TokenGetter,
  ): Promise<ExhibitView> {
    // The URL written out whole at the call, because the contract check reads the route off the
    // literal — a path held in a variable is a request it cannot see.
    const body = await request<ExhibitView>(
      `/sessions/${encodeURIComponent(sessionId)}/exhibits/${encodeURIComponent(exhibitId)}/revisions`,
      getToken,
      {
        method: 'POST',
        // `title: undefined` is dropped by `JSON.stringify`, which is exactly "keep the title".
        body: JSON.stringify({
          parent_revision: edit.parentRevision,
          spec: edit.spec,
          change_note: edit.changeNote,
          title: edit.title,
        }),
      },
    );
    return (await exhibitDecoders()).decodeExhibitView(body);
  },

  /**
   * Create a chemist's own artefact — today a pinned tool result (`kind: "result"`), which the
   * service checks the session holds. A 409 `exhibit_limit` has its own error kind.
   */
  async createExhibit(
    sessionId: string,
    exhibit: { kind: string; title: string; spec: ExhibitSpec },
    getToken: TokenGetter,
  ): Promise<ExhibitView> {
    const body = await request<ExhibitView>(
      `/sessions/${encodeURIComponent(sessionId)}/exhibits`,
      getToken,
      {
        method: 'POST',
        body: JSON.stringify({ kind: exhibit.kind, title: exhibit.title, spec: exhibit.spec }),
      },
    );
    return (await exhibitDecoders()).decodeExhibitView(body);
  },

  /** Every artefact of the caller's across sessions; 404 folds to `[]`. */
  listMyExhibits(getToken: TokenGetter, limit = 50): Promise<ExhibitHeader[]> {
    const query = new URLSearchParams({ limit: String(Math.trunc(limit)) });
    return orEmpty('/exhibits', async () => {
      const body = await request<ExhibitIndexOut>(`/exhibits?${query.toString()}`, getToken);
      return (await exhibitDecoders()).decodeMyExhibits(body).exhibits;
    });
  },

  /**
   * Download one artefact in a service-rendered format. Fetched, not linked, because the BFF
   * forwards a bearer header, not a cookie. The filename comes from `Content-Disposition`.
   */
  async exportExhibit(
    sessionId: string,
    exhibitId: string,
    format: ExportFormat,
    getToken: TokenGetter,
    revision?: number,
  ): Promise<{ blob: Blob; filename: string }> {
    const suffix =
      revision !== undefined && Number.isFinite(revision) && revision > 0
        ? `?revision=${encodeURIComponent(String(Math.trunc(revision)))}`
        : '';
    // Written out whole at the one `send`, for the contract check (see `postExhibitRevision`).
    const fetchFile = (): Promise<Response> =>
      send(
        `/sessions/${encodeURIComponent(sessionId)}/exhibits/${encodeURIComponent(exhibitId)}/export.${encodeURIComponent(format)}${suffix}`,
        getToken,
        { headers: { accept: '*/*' } },
      );
    let res = await fetchFile();
    if (res.status === 401 && (await recoverFrom(getToken))) res = await fetchFile();
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
      blob: await res.blob(),
      filename: filenameFrom(res.headers.get('content-disposition'), `${exhibitId}.${format}`),
    };
  },

  /**
   * One calculation by-product's bytes — `GET /calc-artifacts/content?ref=<calc_key>#<name>`. Not
   * session-scoped (the calc cache is shared). The ref is one query parameter encoded whole; the
   * BFF validates it against `CALC_ARTIFACT_REF`. Fetched, not linked, for the bearer header. A 404
   * means evicted and a 413 means over the deployment's download cap.
   */
  async getCalcArtifact(
    ref: string,
    getToken: TokenGetter,
  ): Promise<{ blob: Blob; filename: string; mediaType: string }> {
    // A ref the BFF would refuse is never asked about: its 404 would otherwise read as the calc
    // store having reclaimed a file that was never a file at all.
    if (!CALC_ARTIFACT_REF.test(ref)) throw errorFromStatus(404, NOT_A_CALC_REF);
    // Written out whole at the one `send`, for the contract check (see `postExhibitRevision`).
    const fetchFile = (): Promise<Response> =>
      send(`/calc-artifacts/content?ref=${encodeURIComponent(ref)}`, getToken, {
        headers: { accept: '*/*' },
      });
    let res = await fetchFile();
    if (res.status === 401 && (await recoverFrom(getToken))) res = await fetchFile();
    if (!res.ok) {
      const failure = await readFailure(res);
      // The BFF's own refusal is a bare `{"detail": "not found"}` (`server/app.ts`); only the
      // service's 404 means the file was evicted.
      const sentence =
        res.status === 404 && failure.detail === BFF_NOT_FOUND
          ? NOT_A_CALC_REF
          : res.status === 404
            ? 'That calculation file is no longer stored. By-products are reclaimed over time; re-running the calculation stores it again.'
            : res.status === 413
              ? 'That calculation file is larger than this deployment will send to a browser.'
              : failure.detail;
      throw errorFromStatus(
        res.status,
        sentence,
        res.headers.get('retry-after'),
        failure.correlationId,
        failure.code,
      );
    }
    const name = ref.slice(ref.lastIndexOf('#') + 1) || 'artifact';
    return {
      blob: await res.blob(),
      filename: filenameFrom(res.headers.get('content-disposition'), name),
      mediaType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  },
};

/** The BFF's body for a request it refuses to forward (`server/app.ts`), verbatim. */
const BFF_NOT_FOUND = 'not found';

/** What a reference that cannot name a calc file is called — never "no longer stored". */
const NOT_A_CALC_REF =
  'That reference is not a calculation file (expected `<calculation key>#<file name>`), so there is nothing to download.';

/**
 * The filename from `Content-Disposition: attachment`, or the fallback. Prefers
 * `filename*=UTF-8''…` (RFC 6266); path separators are stripped.
 */
export function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  let name: string | undefined;
  if (extended) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
  const safe = name?.replace(/[\\/]/g, '_').trim();
  return safe ? safe : fallback;
}

export { StaleRevisionError };
export type { ExhibitDiff, ExhibitHeader, ExhibitRevision, ExhibitView };
