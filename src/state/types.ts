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
     * Content address of the untruncated result, when the service stored one.
     *
     * Carried on the trace rather than fetched eagerly: the point of the backend's split is that
     * one result is pulled when a reader asks for it, not that every result of every turn is
     * pulled because it exists. Absent or empty means there is nothing to offer.
     */
    resultRef?: string;
  };
  toolFailure?: { tool: string; message: string };
  /**
   * A durable job.
   *
   * `settled` is the `job_started` row's version of `toolCall.failed`, and exists for the same
   * reason: a launch row that never learns its job ended goes on saying "runs asynchronously"
   * for the life of the conversation. Both endings set it — the row that follows says which one.
   */
  job?: { jobId: string; kind?: string; summary?: JobSummary; settled?: boolean };
  /** `reason` may legitimately be empty; the service does not always have one. */
  jobFailure?: { jobId: string; reason: string };
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
   * Which verifier produced `confidence`, or null when none ran.
   *
   * Kept beside the score rather than folded into it, because the two backends measure different
   * things: the citation gate is deterministic and scores against the turn's own tool results,
   * the judge is a model scoring against the claims. Showing one number for both invites the
   * reader to compare scores that are not comparable.
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
  error: { kind: ApiErrorKind; message: string } | null;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Conversation {
  /** Local, stable across session rotation. */
  id: string;
  /** The server handle. Null before the first turn; replaced on a 404. */
  sessionId: string | null;
  /**
   * Where `sessionId` came from.
   *
   * `'server'` means the session was listed by `GET /sessions` or opened from a shared link, so
   * there is a transcript on the backend worth reading. `'local'` means this browser minted it —
   * on the first send, or ahead of it by `warmSession` — so there is nothing to read back and
   * asking would be a wasted round-trip that raises a banner if it fails.
   *
   * It describes where the id came from, not what state the conversation is in, so it stays true
   * as the session is rotated underneath.
   */
  sessionOrigin: 'local' | 'server';
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
