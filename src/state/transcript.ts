/**
 * Projecting a stored transcript onto the store's message shape.
 *
 * A pure function in its own module, because this is the seam where two contracts meet and it is
 * the only part of the rehydrate path worth testing without a component around it: the effect in
 * `App.tsx` owns fetching, cancellation and the failure banner, none of which have an opinion
 * about how a stored message becomes a rendered one.
 *
 * What the service can give back, and what it cannot. `role`, `text` and — since the transcript
 * route stopped flattening them away — the tool calls each message made, with their results. Not
 * `confidence`, `review_required`, plan snapshots or attachment references: those are computed at
 * turn time and streamed, and nothing writes them to storage, so a reload cannot recover them and
 * this must not invent them. Every such field is set to its "we do not know" value below rather
 * than to a plausible default, which is why they are written out one by one instead of spread
 * from a template.
 */

import type { TranscriptMessage, TranscriptToolCall } from '../api/client.ts';
import type { ChatMessage, TraceEntry } from './types.ts';

/**
 * The tool calls of one stored message, as trace rows.
 *
 * `result: null` means the store could not pair the call with a result — a turn that died
 * mid-call, or a pruned result row. It maps to `unresolved`, not to `failed` and not to "no result
 * yet": see `TraceEntry.toolCall`.
 */
function traceFrom(calls: TranscriptToolCall[], key: string, at: number): TraceEntry[] {
  return calls.map((call, i) => ({
    id: `${key}-t${i}`,
    at,
    kind: 'tool_call' as const,
    toolCall: {
      tool: call.tool,
      arguments: call.arguments,
      ...(call.result == null ? { unresolved: true } : { result: call.result }),
    },
  }));
}

export function transcriptToMessages(remote: TranscriptMessage[]): ChatMessage[] {
  // Decided once for the whole transcript rather than per message. The service's `index` counts
  // positions in the *stored* array, which includes the carrier messages it then drops, so it is
  // unique but not contiguous — and mixing it with the array position on a transcript where only
  // some messages carry one could produce the same key twice. A duplicate React key does not
  // throw; it silently drops a bubble.
  const indexed = remote.every((m) => typeof m.index === 'number');

  // Not a real timestamp, and there is none to be had: the transcript carries no per-message time.
  // Nothing renders it — `ElapsedTimer` is the only reader of `at` and only runs on a streaming
  // message, which a rehydrated one never is. Left here so the shape is complete, and written down
  // so the next person to reach for a "sent at" label knows this is not it.
  const at = Date.now();

  const messages: ChatMessage[] = [];
  remote.forEach((m, position) => {
    // The transcript is a conversation, not a message log. A `system` message is the agent's
    // instructions and a `tool` message is the carrier the service already pairs into its call;
    // rendering either as a turn would put text in the transcript that nobody said.
    if (m.role !== 'user' && m.role !== 'assistant') return;

    const text = m.text?.trim() ? m.text : '';
    const calls = m.tool_calls ?? [];
    // Empty and silent: nothing to show. This filter used to be on `text` alone, which was correct
    // only while tool calls were being discarded anyway — with them carried through, an assistant
    // message that did nothing but call tools is one of the more interesting rows in the
    // transcript, and dropping it would take its whole trace with it.
    if (!text && calls.length === 0) return;

    const key = `h${indexed ? m.index : position}`;

    if (m.role === 'user') {
      // A user message is its text; there is nothing else it could be showing.
      if (!text) return;
      messages.push({ id: key, role: 'user', text, at });
      return;
    }

    messages.push({
      id: key,
      role: 'assistant',
      at,
      status: 'done',
      streamedText: '',
      finalText: text,
      // Never persisted — see the module docstring. `null` and empty are the honest readings.
      confidence: null,
      unsupportedClaims: [],
      reviewRequired: false,
      // The backend stores the messages, not which connectors happened to be down when each was
      // produced.
      degradedConnectors: [],
      // A rehydrated message is finished, so it is not waiting on anything.
      queued: false,
      trace: traceFrom(calls, key, at),
      latestPlan: null,
      error: null,
    });
  });

  return messages;
}
