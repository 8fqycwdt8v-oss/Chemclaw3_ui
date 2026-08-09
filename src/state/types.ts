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
import type { JobSummary } from '../../shared/events.ts';
import type { ChemclawErrorCode } from '../../shared/events.ts';

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
   */
  toolCall?: {
    tool: string;
    arguments: string;
    result?: string;
    failed?: boolean;
    /**
     * The untruncated halves of the result, which `preview` is not.
     *
     * The backend split these out because scoring a grounding claim against the first 200
     * characters of a forty-chunk sweep graded real citations as fabrications. `preview` is prose
     * for a human; these are the values a reader can actually check an answer against.
     */
    noteIds?: string[];
    numbers?: number[];
  };
  toolFailure?: { tool: string; message: string };
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
   * Which check produced `confidence`. `'citation-gate'` means the LLM judge did not run and the
   * weaker deterministic check scored this answer — a materially different claim from a genuinely
   * low score, and one `reviewRequired` alone cannot express.
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
  /**
   * A non-terminal `error` event: the turn produced an answer, but a guard qualified it.
   *
   * Separate from `error` below, which means the turn *failed*. `loop_cap_reached` and
   * `empty_answer` arrive before the `answer` they describe, so the message has both a body and a
   * reason the body is not the whole story. Rendering them as the same thing would either hide the
   * answer or hide the caveat.
   *
   * Singular and last-wins: a turn emits at most one.
   */
  notice: {
    code: ChemclawErrorCode;
    message: string;
    retryable: boolean;
    correlationId: string;
  } | null;
  error: {
    kind: ApiErrorKind;
    message: string;
    /** The backend's code and audit id, when the failure came from the stream. */
    code?: ChemclawErrorCode;
    correlationId?: string;
  } | null;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Conversation {
  /** Local, stable across session rotation. */
  id: string;
  /** The server handle. Null before the first turn; replaced on a 404. */
  sessionId: string | null;
  /**
   * The agent profile this conversation talks to, chosen when it is created.
   *
   * Persisted with the conversation rather than read back from the server, because it has to
   * survive a session being replaced: the backend fixes a profile for a session's lifetime, so a
   * recreated session must be given the same one or the conversation changes agent halfway
   * through its own transcript.
   */
  profile: string | null;
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
