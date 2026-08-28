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
}

/** One tool call as the transcript records it. `arguments` and `result` are truncated server-side
 *  (400 chars) exactly as their streamed counterparts are, and are raw strings either way. */
export interface TranscriptToolCall {
  tool: string;
  arguments: string;
  result: string | null;
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
};
