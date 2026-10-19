/**
 * Projecting a stored transcript onto the store's message shape (fetching lives in `App.tsx`). The
 * service stores role, text and each message's tool calls with results; turn-time fields
 * (confidence, verifier, plan snapshots, attachments) are not stored, so each is set to its
 * "unknown" value explicitly.
 */

import type { TranscriptMessage, TranscriptToolCall, TranscriptTurnStatus } from '../api/client.ts';
import { TURN_INTERRUPTED_TEXT } from '../api/errors.ts';
import type { AssistantMessage, ChatMessage, TraceEntry } from './types.ts';
import { EXHIBIT_ID_RE } from '../../shared/exhibitConstants.ts';

/**
 * One stored message's tool calls as trace rows. Every call is closed; `result: null` (turn died
 * mid-call, or the result row was pruned) becomes `unresolved`, not `failed`.
 */
function traceFrom(calls: TranscriptToolCall[], key: string, at: number): TraceEntry[] {
  return calls.map((call, i) => ({
    id: `${key}t${i}`,
    at,
    kind: 'tool_call' as const,
    toolCall: {
      tool: call.tool,
      arguments: call.arguments,
      // The content address of the full result, when the service still holds it, so result blocks
      // work after a reload.
      ...(call.result_ref ? { resultRef: call.result_ref } : {}),
      // Same fact as `tool_result.result_cut` live: `result` is the model's cut text.
      ...(call.result_cut === true ? { resultCut: true } : {}),
      ...(call.result == null ? { unresolved: true } : { result: call.result }),
    },
  }));
}

/** The agent tools whose result names an artefact, and what each did to it. */
const EXHIBIT_TOOLS: Readonly<Record<string, 'created' | 'revised'>> = {
  create_exhibit: 'created',
  revise_exhibit: 'revised',
};

/**
 * Recover a reloaded answer's artefact cards from its `create_exhibit`/`revise_exhibit` calls (the
 * `exhibit` frame is not stored). Only id and revision; kind and title are read from the artefact
 * list, not guessed from the arguments.
 */
function exhibitsFrom(calls: TranscriptToolCall[], key: string, at: number): TraceEntry[] {
  return calls.flatMap((call, i): TraceEntry[] => {
    const op = EXHIBIT_TOOLS[call.tool];
    if (!op || !call.result) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.result);
    } catch {
      return [];
    }
    const { exhibit_id: id, revision } = (parsed ?? {}) as {
      exhibit_id?: unknown;
      revision?: unknown;
    };
    if (typeof id !== 'string' || !EXHIBIT_ID_RE.test(id)) return [];
    return [
      {
        id: `${key}x${i}`,
        at,
        kind: 'exhibit',
        exhibit: {
          exhibitId: id,
          revision: typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : 0,
          kind: '',
          title: '',
          op,
          authorKind: 'agent',
          author: '',
        },
      },
    ];
  });
}

/** What a turn that ended without an answer, and not by being stopped, says it did. */
export const TURN_FAILED_TEXT = 'This turn ended without an answer.';

/** The endings a stored question can carry that leave no answer behind it. */
export type UnansweredEnding = Extract<TranscriptTurnStatus, 'failed' | 'stopped' | 'interrupted'>;

/**
 * How a stored question's turn ended without an answer (`failed`, `stopped`, `interrupted`), or
 * `null`.
 */
export function unansweredEnding(
  status: TranscriptMessage['turn_status'],
): UnansweredEnding | null {
  return status && status !== 'running' && status !== 'done' ? status : null;
}

/**
 * The ending of turn `correlationId` from its stored question, or `null`; detach recovery stops
 * polling on it.
 */
export function endingOfTurn(
  transcript: readonly TranscriptMessage[],
  correlationId: string,
): UnansweredEnding | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i];
    if (entry?.role === 'user' && entry.correlation_id === correlationId) {
      return unansweredEnding(entry.turn_status);
    }
  }
  return null;
}

/**
 * The error an unanswered turn carries — `null` for a stopped one. Shared by the transcript and
 * `sendMessage`.
 */
export function endedError(ending: UnansweredEnding): AssistantMessage['error'] {
  return ending === 'stopped'
    ? null
    : ending === 'interrupted'
      ? { kind: 'turn_interrupted', message: TURN_INTERRUPTED_TEXT }
      : { kind: 'agent', message: TURN_FAILED_TEXT };
}

/**
 * The answer a stored question never got, as the bubble that says so (the same states a live turn
 * ends in), so a lone question does not read as still running.
 */
function unanswered(
  id: string,
  at: number,
  ending: UnansweredEnding,
  correlationId: string | undefined,
): AssistantMessage {
  return {
    ...answerOf(id, at, correlationId, '', []),
    status: ending === 'stopped' ? 'aborted' : 'error',
    error: endedError(ending),
  };
}

/** A settled answer read back from the service — see the module docstring for each "unknown". */
function answerOf(
  id: string,
  at: number,
  correlationId: string | undefined,
  finalText: string,
  trace: TraceEntry[],
): AssistantMessage {
  return {
    id,
    role: 'assistant',
    at,
    // The turn's id, which is what `mergeTranscript` joins a re-read on — and what the trace
    // footer quotes on a turn this browser did not send.
    ...(correlationId ? { correlationId } : {}),
    status: 'done',
    streamedText: '',
    finalText,
    // Never persisted — see the module docstring. Null and empty are the honest readings.
    confidence: null,
    unsupportedClaims: [],
    reviewRequired: false,
    // The transcript records the answer, not which verifier scored it.
    verifiedBy: null,
    // The backend stores the messages, not which connectors happened to be down at the time.
    degradedConnectors: [],
    partialReason: null,
    // A rehydrated message is finished, so it is not waiting on anything.
    queued: false,
    trace,
    latestPlan: null,
    latestPlanHash: null,
    latestPlanScope: null,
    error: null,
  };
}

export function transcriptToMessages(remote: TranscriptMessage[]): ChatMessage[] {
  // Not a real timestamp (the transcript has none); nothing reads `at` on a settled message.
  const at = Date.now();

  const messages: ChatMessage[] = [];
  for (const m of remote) {
    // Only user and assistant turns; a stored `system` message would otherwise render as an answer.
    if (m.role !== 'user' && m.role !== 'assistant') continue;

    const text = m.text?.trim() ? m.text : '';
    const calls = m.tool_calls ?? [];
    // A message with no text but with calls is still worth showing — that is a turn whose work is
    // the whole record of it. Only a message empty in both senses is dropped.
    if (!text && calls.length === 0) continue;

    // Keys by position among surviving messages.
    const key = `h${messages.length}`;
    const correlationId = m.correlation_id?.trim() || undefined;

    if (m.role === 'user') {
      // A user message is its text; there is nothing else it could be showing.
      if (!text) continue;
      // Who sent it, when the service recorded a person: in a shared conversation that is whose
      // question this is — and, since every message runs as its sender, whose roles answered it.
      const author = m.author?.actor?.trim();
      messages.push({
        id: key,
        role: 'user',
        text,
        at,
        ...(author ? { author } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      const ending = unansweredEnding(m.turn_status);
      if (ending) messages.push(unanswered(`h${messages.length}`, at, ending, correlationId));
      continue;
    }

    messages.push(
      answerOf(key, at, correlationId, text, [
        ...traceFrom(calls, key, at),
        ...exhibitsFrom(calls, key, at),
      ]),
    );
  }

  return messages;
}

/**
 * One exchange: a question and what answered it, or a lone answer. `key` is the turn's
 * `correlationId` when known.
 */
interface Turn {
  messages: ChatMessage[];
  key: string | null;
  question: string | null;
  /** A watched placeholder (`AssistantMessage.watched`) — its own turn, never matched. */
  watched: boolean;
}

function turnsOf(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    const watched = m.role === 'assistant' && m.watched === true;
    // A question opens a turn, and so does a watched answer: it is somebody else's exchange, and
    // folding it into the question above it would hand that question an answer it never had.
    if (m.role === 'user' || watched || !current || current.watched) {
      current = {
        messages: [],
        key: null,
        question: m.role === 'user' ? m.text.trim() : null,
        watched,
      };
      turns.push(current);
    }
    current.messages.push(m);
    current.key ??= m.correlationId || null;
  }
  return turns;
}

/**
 * A stored exchange as one question and one answer: the transcript stores each model step as its
 * own message, so the steps are folded into the last, tool calls kept in order.
 */
function folded(turn: Turn, id: (seed: string) => string): ChatMessage[] {
  const out: ChatMessage[] = [];
  let answer: AssistantMessage | null = null;
  for (const m of turn.messages) {
    if (m.role === 'user') {
      out.push({ ...m, id: id(`${m.correlationId ?? m.id}:q`) });
      continue;
    }
    answer = answer
      ? {
          ...m,
          id: answer.id,
          finalText: m.finalText || answer.finalText,
          trace: [...answer.trace, ...m.trace],
        }
      : { ...m, id: id(`${m.correlationId ?? m.id}:a`) };
  }
  if (answer) out.push(answer);
  return out;
}

/**
 * Merge a re-read transcript into the messages this browser holds, by turn (shared conversations):
 *
 * - A turn both hold stays as this browser has it (it carries what storage does not). Matched by
 *   `correlationId`, then by question text, in order.
 * - A turn only the service holds is inserted in its place, folded to one answer, attributed to its
 *   sender.
 * - A turn only this browser holds stays (streaming, queued, failed or withdrawn).
 * - A settled watched placeholder is dropped once the stored exchange arrives.
 *
 * Returns `null` when nothing changes. New messages never reuse an existing id.
 */
export function mergeTranscript(
  local: readonly ChatMessage[],
  remote: readonly ChatMessage[],
): ChatMessage[] | null {
  const mine = turnsOf(local);
  const theirs = turnsOf(remote).filter((t) => !t.watched);
  const taken = new Set(local.map((m) => m.id));
  const id = (seed: string): string => {
    let candidate = `r:${seed}`;
    for (let n = 1; taken.has(candidate); n += 1) candidate = `r:${seed}:${n}`;
    taken.add(candidate);
    return candidate;
  };

  const used = new Set<number>();
  const matchFor = (turn: Turn, from: number): number => {
    if (turn.key) {
      const byKey = mine.findIndex(
        (t, i) => i >= from && !t.watched && !used.has(i) && t.key === turn.key,
      );
      if (byKey >= 0) return byKey;
    }
    if (turn.question === null) return -1;
    return mine.findIndex(
      (t, i) =>
        i >= from &&
        !t.watched &&
        !used.has(i) &&
        t.question === turn.question &&
        // Two different turns that asked the same words: both ids known and different.
        !(t.key && turn.key && t.key !== turn.key),
    );
  };

  const placed: (Turn | ChatMessage[])[] = [];
  let next = 0;
  let inserted = false;
  for (const turn of theirs) {
    const at = matchFor(turn, next);
    if (at < 0) {
      placed.push(folded(turn, id));
      inserted = true;
      continue;
    }
    for (let i = next; i < at; i += 1) placed.push(mine[i]!);
    // A question held here with nothing after it (read from the service while its turn ran) takes
    // the service's answer.
    const answered = (t: Turn): boolean => t.messages.some((m) => m.role === 'assistant');
    if (!answered(mine[at]!) && answered(turn)) {
      placed.push(folded(turn, id));
      inserted = true;
    } else {
      placed.push(mine[at]!);
    }
    used.add(at);
    next = at + 1;
  }
  for (let i = next; i < mine.length; i += 1) placed.push(mine[i]!);

  let dropped = false;
  const merged: ChatMessage[] = [];
  for (const entry of placed) {
    if (Array.isArray(entry)) {
      merged.push(...entry);
      continue;
    }
    const settled = entry.messages.every((m) => m.role !== 'assistant' || m.status !== 'streaming');
    if (entry.watched && settled && inserted) {
      dropped = true;
      continue;
    }
    merged.push(...entry.messages);
  }
  return inserted || dropped ? merged : null;
}
