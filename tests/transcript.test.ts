/**
 * Projecting a stored transcript onto the store's message shape.
 *
 * The transcript route grew `tool_calls` — the service always held them and used to flatten them
 * away — and this client kept mapping the old shape, so a reload turned every answer into bare
 * prose and dropped the whole trace. These tests pin the parts of the projection that are decisions
 * rather than plumbing: what a `null` result means, which messages survive the filter, and how a
 * key is chosen.
 */

import { describe, expect, it } from 'vitest';
import { transcriptToMessages } from '../src/state/transcript.ts';
import type { TranscriptMessage } from '../src/api/client.ts';
import type { AssistantMessage } from '../src/state/types.ts';

const assistantAt = (index: number, remote: TranscriptMessage[]): AssistantMessage => {
  const message = transcriptToMessages(remote)[index];
  if (!message || message.role !== 'assistant') throw new Error('expected an assistant message');
  return message;
};

describe('transcriptToMessages', () => {
  it('carries the tool calls of a stored message into its trace', () => {
    const message = assistantAt(0, [
      {
        index: 0,
        role: 'assistant',
        text: 'BrettPhos, at 1.2 equiv base.',
        tool_calls: [
          { tool: 'search_notes', arguments: '{"q":"ligand"}', result: 'Note eln-4471.' },
        ],
      },
    ]);

    expect(message.trace).toHaveLength(1);
    expect(message.trace[0]?.kind).toBe('tool_call');
    expect(message.trace[0]?.toolCall).toMatchObject({
      tool: 'search_notes',
      arguments: '{"q":"ligand"}',
      result: 'Note eln-4471.',
    });
  });

  it('marks an unpaired call unresolved rather than failed or still running', () => {
    // `result: null` is the service saying it could not pair the call with a result — a turn that
    // died mid-call, or a pruned row. Reading it as "no result yet" animates "running…" inside a
    // finished transcript; reading it as `failed` claims an error nobody recorded.
    const message = assistantAt(0, [
      {
        index: 0,
        role: 'assistant',
        text: 'Checked the hazard profile.',
        tool_calls: [{ tool: 'screen_hazards', arguments: '{}', result: null }],
      },
    ]);

    expect(message.trace[0]?.toolCall?.unresolved).toBe(true);
    expect(message.trace[0]?.toolCall?.result).toBeUndefined();
    expect(message.trace[0]?.toolCall?.failed).toBeUndefined();
  });

  it('keeps a message that only called tools and said nothing', () => {
    // The filter used to be on text alone, which was harmless only while tool calls were being
    // discarded anyway. With them carried through, this message is one of the more interesting
    // rows in the transcript and dropping it would take its whole trace with it.
    const messages = transcriptToMessages([
      {
        index: 0,
        role: 'assistant',
        text: '   ',
        tool_calls: [{ tool: 'run_xtb', arguments: '{}', result: 'done' }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect((messages[0] as AssistantMessage).finalText).toBe('');
    expect((messages[0] as AssistantMessage).trace).toHaveLength(1);
  });

  it('drops a message that is neither said nor did anything', () => {
    expect(
      transcriptToMessages([{ index: 0, role: 'assistant', text: '', tool_calls: [] }]),
    ).toEqual([]);
    expect(transcriptToMessages([{ index: 0, role: 'user', text: '  ', tool_calls: [] }])).toEqual(
      [],
    );
  });

  it('renders only turns — a system prompt is not something anyone said', () => {
    const messages = transcriptToMessages([
      { index: 0, role: 'system', text: 'You are a chemistry assistant.' },
      { index: 1, role: 'user', text: 'What is the pKa of acetic acid?' },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('gives every message a distinct key when the service omits index', () => {
    // An older service sends no `index`. The rule has to be decided for the whole transcript
    // rather than per message: mixing the service's index with the array position can produce the
    // same key twice, and a duplicate React key silently drops a bubble.
    const messages = transcriptToMessages([
      { index: 0, role: 'assistant', text: 'first' },
      { role: 'user', text: 'second' },
      { index: 1, role: 'assistant', text: 'third' },
    ]);

    expect(messages.map((m) => m.id)).toEqual(['h0', 'h1', 'h2']);
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
  });

  it('uses the service index as the key when every message carries one', () => {
    // Not contiguous: the service counts positions in the stored array, which includes the carrier
    // messages it then drops.
    const messages = transcriptToMessages([
      { index: 0, role: 'user', text: 'ask' },
      { index: 2, role: 'assistant', text: 'answer' },
    ]);

    expect(messages.map((m) => m.id)).toEqual(['h0', 'h2']);
  });

  it('invents nothing the transcript does not store', () => {
    // `confidence`, `review_required`, plan snapshots and degraded connectors are turn-time values
    // that are streamed and never written to storage. A plausible default here would be a claim
    // about a turn nobody can check.
    const message = assistantAt(0, [{ index: 0, role: 'assistant', text: 'An answer.' }]);

    expect(message.confidence).toBeNull();
    expect(message.reviewRequired).toBe(false);
    expect(message.unsupportedClaims).toEqual([]);
    expect(message.degradedConnectors).toEqual([]);
    expect(message.latestPlan).toBeNull();
    expect(message.queued).toBe(false);
    expect(message.status).toBe('done');
  });
});
