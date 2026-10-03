/**
 * Projecting a stored transcript onto the store's message shape.
 *
 * Lifted out of the rehydrate effect in `App.tsx`, which owns fetching, cancellation and the
 * failure banner and has no opinion about any of this. What is left here is only decisions —
 * which stored messages are turns, what an unpaired tool call means, and which fields a reload
 * genuinely knows — and every one of them is now assertable without rendering a component.
 *
 * What the service can give back, and what it cannot. `role`, `text` and the calls each message
 * made, with their results. Not `confidence`, `verified_by`, `review_required`, plan snapshots or
 * attachment references: those are computed at turn time and streamed, and nothing writes them to
 * storage. Each is set to its "we do not know" value below rather than to a plausible default,
 * which is why they are written out one by one instead of spread from a template.
 */

import type { TranscriptMessage, TranscriptToolCall, TranscriptTurnStatus } from '../api/client.ts';
import { TURN_INTERRUPTED_TEXT } from '../api/errors.ts';
import type { AssistantMessage, ChatMessage, TraceEntry } from './types.ts';
import { EXHIBIT_ID_RE } from '../../shared/exhibitConstants.ts';

/**
 * The tool calls of one stored message, as trace rows.
 *
 * Every call in a transcript is closed — the transcript is written after the turn — so none of
 * these can be "still running". The open question is what `result: null` means, and the service
 * answers it in `TranscriptToolCall`'s own docstring: the pairing is incomplete, because the turn
 * died mid-call **or the result row was pruned**, and a surface should render that as "this ran
 * and we do not know how it ended".
 *
 * So it is `unresolved`, not `failed`. `failed` names a specific outcome — the tool raised — and
 * retention deleting a result row months later is not that. In a transcript a chemist may be
 * reading as a record of what was done, the difference between "this tool errored" and "we no
 * longer hold what it returned" is not a nuance to round off.
 */
function traceFrom(calls: TranscriptToolCall[], key: string, at: number): TraceEntry[] {
  return calls.map((call, i) => ({
    id: `${key}t${i}`,
    at,
    kind: 'tool_call' as const,
    toolCall: {
      tool: call.tool,
      arguments: call.arguments,
      // The content address, when the service still holds the full result. Carried because it is
      // what makes `ResultBlock` and `ResultSheet` reachable at all — the live turn gets it from
      // `tool_result.result_ref`, and this is the same fact recovered from storage. Dropping it
      // was the whole of why every full result — a hazard table, a charge table, a solvent
      // ranking — became a 400-character paraphrase the moment the page was reloaded.
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
 * The artefact cards a reloaded answer had, recovered from the calls that made them.
 *
 * The `exhibit` frame is streamed and never stored, so a transcript read back from the service has
 * no event to rebuild a card from — and without this, every answer that produced a report draft
 * lost its card on reload while the pane beside it still listed the draft. What *is* stored is the
 * call: `create_exhibit` and `revise_exhibit` return `{exhibit_id, revision}`, and the transcript
 * keeps the first 400 characters of every result, which is ten times what that needs.
 *
 * Only the id and the revision are recovered. The kind and title are left empty for the card to
 * read off the session's artefact list — a title guessed from the call's arguments would be the
 * agent's *request*, and the service may have refused or renamed it.
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
 * How a stored question's turn ended without an answer, or `null` — still running, answered, or a
 * question from a service that does not say.
 *
 * Only these three, because they are the endings after which the service appends nothing: a
 * question marked one of them is the whole of its turn's record, and the transcript would
 * otherwise show a question nobody answered with no word about why.
 */
export function unansweredEnding(
  status: TranscriptMessage['turn_status'],
): UnansweredEnding | null {
  return status && status !== 'running' && status !== 'done' ? status : null;
}

/**
 * The ending of turn `correlationId`, read off its stored question, or `null` while it has none.
 *
 * What detach recovery stops polling on: a dropped stream used to poll the transcript for up to ten
 * minutes for an answer, and a turn whose process died never writes one. Its question says so
 * instead — `interrupted` once the service has noticed (Chemclaw3
 * `D-2026-10-03-a-turn-is-written-ahead-and-an-interrupted-one-says-so`).
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
 * The answer a stored question never got, as the bubble that says so.
 *
 * The same states a live turn ends in when it learns the same thing (`sendMessage`): `interrupted`
 * is the error whose Retry sends the question again, `failed` an error with nothing to retry into,
 * and `stopped` an aborted turn. Built rather than omitted, because a question with nothing after
 * it reads as a turn still running — or as this app having lost the answer.
 */
/**
 * The error a turn that ended without an answer carries — `null` for a stopped one, which is not
 * a failure. One definition, read by the transcript and by both live paths in `sendMessage`.
 */
export function endedError(ending: UnansweredEnding): AssistantMessage['error'] {
  return ending === 'stopped'
    ? null
    : ending === 'interrupted'
      ? { kind: 'turn_interrupted', message: TURN_INTERRUPTED_TEXT }
      : { kind: 'agent', message: TURN_FAILED_TEXT };
}

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
  // Not a real timestamp, and there is none to be had: the transcript carries no per-message time.
  // Nothing renders it — `ElapsedTimer` is the only reader of `at`, and it only runs on a streaming
  // message, which a rehydrated one never is. Left here so the shape is complete, and written down
  // so the next person reaching for a "sent at" label knows this is not it.
  const at = Date.now();

  const messages: ChatMessage[] = [];
  for (const m of remote) {
    // The transcript is a conversation, not a message log. A `system` message is the agent's own
    // instructions, and the service does not filter them out — it drops only the `tool` carrier
    // rows it has already paired into their calls. Anything that is not a turn would render here
    // as an assistant answer, putting words in the transcript that nobody said.
    if (m.role !== 'user' && m.role !== 'assistant') continue;

    const text = m.text?.trim() ? m.text : '';
    const calls = m.tool_calls ?? [];
    // A message with no text but with calls is still worth showing — that is a turn whose work is
    // the whole record of it. Only a message empty in both senses is dropped.
    if (!text && calls.length === 0) continue;

    // Position among the messages that survive, so the keys are dense and unique. Deliberately not
    // the service's `index`, which counts positions in the stored array including the rows it
    // drops: it would be just as unique, and it would fix nothing.
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
 * One exchange: a question and what answered it, or a lone answer with no question before it.
 *
 * `key` is the turn's id (`correlationId`) when any message in it carries one.
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
 * A stored exchange as one question and **one** answer.
 *
 * The transcript stores each model step as its own message — a tool-calling step, then the reply
 * — and `transcriptToMessages` keeps them apart. A turn arriving in a conversation already on
 * screen is somebody else's exchange, and the reader watched it arrive as one answer: inserting it
 * as several would make one turn read as several, and move every count of answers on the page.
 * So its steps are folded into the last one, their tool calls kept in order.
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
 * Merge a re-read transcript into the messages this browser holds, by turn identity.
 *
 * What a shared conversation needs and an ordinary reload never did (Chemclaw3_ui #130): the
 * transcript has turns somebody else sent that this browser has never seen, interleaved with turns
 * it has. So this is an ordered alignment rather than a replacement:
 *
 *  - **A turn both sides hold stays as this browser has it.** A live turn carries what storage
 *    does not — confidence, the verifier, the plan snapshots, a stream still running — and a
 *    re-read must never trade that for the stored copy. Turns are matched by `correlationId` first
 *    and by the question's text second (a row stored before the column, or a turn whose id never
 *    reached this browser), in order, so a question asked twice matches twice.
 *  - **A turn only the service holds is inserted where the service has it**, folded to one
 *    answer (`folded`) and attributed to its sender.
 *  - **A turn only this browser holds stays where it is** — a turn still streaming, a message
 *    waiting in line, one that failed or was withdrawn and so was never stored.
 *  - **A settled watched placeholder is dropped once the exchange it stood for has arrived**, which
 *    is "the merge inserted a turn". Before that it stays: the answer it shows is the only copy on
 *    screen until the service's write lands.
 *
 * Returns `null` when nothing would change, so a caller can skip the store write and the render.
 * An inserted message never takes an id the conversation already uses.
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
    // **A question this browser holds with nothing after it takes the service's answer.** The
    // service writes a question ahead of its turn now, so a re-read during somebody else's turn
    // brings the question in alone (`running`) — and the rule above, that a turn both sides hold
    // stays as this browser has it, would then keep that lone question for ever and never let the
    // answer in. A turn this browser *sent* always has an answer bubble of its own, streaming or
    // settled, so only a question read from the service is ever answerless here.
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
