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
  | 'evidence_source'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'question'
  | 'note_proposed'
  | 'approval_request'
  | 'handoff';

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
   * The turn entered a specialist, or came back out of one.
   *
   * `to` empty is the hand back, and it is a declared value rather than a missing field — the
   * pair brackets the specialist's work, so rendering only the entry would leave a trace showing
   * a turn permanently inside a specialist it already left.
   */
  handoff?: { to: string; reason: string };
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
    /** The specialist that made the call; absent or empty is the main agent. */
    agent?: string;
    result?: string;
    failed?: boolean;
    /**
     * The call ran and how it ended was not recorded. Only a *rehydrated* transcript reaches this.
     *
     * The stored transcript pairs calls with results by `call_id` and returns `result: null` when
     * the pairing is incomplete — which the service's own `TranscriptToolCall` docstring says
     * happens for a turn that died mid-call **or a result row that was pruned**, and asks a surface
     * to render as "this ran and we do not know how it ended".
     *
     * That is why it is not `failed`. `failed` names an outcome — the tool raised — and retention
     * deleting a result row is not that outcome. It is not the empty state either: with neither
     * field set the row reads "running…", which is false inside a transcript that finished days
     * ago. Three existing states, none of them true, so there is a fourth.
     */
    unresolved?: boolean;
    /**
     * When the ending arrived, by our clock.
     *
     * Paired with the entry's own `at` this is the duration of the call — the one number that
     * turns a list of tool names into a reading of where a turn's time went. Our clock and not
     * the service's, because nothing on the wire carries one; a reloaded transcript therefore has
     * no duration at all, which the rail renders as a dash rather than as zero.
     */
    endedAt?: number;
    /**
     * Content address of the untruncated result, when the service stored one.
     *
     * Carried on the trace rather than fetched eagerly: the point of the backend's split is that
     * one result is pulled when a reader asks for it, not that every result of every turn is
     * pulled because it exists. Absent or empty means there is nothing to offer.
     */
    resultRef?: string;
    /**
     * The numeric values the result carried, untruncated.
     *
     * The one piece of structured chemistry the stream carries, and it is on the trace row rather
     * than derived from the preview beside it because the preview is cut at an arbitrary byte and
     * this is not. `src/chem/provenance.ts` checks the answer's figures against it; `TracePanel`
     * shows the list, so a reader who distrusts a mark can see the evidence rather than take it
     * on faith. Absent for a call still running and empty for one that returned no numbers, which
     * are different facts and the second of which switches the check off.
     */
    numbers?: number[];
    /**
     * The same figures, each under the key the tool filed it under.
     *
     * Beside `numbers` rather than replacing it, because the two answer different questions: the
     * bare list is what `provenance.ts` checks the answer's written figures against, where a name
     * is noise, and this is what a surface *prints*, where a number with no name is not a
     * measurement. Empty for a result that was not JSON — the service refuses to guess a label out
     * of prose, and so does everything downstream of it.
     */
    values?: { label: string; value: number; unit: string }[];
    /**
     * The whole result, when it was small enough for the service to send with the event.
     *
     * An optimisation and never a presence check: `resultRef` is still what says a result was
     * stored, and a result over the service's inline cap arrives with this empty and is fetched
     * exactly as before. What it buys is the common case — an ICH limit, a pKa — rendering with
     * the turn instead of paying a round trip for a payload smaller than the preview beside it.
     */
    resultInline?: string;
  };
  toolFailure?: {
    tool: string;
    message: string;
    /**
     * `'plan_gate'` when the pre-execution approval refused a state-changing call.
     *
     * A refusal is the control working, and rendering it in the same red as a database outage
     * reports a correctly-gated turn as a broken one. Absent for an ordinary failure.
     */
    reason?: 'plan_gate' | null;
  };
  /**
   * One retrieval source's own report of what it contributed to a sweep.
   *
   * Carried because `failed` is the only thing that distinguishes a source that raised from one
   * that was asked and had nothing — the merged evidence list collapses the two, which is a defect
   * the backend has already paid for once.
   */
  evidenceSource?: { source: string; chunks: number; failed: boolean };
  /**
   * A durable job.
   *
   * `settled` is the `job_started` row's version of `toolCall.failed`, and exists for the same
   * reason: a launch row that never learns its job ended goes on saying "runs asynchronously"
   * for the life of the conversation. Both endings set it — the row that follows says which one.
   *
   * `planStep` is the checklist item the launch served (the todo's bare text, backend
   * D-2026-08-27), set only on `job_started` rows and only when the service sent one — it is what
   * lets the plan card badge the step a running job belongs to. Absent means the job was not
   * launched from a plan step.
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
  /**
   * The turn hit a guard and stopped with work still open, so the answer below is partial.
   *
   * Carries the service's own sentence, which names the limit that fired and the session. On the
   * message rather than in `error`, and that distinction is the whole point: `error` means the turn
   * failed and there is nothing to read, while this arrives BEFORE the answer it qualifies and the
   * answer is still worth showing.
   *
   * Null for every turn that ran to its own conclusion, which is nearly all of them.
   */
  partialReason: string | null;
  trace: TraceEntry[];
  /** Newest `plan` snapshot, for the header checklist. Full history stays in `trace`. */
  latestPlan: string[] | null;
  /**
   * The identity of `latestPlan`, as the event that carried it stated.
   *
   * What binds an approval to the plan a human actually read. Without it the approval card had to
   * `GET /sessions/{id}/plan` for a hash — a round trip that races the revision the hash exists to
   * catch, and which showed whatever the service was proposing at fetch time rather than what this
   * message rendered.
   *
   * Empty string for a service that predates the field, which the card must read as "fetch it",
   * never as a hash that will match. Null when no plan has been seen at all.
   */
  latestPlanHash: string | null;
  /**
   * When the turn stopped, however it stopped — answered, aborted or failed.
   *
   * What makes the summary line able to say how long the turn took. Deliberately *our* clock and
   * not the service's: nothing on the wire carries a turn duration, so this is the wait the reader
   * actually had, which is the number they would have counted themselves.
   *
   * Optional rather than required, and absent on every message written before it existed — a
   * persisted transcript is read back by this same type, and a required field would make every
   * stored turn structurally invalid for the sake of a duration nobody recorded. Absent means
   * "not known", and the summary simply omits the time.
   */
  endedAt?: number | null;
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
