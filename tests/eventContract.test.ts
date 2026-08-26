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
    expect(parsed).toEqual({ type: 'evidence_source', source: 'lexical', chunks: 0, failed: false });
  });
});

/**
 * The same gate, one level down — on FIELDS.
 *
 * The member check above passed for every one of `plan.plan_hash`, `tool_failed.reason` and
 * `evidence_source.failed` while all three were being silently discarded, because the member was
 * present and only the field was missing. `normalizeEvent` rebuilds every event field by field, so
 * a field this file does not know about is not merely untyped — it is deleted in transit, and the
 * consumer sees a well-formed event with the qualifying half removed.
 *
 * Each of those three exists to draw a distinction the surface otherwise cannot: a plan that can be
 * answered without a second read that races it, a refusal told apart from a fault, a broken
 * retriever told apart from an empty corpus. Losing the field loses the distinction, quietly, with
 * every other test green.
 *
 * This asserts value-for-value rather than key presence, because a normalizer that defaults a field
 * to a constant passes a presence check while discarding what arrived.
 */
describe('the event contract carries every field of every member', () => {
  // One frame per member, every declared field populated with a value distinguishable from the
  // default it would fall back to. Transcribed from `src/chemclaw/api/events.py`; when the backend
  // adds a field, it is added here in the same change, and this is the assertion that makes
  // "same change" mean something.
  const full: Array<[string, Record<string, unknown>]> = [
    ['plan', { todos: ['step one'], plan_hash: 'abc123' }],
    ['tool_call', { tool: 'find_notes', arguments: '{"q":1}', agent: 'safety' }],
    ['token', { text: 'hello' }],
    ['job_started', { job_id: 'j1', kind: 'qm' }],
    ['job_completed', { job_id: 'j1', summary: { converged: true } }],
    ['job_failed', { job_id: 'j1', reason: 'the solver diverged' }],
    ['capability_degraded', { connectors: ['eln'] }],
    ['tool_failed', { tool: 'submit_qm_job', message: 'refused', reason: 'plan_gate', agent: 'x' }],
    [
      'tool_result',
      {
        tool: 'find_notes',
        preview: 'p',
        result_ref: 'a'.repeat(64),
        note_ids: ['note-x'],
        numbers: [1.5],
        agent: 'x',
      },
    ],
    ['evidence_source', { source: 'graph', chunks: 4, failed: true }],
    ['handoff', { to: 'safety', reason: 'hazard' }],
    ['question', { question: 'which?', options: ['a'] }],
    ['note_proposed', { note_id: 'n1', reference: 'branch/x' }],
    ['approval_request', { prompt: 'ok?', approval_id: 'a1' }],
    [
      'answer',
      {
        text: 'done',
        confidence: 0.75,
        unsupported_claims: ['c'],
        review_required: true,
        verified_by: 'judge',
      },
    ],
    ['error', { message: 'bad', code: 'loop_cap_reached', retryable: false, correlation_id: 'c1' }],
  ];

  it.each(full)('carries every field of %s', (type, frame) => {
    const parsed = normalizeEvent({ type, ...frame }) as Record<string, unknown> | null;
    expect(parsed, `${type} did not survive the gate at all`).not.toBeNull();
    for (const [key, value] of Object.entries(frame)) {
      expect(parsed?.[key], `${type}.${key} was dropped by normalizeEvent`).toEqual(value);
    }
  });

  it('normalises a reason it does not recognise to an ordinary failure', () => {
    // A closed set upstream. "Some reason this build has not heard of" must read as an ordinary
    // failure — never as a gate refusal it would render in the wrong colour and the wrong words.
    const parsed = normalizeEvent({ type: 'tool_failed', tool: 't', message: 'm', reason: 'x' });
    expect(parsed).toMatchObject({ reason: null });
  });

  it('reads a missing plan hash as absent rather than as a hash', () => {
    // The backend defaults it to '' for a frame that predates the field, and a consumer must treat
    // that as "go and fetch it". The value it must never be is one that looks answerable.
    const parsed = normalizeEvent({ type: 'plan', todos: ['a'] });
    expect(parsed).toMatchObject({ plan_hash: '' });
  });
});
