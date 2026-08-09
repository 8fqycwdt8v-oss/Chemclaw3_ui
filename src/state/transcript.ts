/**
 * Rebuilding a conversation from the service's stored transcript.
 *
 * Reached on a reload whose `localStorage` did not survive — a different browser, a cleared cache —
 * where the session handle is still alive but the messages are gone. What comes back is
 * `GET /sessions/{id}/messages`.
 *
 * **A rehydrated turn is not a live one, and the difference is the whole difficulty here.** Three
 * fields have no stored counterpart and are left at their empty values rather than guessed:
 * `degradedConnectors` (the service persists messages, not which connectors were down when each
 * was produced), `queued`, and the verifier's scores. A fourth — a tool call with no recorded
 * result — is the one that cannot be left alone, because its empty value already means something
 * else: live, an open call row renders "running…", and on a transcript read back hours later that
 * is simply false. It is marked `unresolved` instead.
 *
 * Kept out of `App.tsx`, where this used to be an inline literal inside a `useEffect`: it is
 * state-shape construction rather than a render concern, it is the one place two contracts (the
 * HTTP transcript and the store's `ChatMessage`) meet, and inline it could not be tested.
 */

import type { TranscriptMessage } from '../api/client.ts';
import type { ChatMessage, TraceEntry } from './types.ts';

/**
 * The trace rows for one stored turn.
 *
 * One row per call, matching the live view: `TracePanel` renders a call and its result as a single
 * step, so a transcript that emitted two rows per call would show the same conversation with twice
 * the steps depending only on whether it had been reloaded.
 */
function traceFrom(message: TranscriptMessage, messageIndex: number): TraceEntry[] {
  return (message.tool_calls ?? []).map((call, i) => ({
    id: `h${messageIndex}-t${i}`,
    // The transcript carries no per-call timestamp. Zero rather than `Date.now()`: the panel
    // renders rows in array order and never displays this, so a fabricated "now" would only be
    // wrong for anything that later decided to sort by it.
    at: 0,
    kind: 'tool_call' as const,
    toolCall: {
      tool: call.tool,
      arguments: call.arguments,
      ...(call.result === null || call.result === undefined
        ? { unresolved: true }
        : { result: call.result }),
    },
  }));
}

/**
 * Convert the service's transcript into store messages.
 *
 * Messages with no text are dropped, but only when they also did nothing: a turn whose text is
 * empty and whose `tool_calls` are not is a turn that ran tools and then died before writing an
 * answer, and that is precisely the failure a chemist most needs to see rather than the one to
 * hide. The service has its own error code for it (`empty_answer`).
 */
export function messagesFromTranscript(remote: TranscriptMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  remote.forEach((m, i) => {
    const text = m.text?.trim() ?? '';
    const trace = traceFrom(m, i);
    if (!text && trace.length === 0) return;

    if (m.role === 'user') {
      messages.push({ id: `h${i}`, role: 'user', text: m.text, at: 0 });
      return;
    }

    messages.push({
      id: `h${i}`,
      role: 'assistant',
      at: 0,
      status: 'done',
      // `finalText`, never `streamedText`: the renderer picks `finalText ?? streamedText` and
      // setting both would be the double-render the store is built to make impossible.
      streamedText: '',
      finalText: m.text,
      // The verifier's scores are not persisted with the message. Left null/empty rather than
      // defaulted to something reassuring: a rehydrated answer is one nobody can now tell you was
      // checked, and rendering it as "no claims unsupported" would say more than we know.
      confidence: null,
      unsupportedClaims: [],
      reviewRequired: false,
      verifiedBy: null,
      degradedConnectors: [],
      queued: false,
      trace,
      // The plan is a live-turn artifact; the transcript stores no todo list.
      latestPlan: null,
      error: null,
    });
  });

  return messages;
}
