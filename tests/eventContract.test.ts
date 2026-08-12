import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.ts';
import type { ChemclawEvent } from '../shared/events.ts';

/**
 * The gate, asserted as a gate.
 *
 * `shared/events.ts` states the rule its own history taught: **`EVENT_TYPES` is the gate**, and an
 * interface added to the union without its discriminator changes nothing at runtime. That rule has
 * now been broken six times — `capability_degraded`, `tool_failed`, `job_failed`, and then
 * `evidence_source` and `handoff`, which shipped in the backend (M10 and M9) and never reached
 * this file. Every one of them was an event that existed to *qualify* what the agent said, so
 * dropping it rendered a worse answer as an ordinary one.
 *
 * Prose in a docstring did not stop the fifth and sixth. This does: every member of the union must
 * survive `normalizeEvent`, checked by round-tripping a frame of each type rather than by reading
 * the list — the list is the thing that was wrong.
 */
describe('the event contract admits every member of its own union', () => {
  const frames: Record<ChemclawEvent['type'], Record<string, unknown>> = {
    queued: {},
    plan: { todos: ['a'] },
    tool_call: { tool: 'find_notes', arguments: '{}' },
    token: { text: 'hi' },
    job_started: { job_id: 'j1', kind: 'qm' },
    job_completed: { job_id: 'j1', summary: {} },
    job_failed: { job_id: 'j1', reason: 'no' },
    capability_degraded: { connectors: ['eln'] },
    tool_failed: { tool: 'find_notes', message: 'boom' },
    tool_result: { tool: 'find_notes', preview: 'x' },
    evidence_source: { source: 'graph', chunks: 4 },
    handoff: { to: 'safety', reason: 'hazard check' },
    question: { question: 'which?', options: [] },
    note_proposed: { note_id: 'n1', reference: 'ref' },
    approval_request: { prompt: 'ok?', approval_id: 'a1' },
    answer: { text: 'done' },
    error: { message: 'bad' },
  };

  it.each(Object.keys(frames))('admits %s', (type) => {
    const parsed = normalizeEvent({ type, ...frames[type as ChemclawEvent['type']] });
    expect(parsed, `${type} is in the union but not past the gate`).not.toBeNull();
    expect(parsed?.type).toBe(type);
  });

  it('reads the specialist off the events a specialist can raise', () => {
    // Empty means the main agent, which is what every event meant before teams existed — so this
    // is additive and an existing reader is unaffected.
    for (const type of ['tool_call', 'tool_failed', 'tool_result'] as const) {
      const withAgent = normalizeEvent({ type, ...frames[type], agent: 'safety' });
      expect(withAgent && 'agent' in withAgent && withAgent.agent).toBe('safety');
      const without = normalizeEvent({ type, ...frames[type] });
      expect(without && 'agent' in without && without.agent).toBe('');
    }
  });

  it('treats an empty handoff target as the hand back rather than a bad frame', () => {
    // `to: ''` is a declared value: it is how the backend says control returned to the main agent.
    // A reader that discarded it would show a turn stuck inside a specialist it had already left.
    const back = normalizeEvent({ type: 'handoff', to: '', reason: '' });
    expect(back).toEqual({ type: 'handoff', to: '', reason: '' });
  });

  it('does not invent a chunk count from a frame that carries none', () => {
    const parsed = normalizeEvent({ type: 'evidence_source', source: 'lexical' });
    expect(parsed).toEqual({ type: 'evidence_source', source: 'lexical', chunks: 0 });
  });
});
