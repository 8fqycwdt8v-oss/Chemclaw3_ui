/**
 * Rebuilding a conversation from the service's stored transcript.
 *
 * The backend persists `tool_calls` with every message — and its own schema calls the missing
 * frontend half "the largest single blocker for the frontend repo". Until it was read, a reload
 * showed the same conversation with every trace row gone: the agent's work vanished and only its
 * prose survived.
 *
 * The case worth pinning hardest is a stored call with no result. Live, an open call row means
 * "running"; read back hours later that is simply false, and the difference is the reason
 * `unresolved` exists.
 */

import { describe, expect, it } from 'vitest';
import { messagesFromTranscript } from '../src/state/transcript.ts';
import type { TranscriptMessage } from '../src/api/client.ts';
import type { AssistantMessage } from '../src/state/types.ts';

const assistant = (m: ReturnType<typeof messagesFromTranscript>[number]): AssistantMessage => {
  if (m.role !== 'assistant') throw new Error('expected an assistant message');
  return m;
};

describe('messagesFromTranscript', () => {
  it('restores the trace rows a reload used to drop', () => {
    const remote: TranscriptMessage[] = [
      { index: 0, role: 'user', text: 'pKa of acetic acid?' },
      {
        index: 1,
        role: 'assistant',
        text: 'It is 4.76.',
        tool_calls: [{ tool: 'predict_pka', arguments: '{"smiles":"CC(=O)O"}', result: 'pKa 4.76' }],
      },
    ];

    const messages = messagesFromTranscript(remote);
    expect(messages).toHaveLength(2);

    const trace = assistant(messages[1]!).trace;
    expect(trace).toHaveLength(1);
    expect(trace[0]?.toolCall).toEqual({
      tool: 'predict_pka',
      arguments: '{"smiles":"CC(=O)O"}',
      result: 'pKa 4.76',
    });
  });

  it('marks a stored call with no result as unresolved, not as running', () => {
    const messages = messagesFromTranscript([
      {
        role: 'assistant',
        text: 'partial',
        tool_calls: [{ tool: 'compute_dft_energy', arguments: '{}', result: null }],
      },
    ]);

    const toolCall = assistant(messages[0]!).trace[0]?.toolCall;
    expect(toolCall?.unresolved).toBe(true);
    // Neither ending may be claimed: it did not return, and it was not reported as failing.
    expect(toolCall?.result).toBeUndefined();
    expect(toolCall?.failed).toBeUndefined();
  });

  it('puts the text in finalText and leaves streamedText empty', () => {
    // Setting both would be the double-render the store exists to make impossible: the renderer
    // picks `finalText ?? streamedText`.
    const message = assistant(messagesFromTranscript([{ role: 'assistant', text: 'answer' }])[0]!);
    expect(message.finalText).toBe('answer');
    expect(message.streamedText).toBe('');
  });

  it('claims nothing about a rehydrated answer the verifier may or may not have scored', () => {
    const message = assistant(messagesFromTranscript([{ role: 'assistant', text: 'answer' }])[0]!);
    expect(message.confidence).toBeNull();
    expect(message.verifiedBy).toBeNull();
    expect(message.unsupportedClaims).toEqual([]);
    expect(message.reviewRequired).toBe(false);
    // Not persisted with the message, so asserting either way would be inventing history.
    expect(message.degradedConnectors).toEqual([]);
    expect(message.queued).toBe(false);
  });

  it('keeps a turn that ran tools and then wrote nothing', () => {
    // The service has a code for exactly this (`empty_answer`). It is the failure a chemist most
    // needs to see, so an empty-text filter must not be the thing that hides it.
    const messages = messagesFromTranscript([
      {
        role: 'assistant',
        text: '   ',
        tool_calls: [{ tool: 'gather_evidence', arguments: '{}', result: '18 chunks' }],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(assistant(messages[0]!).trace).toHaveLength(1);
  });

  it('drops a message that has neither text nor work', () => {
    expect(messagesFromTranscript([{ role: 'assistant', text: '  ' }])).toHaveLength(0);
  });

  it('degrades to an empty trace against a backend that sends no tool_calls', () => {
    const messages = messagesFromTranscript([{ role: 'assistant', text: 'answer' }]);
    expect(assistant(messages[0]!).trace).toEqual([]);
  });

  it('gives every row a stable key across messages', () => {
    // Ids are derived from position, so two calls in two different messages cannot collide — a
    // React key collision here would silently drop a row.
    const messages = messagesFromTranscript([
      { role: 'assistant', text: 'a', tool_calls: [{ tool: 'x', arguments: '', result: 'r' }] },
      { role: 'assistant', text: 'b', tool_calls: [{ tool: 'y', arguments: '', result: 'r' }] },
    ]);
    const ids = messages.flatMap((m) => assistant(m).trace.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
