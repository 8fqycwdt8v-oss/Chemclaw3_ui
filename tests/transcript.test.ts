/**
 * Projecting a stored transcript onto the store's message shape.
 *
 * This projection used to live inline inside the rehydrate effect, where the only way to assert
 * any of it was to render a shell and stub `fetch`. What it actually contains is decisions — which
 * stored messages are turns, what an unpaired call means, and which fields a reload genuinely
 * knows — and those are worth pinning directly.
 */

import { describe, expect, it } from 'vitest';
import { transcriptToMessages } from '../src/state/transcript.ts';
import type { TranscriptMessage } from '../src/api/client.ts';
import type { AssistantMessage } from '../src/state/types.ts';

/** A `TranscriptMessage` with the fields the service always sends. */
const message = (over: Partial<TranscriptMessage> & { role: string }): TranscriptMessage => ({
  index: 0,
  text: '',
  tool_calls: [],
  ...over,
});

const firstAssistant = (remote: TranscriptMessage[]): AssistantMessage => {
  const found = transcriptToMessages(remote).find((m) => m.role === 'assistant');
  if (found?.role !== 'assistant') throw new Error('expected an assistant message');
  return found;
};

describe('transcriptToMessages', () => {
  it('carries a stored call’s result_ref, which is the only way back to the full result', () => {
    // `TranscriptToolCall.result_ref` is the same handle `ToolResultEvent.result_ref` carries live,
    // and the service added it to this route for one stated reason: without it "a reload was the
    // one path on which a result stopped being reachable". `result` is 400 characters of prose
    // about the data; the bytes are behind `GET /sessions/{id}/tool-results/{ref}`.
    //
    // Dropped here, a rehydrated conversation loses `ResultBlock` under the answer AND the trace
    // panel's "full result" affordance — both gate on `toolCall.resultRef` — and does so silently:
    // the row still renders, with the preview, looking exactly like a call whose result was never
    // stored.
    const ref = 'a'.repeat(64);
    const assistant = firstAssistant([
      message({
        role: 'assistant',
        text: 'Two structural alerts.',
        tool_calls: [
          {
            tool: 'screen_hazards',
            arguments: '{"smiles":"CCO"}',
            result: '{"flags":',
            result_ref: ref,
          },
        ],
      }),
    ]);
    expect(assistant.trace[0]?.toolCall?.resultRef).toBe(ref);
  });

  it('leaves resultRef absent when the service says there is nothing to fetch', () => {
    // The middle of the service's three states: a result exists, and only these 400 characters of
    // it — the bytes were never stored or retention has swept them. An empty string must not
    // become a ref, or every rehydrated call would render a control that 404s.
    const assistant = firstAssistant([
      message({
        role: 'assistant',
        text: 'Done.',
        tool_calls: [{ tool: 'predict_pka', arguments: '{}', result: 'pKa 9.2', result_ref: '' }],
      }),
    ]);
    expect(assistant.trace[0]?.toolCall).not.toHaveProperty('resultRef');
  });

  it('carries the tool calls of a stored message into its trace', () => {
    const assistant = firstAssistant([
      message({
        role: 'assistant',
        text: 'BrettPhos, at 1.2 equiv base.',
        tool_calls: [
          { tool: 'gather_evidence', arguments: '{"q":"ligand"}', result: 'Note eln-4471.' },
        ],
      }),
    ]);

    expect(assistant.trace).toHaveLength(1);
    expect(assistant.trace[0]?.kind).toBe('tool_call');
    expect(assistant.trace[0]?.toolCall).toMatchObject({
      tool: 'gather_evidence',
      arguments: '{"q":"ligand"}',
      result: 'Note eln-4471.',
    });
  });

  it('marks an unpaired call unresolved rather than failed', () => {
    // The service says `result: null` means the pairing is incomplete — a turn that died mid-call
    // *or a pruned result row* — and asks a surface to render "we do not know how it ended".
    // `failed` names an outcome that only one of those two causes actually is.
    const assistant = firstAssistant([
      message({
        role: 'assistant',
        text: 'Checked the hazard profile.',
        tool_calls: [{ tool: 'screen_hazards', arguments: '{}', result: null }],
      }),
    ]);

    expect(assistant.trace[0]?.toolCall?.unresolved).toBe(true);
    expect(assistant.trace[0]?.toolCall?.failed).toBeUndefined();
    // And not the empty state either, which the panel renders as "running…".
    expect(assistant.trace[0]?.toolCall?.result).toBeUndefined();
  });

  it('keeps a message that only called tools and said nothing', () => {
    const messages = transcriptToMessages([
      message({
        role: 'assistant',
        text: '   ',
        tool_calls: [{ tool: 'run_xtb', arguments: '{}', result: 'done' }],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect((messages[0] as AssistantMessage).finalText).toBe('');
    expect((messages[0] as AssistantMessage).trace).toHaveLength(1);
  });

  it('drops a message that neither said nor did anything', () => {
    expect(transcriptToMessages([message({ role: 'assistant' })])).toEqual([]);
    expect(transcriptToMessages([message({ role: 'user', text: '  ' })])).toEqual([]);
  });

  it('renders only turns — a system prompt is not something anyone said', () => {
    // The service drops the `tool` carrier rows it has already paired, and nothing else. A system
    // message would arrive here and render as an assistant answer.
    const messages = transcriptToMessages([
      message({ role: 'system', text: 'You are a chemistry assistant.' }),
      message({ index: 1, role: 'user', text: 'What is the pKa of acetic acid?' }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('gives the surviving messages dense, unique keys', () => {
    const messages = transcriptToMessages([
      message({ role: 'system', text: 'instructions' }),
      message({ index: 1, role: 'user', text: 'ask' }),
      message({ index: 2, role: 'assistant', text: '' }),
      message({ index: 3, role: 'assistant', text: 'answer' }),
    ]);

    expect(messages.map((m) => m.id)).toEqual(['h0', 'h1']);
  });

  it('invents nothing the transcript does not store', () => {
    // `confidence`, `verified_by`, `review_required`, plan snapshots and degraded connectors are
    // turn-time values that are streamed and never written to storage. A plausible default here
    // would be a claim about a turn nobody can check.
    const assistant = firstAssistant([message({ role: 'assistant', text: 'An answer.' })]);

    expect(assistant.confidence).toBeNull();
    expect(assistant.verifiedBy).toBeNull();
    expect(assistant.reviewRequired).toBe(false);
    expect(assistant.unsupportedClaims).toEqual([]);
    expect(assistant.degradedConnectors).toEqual([]);
    expect(assistant.latestPlan).toBeNull();
    expect(assistant.queued).toBe(false);
    expect(assistant.status).toBe('done');
  });
});
