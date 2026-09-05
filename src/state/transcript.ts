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

import type { TranscriptMessage, TranscriptToolCall } from '../api/client.ts';
import type { ChatMessage, TraceEntry } from './types.ts';

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
      ...(call.result == null ? { unresolved: true } : { result: call.result }),
    },
  }));
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

    if (m.role === 'user') {
      // A user message is its text; there is nothing else it could be showing.
      if (!text) continue;
      messages.push({ id: key, role: 'user', text, at });
      continue;
    }

    messages.push({
      id: key,
      role: 'assistant',
      at,
      status: 'done',
      streamedText: '',
      finalText: text,
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
      trace: traceFrom(calls, key, at),
      latestPlan: null,
      latestPlanHash: null,
      error: null,
    });
  }

  return messages;
}
