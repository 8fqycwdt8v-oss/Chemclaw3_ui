/**
 * Conversation state shapes. A `Conversation` has its own local `id`, separate from the server's
 * disposable `sessionId` (evictable, lost on a restart without durable storage); the local id owns
 * the transcript and the session id is swapped underneath when needed.
 */

import type { ApiErrorKind } from '../api/errors.ts';
import type { AnswerCheck, JobSummary, RefusalReason } from '../../shared/events.ts';

export type TurnStatus = 'streaming' | 'done' | 'error' | 'aborted';

export type TraceKind =
  | 'plan'
  | 'tool_call'
  | 'tool_failed'
  | 'evidence_source'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'question'
  | 'note_proposed'
  | 'approval_request'
  | 'handoff'
  | 'exhibit';

/**
 * One entry in the "show your work" panel, in arrival order (already the true order; never
 * re-sorted).
 */
export interface TraceEntry {
  id: string;
  at: number;
  kind: TraceKind;
  plan?: { todos: string[] };
  /**
   * A tool call and, once it returns, what it returned — one row per step. Neither field set means
   * still running (calls are announced at issue). `failed` marks a raised call (it never gets a
   * `tool_result`); the following `tool_failed` row carries the reason.
   */
  toolCall?: {
    tool: string;
    arguments: string;
    /** The specialist that made the call; absent or empty is the main agent. */
    agent?: string;
    result?: string;
    failed?: boolean;
    /**
     * The call ran and how it ended was not recorded — only in a rehydrated transcript (`result:
     * null` from the service: the turn died mid-call or the result was pruned). Neither `failed`
     * nor "running".
     */
    unresolved?: boolean;
    /**
     * Where a queued call is (from `tool_queued`): waiting for a slot or picked up. Absent for
     * unqueued calls.
     */
    queue?: { state: 'queued' | 'running'; waiting: number | null; jobId: string };
    /**
     * When the ending arrived, by our clock; with `at` it gives the call's duration. Absent on
     * reloaded transcripts (shown as a dash).
     */
    endedAt?: number;
    /**
     * Content address of the untruncated result, fetched only when a reader asks. Absent or empty:
     * nothing to offer.
     */
    resultRef?: string;
    /**
     * The model was shown a cut of this result; `resultRef` opens the full text. Stored only when
     * true.
     */
    resultCut?: boolean;
    /**
     * The numbers the result carried, untruncated. `src/chem/provenance.ts` checks the answer's
     * figures against them; `TracePanel` shows them. Absent while running; empty (no numbers)
     * switches the check off.
     */
    numbers?: number[];
    /** The same figures under the tool's own keys, for display; empty for non-JSON results. */
    values?: { label: string; value: number; unit: string }[];
    /**
     * The whole result when small enough to send inline. An optimisation only; `resultRef` remains
     * the presence check.
     */
    resultInline?: string;
  };
  toolFailure?: {
    tool: string;
    message: string;
    /** The specialist that made the call; absent or empty is the main agent — as on `toolCall`. */
    agent?: string;
    /**
     * Which gate refused this call, or absent/null for an ordinary failure. `lib/refusals.ts` owns
     * how each is shown.
     */
    reason?: RefusalReason | null;
  };
  /**
   * One retrieval source's report; `failed` distinguishes a source that raised from one that found
   * nothing.
   */
  evidenceSource?: { source: string; chunks: number; failed: boolean };
  /**
   * Every source in one sweep, in report order, folded into one row (readable as one line, and
   * saves the `MAX_TRACE_ENTRIES` budget). `evidenceSource` keeps the first source for older
   * persisted traces.
   */
  evidenceSweep?: { source: string; chunks: number; failed: boolean }[];
  /** When the last source of the sweep reported, by our clock — so the row can say how long the
   *  whole sweep took. Absent for a sweep of one, which took no measurable time of its own. */
  evidenceSweepEndedAt?: number;
  /**
   * A durable job. `settled` marks a launch row whose job has ended (either way). `planStep` is the
   * plan item it served, when the service sent one.
   */
  job?: {
    jobId: string;
    kind?: string;
    summary?: JobSummary;
    settled?: boolean;
    planStep?: string;
    /** When the ending reached us, for the same reason `toolCall.endedAt` exists. */
    endedAt?: number;
  };
  /** `reason` may legitimately be empty; the service does not always have one. */
  jobFailure?: { jobId: string; reason: string };
  question?: { question: string; options: string[] };
  note?: { noteId: string; reference: string };
  approval?: { prompt: string };
  /**
   * The conversation moved between peer agents. A peer handoff has no hand-back, so one row names
   * both agents.
   */
  handoff?: { from: string; to: string; reason: string };
  /**
   * An artefact this turn created or revised (the `exhibit` header; the body is fetched). `kind`
   * and `title` are empty on rows rebuilt from a reloaded transcript; the card reads them from the
   * artefact list.
   */
  exhibit?: {
    exhibitId: string;
    revision: number;
    kind: string;
    title: string;
    op: 'created' | 'revised';
    authorKind: 'agent' | 'human';
    author: string;
  };
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  at: number;
  /**
   * Who sent it, from the stored transcript (`author.actor`). Absent on a message this browser sent
   * and on rows stored without an author.
   */
  author?: string;
  /**
   * The turn that stored this message, so a re-read transcript merges by identity
   * (`mergeTranscript`). Absent on questions sent live and on older rows.
   */
  correlationId?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  at: number;
  status: TurnStatus;
  /** Accumulated `token.text`. */
  streamedText: string;
  /**
   * Set once from `answer.text`, the full concatenation of every token. Render `finalText ??
   * streamedText`, never both.
   */
  finalText: string | null;
  confidence: number | null;
  unsupportedClaims: string[];
  reviewRequired: boolean;
  /**
   * Which verifier produced `confidence` (deterministic citation gate vs LLM judge), or null; the
   * scores are not comparable.
   */
  verifiedBy: 'judge' | 'citation-gate' | null;
  /**
   * Which answer checks ran; empty means none did — render as unverified, never clean. Optional:
   * absent on older persisted messages, read the same as empty.
   */
  checksRun?: AnswerCheck[];
  /**
   * Whether a second pass challenged this answer, and the hold it opened. At their defaults
   * upstream today; kept so a revival is not dropped.
   */
  challenged?: boolean;
  reviewHoldId?: string | null;
  /**
   * Connectors unreachable for this turn, so their tools were absent. On the message because it
   * qualifies the whole answer.
   */
  degradedConnectors: string[];
  /**
   * This turn was cut off by a page reload, set by `partialize`. The turn itself usually ran on and
   * wrote its answer, so this flag tells the next boot to recover it (`resumeInterruptedTurn`).
   */
  interruptedByReload?: boolean;
  /**
   * The turn waited for a server admission permit. Never cleared: it is the record that the turn
   * was queued.
   */
  queued: boolean;
  /**
   * This message is waiting in a shared conversation's line: `ticket` withdraws it, `position` is
   * how many are ahead (`0` = next). Cleared by the first other event (the turn started).
   */
  queuePlace?: { ticket: number; position: number } | null;
  /**
   * Why this message never ran: withdrawn from the line before its turn. Distinct from `error` and
   * from `aborted`.
   */
  withdrawn?: string;
  /**
   * The turn hit a guard and stopped with work open, so the answer is partial; the service's
   * sentence. Unlike `error`, the answer is still shown.
   */
  partialReason: string | null;
  trace: TraceEntry[];
  /** Newest `plan` snapshot, for the header checklist. Full history stays in `trace`. */
  latestPlan: string[] | null;
  /**
   * The identity of `latestPlan` as its event stated it, binding an approval to what was rendered.
   * Empty (older service) means fetch it; null means no plan seen.
   */
  latestPlanHash: string | null;
  /**
   * The state-changing tools `latestPlan` declares, which the approval card must display. Null when
   * not sent: the card fetches rather than showing "authorizes nothing".
   */
  latestPlanScope: string[] | null;
  /**
   * Whose turn wrote `latestPlan` — the only person who may decide it. Absent when not read (this
   * person's own turn); `null` when unrecorded (the owner decides).
   */
  latestPlanAuthor?: string | null;
  /**
   * When the turn stopped, however it stopped, by our clock (the wait the reader had). Absent on
   * older messages; the summary then omits the time.
   */
  endedAt?: number | null;
  /**
   * The service's id for the turn, read from the response header or a frame, and shown in the trace
   * panel's footer to join with service logs. Absent or empty means no reference.
   */
  correlationId?: string;
  /**
   * No frame for `TURN_STALL_MS` and the turn has not ended. Not an error; cleared when a frame
   * arrives.
   */
  stalled?: boolean;
  /**
   * Somebody else's turn in a shared conversation, followed live. No Stop, Withdraw or recovery,
   * and never persisted; replaced by the stored exchange after the turn ends (`mergeTranscript`).
   */
  watched?: boolean;
  error: { kind: ApiErrorKind; message: string } | null;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Conversation {
  /** Local, stable across session rotation. */
  id: string;
  /** The server handle. Null before the first turn; replaced on a 404. */
  sessionId: string | null;
  /**
   * Where `sessionId` came from: `'server'` (listed or opened by link, so there is a transcript to
   * read) or `'local'` (minted here, nothing to read back). Stays true as the session rotates.
   */
  sessionOrigin: 'local' | 'server';
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /**
   * The server session was replaced mid-conversation, so the agent no longer remembers the turns
   * above. Shown to the user.
   */
  contextLost: boolean;
  /**
   * Present when this conversation is somebody else's and this person is a member (owner's actor
   * id, or `null`). Members read and send; deleting, branching and stopping others' turns stay the
   * owner's, so those controls are hidden.
   */
  membership?: { owner: string | null };
}

export type ComposerLock = false | 'turn_in_flight' | 'budget_exhausted';

export interface Banner {
  kind: 'error' | 'warn' | 'info';
  text: string;
  action?: 'reauth' | 'reset' | 'retry';
  /**
   * Seconds the service asked to wait (`Retry-After`), counted down in the banner so a pause is not
   * mistaken for a spent budget.
   */
  retryAfterSeconds?: number;
}
