/**
 * Non-streaming calls to the Chemclaw service, through the BFF.
 *
 * Endpoints verified against 8fqycwdt8v-oss/Chemclaw3 (`src/chemclaw/api/routes/`).
 *
 * Two policies live here and are worth telling apart, because the difference is not stylistic.
 * The *list* routes — sessions, transcripts, proposals — swallow a 404 into an empty result, so
 * this UI runs against an older service with a smaller sidebar rather than a banner. The *fetch*
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
      cache: 'no-store',
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
 * One knowledge note waiting to enter the graph, as the PR gate records it.
 *
 * The service calls the gate "the line that makes machine-written knowledge safe"; these are the
 * things standing on it. Deciding one commits or refuses bytes in a repository, which is why the
 * decision route is role-gated upstream and why the reviewer is shown the file rather than a
 * summary of it.
 */
export interface ProposalSummary {
  id: number;
  note_id: string;
  note_type: string;
  /** `pending` until decided; then `approved` or `rejected`. */
  state: string;
  branch: string;
  reference: string;
  /** The principal whose turn produced it. */
  actor: string;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string;
  reason: string;
}

/** A file the proposal would land alongside the note — a minted compound note, typically. */
export interface ProposalFile {
  path: string;
  content: string;
}

/**
 * A proposal with the bytes it would commit.
 *
 * `content` and `dependencies` are the point of the detail route: a GxP sign-off is on what would
 * actually enter the tree, not on a summary of it. `correlation_id` joins the decision to the
 * audit trail of the turn that proposed it.
 */
export interface ProposalDetail extends ProposalSummary {
  content: string;
  dependencies: ProposalFile[];
  session_id: string;
  correlation_id: string;
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
  completed_at: string | null;
}

/**
 * One standing query's finding — what a watch turned up since it last reported.
 *
 * Two fields, and no timestamp: the service does not send one, so nothing here may imply when the
 * notes were merged. `note_ids` resolve through the ordinary citation chip.
 */
export interface Digest {
  query: string;
  note_ids: string[];
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
}

/** One job's live status and structured result. */
export interface DurableJobStatus {
  job_id: string;
  status: string;
  summary: string | null;
  result: Record<string, unknown>;
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

/** A note's identity and provenance, without its body. Also what a neighbour is. */
export interface NoteRef {
  id: string;
  type: string;
  compound_smiles: string;
  tags: string[];
  created_by: string;
  source: string;
  confidence: number;
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
}

/**
 * `GET /plans/pending` — undecided plans, with what the service's scan actually covered.
 *
 * The three counts are why this is an object rather than an array, and they are the whole
 * difference between this screen and the one it replaces. `plans: []` has three meanings:
 * `gated === 0` is "this deployment has no plan gate, so nothing can ever be here", `unread > 0`
 * is "the answer is partial", and neither of those is "nothing is waiting on you". The deleted
 * holds inbox rendered all three as the last one — see the note at the top of `ReviewQueue.tsx`.
 */
export interface PendingPlans {
  plans: PendingPlan[];
  /** Sessions of the caller's the service looked at — the same set `GET /sessions` lists. */
  considered: number;
  /** Of those, the ones running a plan-gated profile: the only ones that can hold a decision. */
  gated: number;
  /** Gated sessions whose plan was not read, so the list is short by an unknown amount. */
  unread: number;
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
    xhr.open('POST', `${config.apiBase}/sessions/${sessionId}/attachments`);
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
      const res = await send(`/sessions${query}`, getToken, {});
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
  async stopTurn(sessionId: string, getToken: TokenGetter): Promise<boolean> {
    try {
      await request<{ stopped: boolean }>(`/sessions/${sessionId}/turn/stop`, getToken, {
        method: 'POST',
      });
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
      request<TranscriptMessage[]>(`/sessions/${sessionId}/messages`, getToken),
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
    return request<StoredToolResult>(`/sessions/${sessionId}/tool-results/${ref}`, getToken);
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
    return request<NoteView>(
      `/notes/${encodeURIComponent(noteId)}?hops=${encodeURIComponent(String(hops))}`,
      getToken,
    );
  },

  /**
   * The PR-gate review queue.
   *
   * `state` filters (`pending` is what a reviewer wants) and `before_id` is keyset pagination —
   * an id, not an offset, so a decision landing mid-scroll cannot shift the page under the reader.
   *
   * Degrades to `[]` on a 404 like the other list routes, and for the same reason: a service
   * without the queue should leave an empty screen, not a banner.
   */
  async listProposals(
    getToken: TokenGetter,
    options: { state?: string; beforeId?: number } = {},
  ): Promise<ProposalSummary[]> {
    const query = new URLSearchParams();
    if (options.state) query.set('state', options.state);
    if (options.beforeId) query.set('before_id', String(options.beforeId));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return orEmpty('/proposals', () => request<ProposalSummary[]>(`/proposals${suffix}`, getToken));
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

  /** One proposal with the exact bytes it would commit. Not swallowed: it is opened by a click. */
  getProposal(id: number, getToken: TokenGetter): Promise<ProposalDetail> {
    return request<ProposalDetail>(`/proposals/${id}`, getToken);
  },

  /**
   * Sign a proposal into the record, or refuse it.
   *
   * `reason` is required on a rejection — the service 422s a blank one, and rightly: a note
   * rejected without a stated reason tells the next reviewer, and the agent, nothing. It is
   * optional on an approval, where the bytes are the record.
   */
  decideProposal(
    id: number,
    approved: boolean,
    reason: string,
    getToken: TokenGetter,
  ): Promise<void> {
    return request<void>(`/proposals/${id}/decision`, getToken, {
      method: 'POST',
      body: JSON.stringify({ approved, reason }),
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
    return request<PlanStatus>(`/sessions/${sessionId}/plan`, getToken);
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
      await request<void>(`/sessions/${sessionId}/plan/decision`, getToken, {
        method: 'POST',
        body: JSON.stringify({ approved, plan_hash: planHash }),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        throw new ApiError('plan_changed', err.message, 409);
      }
      throw err;
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
      if (err instanceof ApiError && err.status === 409) {
        throw new ApiError('revision_conflict', err.message, 409);
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
      if (err instanceof ApiError && err.status === 409 && err.kind === 'turn_in_flight') {
        throw new ApiError('revision_conflict', err.message, 409);
      }
      throw err;
    }
  },
};
