/**
 * Conversation state shapes.
 *
 * The one structural decision worth calling out: a `Conversation` has its own local `id`,
 * separate from the server's `sessionId`. The backend's session handle is disposable — it can be
 * evicted from a bounded live-session LRU, and a restarted pod without durable storage loses it —
 * so binding the user's visible transcript to it would mean losing history for no reason. The
 * local id owns the transcript; the session id is swapped underneath it when needed.
 */

import type { ApiErrorKind } from '../api/errors.ts';
import type { ErrorCode, JobCompletedEvent, JobFailedEvent, JobSummary } from '../../shared/events.ts';

/**
 * One durable job's ending, as the push-back stream reports it.
 *
 * A union rather than two feeds: they are two outcomes of one thing, they arrive on one stream,
 * they dedupe against the same key, and a chemist watching for their calculation wants one place
 * to look. Discriminate on `type`.
 */
export type JobOutcome = JobCompletedEvent | JobFailedEvent;

export type TurnStatus = 'streaming' | 'done' | 'error' | 'aborted';

export type TraceKind =
  | 'plan'
  | 'tool_call'
  | 'tool_failed'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'question'
  | 'note_proposed'
  | 'approval_request';

/**
 * One entry in the "show your work" panel, in arrival order.
 *
 * The backend's runner emits signals before the text of the update they preceded, so arrival
 * order is already the truthful transcript order — we do not re-sort.
 */
export interface TraceEntry {
  id: string;
  at: number;
  kind: TraceKind;
  plan?: { todos: string[] };
  /**
   * A tool invocation and, once it comes back, what it returned.
   *
   * One entry rather than two, because a call and its result are one step of the agent's work
   * and reading them as separate rows means scanning for the pair. Neither field set means the
   * call is still running — a real state now that a call is announced at issue rather than on
   * return (backend D-159).
   *
   * `failed` exists so that state cannot be claimed falsely. A raised call never gets a
   * `tool_result` (the backend emits `tool_failed` instead, and the two are exhaustive), so
   * without it a failed call would read "running…" for the rest of the conversation. It carries
   * no message: the `tool_failed` row that follows is where the reason belongs, and saying it
   * twice in adjacent rows is not saying it better.
   *
   * `unresolved` is the fourth state, and it exists only on a **rehydrated** transcript. Live, an
   * open row means the call is still running; read back from storage, the turn is long over and
   * "running…" would be a lie — the honest reading of a stored call with no result is that it ran
   * and the outcome was not recorded (a turn that died mid-call, or a pruned result row).
   */
  toolCall?: {
    tool: string;
    arguments: string;
    result?: string;
    failed?: boolean;
    unresolved?: boolean;
  };
  toolFailure?: { tool: string; message: string };
  /**
   * A durable job, at whichever point in its life this row records.
   *
   * `summary` and `reason` are the two endings and are mutually exclusive — a job completes or it
   * fails. Neither set means the row is a `job_started` and the run is still going, which is the
   * state that used to be indistinguishable from a failure, because a failure produced no row at
   * all.
   */
  job?: { jobId: string; kind?: string; summary?: JobSummary; reason?: string };
  question?: { question: string; options: string[] };
  note?: { noteId: string; reference: string };
  approval?: { prompt: string; approvalId: string };
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  at: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  at: number;
  status: TurnStatus;
  /** Accumulated `token.text`. */
  streamedText: string;
  /**
   * Set once, from `answer.text`.
   *
   * `answer.text` is the FULL concatenation of every token, so rendering both fields would
   * duplicate the entire answer. The renderer picks `finalText ?? streamedText`; there is
   * deliberately no code path that concatenates them.
   */
  finalText: string | null;
  confidence: number | null;
  unsupportedClaims: string[];
  reviewRequired: boolean;
  /**
   * Which check produced `confidence`.
   *
   * Separate from `confidence` because the two answer different questions and only one of them is
   * about the answer's quality: `'citation-gate'` means the judge never ran, so a reviewer is
   * looking at a turn nobody scored rather than a turn scored badly.
   */
  verifiedBy: 'judge' | 'citation-gate' | null;
  /**
   * Connectors that were unreachable for this turn, so their tools were absent from it.
   *
   * On the message rather than in `trace`, because it qualifies the whole answer rather than
   * describing one step of it. The model is never told a tool is missing — it reasons from the
   * surface it was given — so without surfacing this, an answer assembled without the ELN reads
   * exactly like one assembled with it.
   */
  degradedConnectors: string[];
  /**
   * The turn is parked waiting for a server admission permit, and has not started running.
   *
   * On the message rather than in `trace` for the same reason `degradedConnectors` is: it is a
   * state of the whole turn, not a step of it. The backend sends `queued` only when a turn
   * genuinely has to wait, so this stays false for a normal turn. It is never cleared — once the
   * first token arrives there is a body to render and the waiting notice is not reached, which
   * is also the truthful record: this turn *was* queued.
   */
  queued: boolean;
  trace: TraceEntry[];
  /** Newest `plan` snapshot, for the header checklist. Full history stays in `trace`. */
  latestPlan: string[] | null;
  error: TurnError | null;
}

/**
 * How a turn failed.
 *
 * `kind` is this client's transport-level classification and is always present, because a turn can
 * fail without ever reaching the agent. The three optional fields come from the service's own
 * `error` event and are therefore absent for a failure that never got that far — a dropped socket
 * has no correlation id, and pretending otherwise would send an operator looking for a turn that
 * was never recorded.
 */
export interface TurnError {
  kind: ApiErrorKind;
  message: string;
  /** The service's closed taxonomy: what the *user* should do next, not where the traceback came
   *  from. Absent when the failure never reached the service. */
  code?: ErrorCode;
  /** Whether asking again unchanged could plausibly succeed. */
  retryable?: boolean;
  /** The id the audit trail is keyed on — what an operator needs to find this turn. */
  correlationId?: string;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Conversation {
  /** Local, stable across session rotation. */
  id: string;
  /** The server handle. Null before the first turn; replaced on a 404. */
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /**
   * True once the server session was replaced mid-conversation, meaning the agent no longer
   * remembers the turns above. Surfaced in the UI rather than hidden: a chemist reasoning from
   * a premise the agent has forgotten is a real hazard.
   */
  contextLost: boolean;
}

export type ComposerLock = false | 'turn_in_flight' | 'budget_exhausted';

export interface Banner {
  kind: 'error' | 'warn' | 'info';
  text: string;
  action?: 'reauth' | 'reset' | 'retry';
}
