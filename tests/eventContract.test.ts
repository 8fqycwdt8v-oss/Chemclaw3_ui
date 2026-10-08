import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, normalizeEvent } from '../shared/events.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import { EVENT_ENUMS, EVENT_SCHEMAS } from '../shared/generated/events.ts';

/**
 * The gate, asserted as a gate.
 *
 * Every member of the union must survive `normalizeEvent`, checked by round-tripping a frame of each
 * type rather than by reading a list. The members themselves are generated from the pinned
 * contract (`shared/generated/events.ts`), so a kind the contract gains is admitted by
 * construction; what these tests hold is that the tolerant readings in `shared/events.ts` keep
 * every field's value and fall back where they say they do.
 */
describe('the event contract admits every member of its own union', () => {
  const frames: Record<ChemclawEvent['type'], Record<string, unknown>> = {
    queued: {},
    plan: { todos: ['a'] },
    tool_call: { tool: 'find_notes', arguments: '{}' },
    token: { text: 'hi' },
    job_started: { job_id: 'j1', kind: 'qm' },
    tool_queued: { tool: 'predict_pka', job_id: 'q1', state: 'queued' },
    job_completed: { job_id: 'j1', summary: {} },
    job_failed: { job_id: 'j1', reason: 'no' },
    awaiting_answer: { request_id: 'await-1' },
    capability_degraded: { connectors: ['eln'] },
    tool_failed: { tool: 'find_notes', message: 'boom' },
    tool_result: { tool: 'find_notes', preview: 'x' },
    evidence_source: { source: 'graph', chunks: 4 },
    handoff: { from_agent: 'default', to_agent: 'safety', reason: 'hazard check' },
    exhibit: { exhibit_id: 'xb-0123456789abcdef', revision: 1, kind: 'table', op: 'created' },
    exhibit_draft: { call_id: 'toolu_1', op: 'create', kind: 'document', markdown: '# Draft' },
    question: { question: 'which?', options: [] },
    note_recorded: { note_id: 'n1', reference: 'ref' },
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

  it('carries a handoff frame now that something upstream sends one', () => {
    // **This inverts two pins rather than deleting them quietly**, and the inversion is the point.
    // They asserted that `normalizeEvent({type: 'handoff', ...})` returned null and that no file
    // in the app consumed one, because the service carried the member with nothing able to
    // construct it — a consumer chain that reads as a live feature and could never render.
    //
    // Chemclaw3's `D-2026-09-19-a-handoff-redistributes-the-turns-authority-it-cannot-extend-it`
    // ships the producer: a turn graph whose nodes are several agents, and a `transfer_to_<peer>`
    // tool that moves the conversation. An absence is the right assertion for a claim nothing can
    // write; once something writes it, keeping the absence would have to be DEFEATED rather than
    // satisfied, which is the worst of both.
    //
    // The shape is not the one that was pinned. That was `{to, reason}` with an empty `to` meaning
    // "handed back", bracketing a specialist's work. A peer handoff has no exit — control does not
    // return unless another handoff sends it — so both agents are named and there is no hand-back
    // to encode.
    const event = normalizeEvent({
      type: 'handoff',
      from_agent: 'default',
      to_agent: 'safety',
      reason: 'hazard check',
    });

    expect(event).toEqual({
      type: 'handoff',
      from_agent: 'default',
      to_agent: 'safety',
      reason: 'hazard check',
    });
  });

  it('does not invent a chunk count from a frame that carries none', () => {
    const parsed = normalizeEvent({ type: 'evidence_source', source: 'lexical' });
    expect(parsed).toEqual({
      type: 'evidence_source',
      source: 'lexical',
      chunks: 0,
      failed: false,
    });
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
// One frame per member, every declared field populated with a value distinguishable from the
// default it would fall back to. When the pinned contract gains a field, the declaration check
// below fails until it is added here.
const full: Array<[string, Record<string, unknown>]> = [
  // It declared no fields until shared-session queueing (Chemclaw3 #499) gave it a place in line,
  // and this entry was kept present with an empty frame for exactly that day: the declaration
  // check below is what failed when `ticket` and `position` arrived.
  ['queued', { ticket: 12, position: 3 }],
  ['plan', { todos: ['step one'], plan_hash: 'abc123', scope: ['record_knowledge_note'] }],
  ['tool_call', { tool: 'find_notes', arguments: '{"q":1}', agent: 'safety' }],
  // `agent` is load-bearing on this one: the backend stamps every token with it and says a
  // consumer "concatenates only the unattributed ones", so a dropped field here splices a
  // subagent's working notes into the answer.
  ['token', { text: 'hello', agent: 'subagent' }],
  ['job_started', { job_id: 'j1', kind: 'qm', plan_step: 'run the conformer search' }],
  ['tool_queued', { tool: 'predict_pka', job_id: 'q1', state: 'running', waiting: 3 }],
  ['job_completed', { job_id: 'j1', summary: { converged: true } }],
  ['job_failed', { job_id: 'j1', reason: 'the solver diverged' }],
  // Both pushes' fields at once, which no single frame from the service carries: the open sends
  // `kind`/`asked_of`/`due_at`, the expiry sends `subject`/`reminders`. This fixture is a
  // field-survival check rather than a realistic frame, and splitting it into two would only test
  // half the fields twice.
  [
    'awaiting_answer',
    {
      request_id: 'await-9f2c',
      state: 'expired',
      subject: 'Isolated yield for arm B3',
      kind: 'measurement',
      asked_of: 'process-chemist',
      due_at: '2026-09-06T00:00:00Z',
      reminders: 2,
    },
  ],
  ['capability_degraded', { connectors: ['eln'] }],
  [
    'tool_failed',
    {
      tool: 'submit_qm_job',
      message: 'refused',
      reason: 'plan_gate',
      agent: 'x',
      call_id: 'toolu_1',
    },
  ],
  [
    'tool_result',
    {
      tool: 'find_notes',
      preview: 'p',
      result_ref: 'a'.repeat(64),
      // The whole result when it is small enough to ride along. A consumer must treat it as an
      // optimisation and never as the presence check — `result_ref` is still what says a result
      // was stored — so both are populated here, together, as the service sends them.
      result_inline: '{"pka": 1.5}',
      // The model read a cut; the ref opens the full text. Dropped in transit, the chemist never
      // learns the assistant worked from less than the tool returned.
      result_cut: true,
      note_ids: ['note-x'],
      numbers: [1.5],
      // The same figure under the key the tool filed it under. Dropped in transit, the entity rail
      // is back to "find_notes returned 1.5" and the value strip has no names to print.
      values: [{ label: 'pka', value: 1.5, unit: '' }],
      agent: 'x',
    },
  ],
  ['evidence_source', { source: 'graph', chunks: 4, failed: true }],
  // Distinguishable values on every field, so a mirror that crossed two of them fails here rather
  // than round-tripping. `from_agent` and `to_agent` are deliberately unlike each other.
  ['handoff', { from_agent: 'default', to_agent: 'safety', reason: 'hazard check' }],
  // Every field away from its fallback: `revised` is what an unknown op reads as and `agent` what an
  // unknown author kind reads as, so the frame carries the other value of each — a mirror that
  // dropped either would round-trip the default and pass.
  [
    'exhibit',
    {
      exhibit_id: 'xb-0123456789abcdef',
      revision: 3,
      kind: 'table',
      title: 'Solvent ranking',
      op: 'created',
      author_kind: 'human',
      author: 'chemist@example.com',
      call_id: 'toolu_01',
    },
  ],
  // Every field away from its fallback: `create` is the op an unknown value does NOT read as, and
  // `done: true` the flag that falls back to false — a mirror that dropped either would pass on the
  // default otherwise.
  [
    'exhibit_draft',
    {
      call_id: 'toolu_01',
      op: 'create',
      exhibit_id: 'xb-0123456789abcdef',
      kind: 'document',
      title: 'Process report',
      markdown: '# Process report\n\nThe amination ran in',
      done: true,
    },
  ],
  ['question', { question: 'which?', options: ['a'] }],
  ['note_recorded', { note_id: 'n1', reference: 'branch/x' }],
  ['approval_request', { prompt: 'ok?', approval_id: 'a1' }],
  [
    'answer',
    {
      text: 'done',
      confidence: 0.75,
      unsupported_claims: ['c'],
      review_required: true,
      // Both members, because the narrowing in `asAnswerChecks` is per-member: a fixture carrying
      // one would leave the other's spelling unproven, and a mistyped literal there reads as that
      // check not having run.
      checks_run: ['verifier', 'answer-shape'],
      // Both permanently at their defaults upstream today, and mirrored anyway: reviving them is a
      // coordinated three-repo cut, and this fixture is what makes the mirror notice it.
      challenged: true,
      review_hold_id: 'hold-42',
      verified_by: 'judge',
    },
  ],
  ['error', { message: 'bad', code: 'loop_cap_reached', retryable: false, correlation_id: 'c1' }],
];

describe('the event contract carries every field of every member', () => {
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

  it('reads a missing plan scope as absent rather than as "authorizes nothing"', () => {
    // The sibling of the assertion above, and the same distinction: a frame from a service that
    // predates `scope` carries none, and an empty list must send the card to the fetch rather than
    // let it display a tool list it does not have. `[]` at the schema and `null` at the store is
    // what keeps those two readings apart — a card told "no tools" would be a false reassurance
    // about what approving this plan authorizes.
    const parsed = normalizeEvent({ type: 'plan', todos: ['a'], plan_hash: 'h' });
    expect(parsed).toMatchObject({ scope: [] });
  });
});

/**
 * The fixture above covers every field the union declares.
 *
 * The two tests above are only as good as `full`, and `full` is written by hand. A field declared
 * and then *defaulted away* by a wrong fallback is invisible to a presence check; only a frame
 * carrying a distinguishable value shows it. So the fixture is checked against the generated
 * declarations: every field of every member must appear in `full`.
 */
const declaredMembers = (): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    Object.entries(EVENT_SCHEMAS).map(([type, schema]) => [
      type,
      new Set(Object.keys(schema.entries).filter((key) => key !== 'type')),
    ]),
  );

describe('the fixture is checked against the declarations, not trusted', () => {
  const fixture = new Map(full.map(([type, frame]) => [type, new Set(Object.keys(frame))]));

  it('covers every member the union declares', () => {
    const missing = [...declaredMembers().keys()].filter((type) => !fixture.has(type));
    expect(
      missing,
      `these members of ChemclawEvent have no frame in the fixture: ${missing}`,
    ).toEqual([]);
  });

  it.each([...declaredMembers()].map(([type, fields]) => [type, fields] as const))(
    'covers every field of %s',
    (type, fields) => {
      const covered = fixture.get(type);
      expect(covered, `${type} is declared but has no fixture frame`).toBeDefined();
      const absent = [...fields].filter((field) => !covered?.has(field));
      expect(
        absent,
        `${type} declares ${absent} but the fixture does not populate them, so nothing proves ` +
          'normalizeEvent carries them — add them to `full` above',
      ).toEqual([]);
      const stray = [...(covered ?? [])].filter((field) => !fields.has(field));
      expect(
        stray,
        `the fixture populates ${stray} on ${type}, which the interface does not declare`,
      ).toEqual([]);
    },
  );
});

/**
 * The gate and the union are one vocabulary: `EVENT_TYPES` admits every member of the union and
 * nothing else except a pinned alias, which is a second wire spelling that normalises onto a
 * declared member (a two-repository rename in progress).
 */
describe('the runtime gate and the interface union are one vocabulary', () => {
  /** What the gate admits, read off `EVENT_TYPES` — the same reader the contract check uses. */
  const gate = (): string[] => [...EVENT_TYPES];

  it('is the list the gate actually holds, not a re-derivation of it', () => {
    // Every assertion below loops over this, so a reader that returned nothing would pass them
    // all. Seventeen members and one alias today; more than ten is the honest floor.
    expect(gate().length, 'EVENT_TYPES read as nothing').toBeGreaterThan(10);
  });

  it('admits no name the union does not declare, except a pinned alias', () => {
    const union = new Set(declaredMembers().keys());
    const orphans: string[] = [];
    const aliases: string[] = [];
    for (const name of gate()) {
      // Probed rather than read: the question is what a frame with this name *becomes*, which is
      // what an alias is and what a dead entry is not.
      const parsed = normalizeEvent({ type: name });
      if (parsed === null) {
        orphans.push(`${name}: in EVENT_TYPES and normalizeEvent has no branch for it`);
        continue;
      }
      if (parsed.type === name) {
        if (!union.has(name)) orphans.push(`${name}: no interface of that type in ChemclawEvent`);
        continue;
      }
      if (!union.has(parsed.type)) {
        orphans.push(`${name}: normalises onto ${parsed.type}, which the union does not declare`);
      } else {
        aliases.push(`${name} -> ${parsed.type}`);
      }
    }
    expect(
      orphans,
      'in the runtime gate and nowhere in the union — the gate is the thing that admits, so this ' +
        'is a name this client accepts and no surface can render',
    ).toEqual([]);
    // Pinned, not counted: a second alias is a second wire spelling of an existing event, which is
    // a two-repository rename in progress and needs the argument that goes with one (ISSUES.md).
    expect(
      aliases,
      'a wire name normalising onto another event — argue it in shared/events.ts and ISSUES.md, ' +
        'then pin it here',
    ).toEqual(['note_proposed -> note_recorded']);
  });

  it('declares no member of the union that the gate would drop', () => {
    // The direction that has cost six events. Held by the round-trips at the top of this file too;
    // asserted here as well because this is where the two lists are compared, and a reader
    // arriving at this describe should not have to know that.
    const admitted = new Set(gate());
    expect([...declaredMembers().keys()].filter((type) => !admitted.has(type))).toEqual([]);
  });
});

/**
 * Every error code the contract declares survives normalisation.
 *
 * A code that did not would arrive as `internal`, which is not in `PARTIAL_ANSWER_CODES`, so
 * `streamTurn` would treat a turn that only ran into a guard as terminal and cancel it before the
 * service records the transcript — the partial answer lost from the screen and from the stored
 * conversation.
 */
describe('every error code the contract declares is one the normaliser accepts', () => {
  it.each([...EVENT_ENUMS['ErrorEvent.code']])('keeps %s', (code) => {
    const event = normalizeEvent({
      type: 'error',
      message: 'x',
      code,
      retryable: false,
      correlation_id: 'c1',
    });
    expect(event, `normalizeEvent dropped the ${code} event entirely`).not.toBeNull();
    expect((event as { code: string }).code, `'${code}' normalised to something else`).toBe(code);
  });

  it('reads a code it has not heard of as internal', () => {
    const event = normalizeEvent({ type: 'error', message: 'x', code: 'a_future_code' });
    expect((event as { code: string }).code).toBe('internal');
  });
});

/**
 * The note event under both of its wire names — the reader half of a two-repository rename.
 *
 * The service now sends `note_recorded` (the contract's name); `note_proposed` is the old spelling,
 * still admitted until every deployment has rolled forward, and normalised onto the new one so no
 * surface has to learn both.
 */
describe('the note event is read under both of its wire names', () => {
  const body = { note_id: 'note-suzuki-42', reference: 'agent/notes/suzuki-42' };

  it('reads the name the contract declares', () => {
    const event = normalizeEvent({ type: 'note_recorded', ...body });
    expect(event, 'a `note_recorded` frame is dropped').not.toBeNull();
    expect(event).toEqual({ type: 'note_recorded', ...body });
  });

  it('reads the old name, as the same event', () => {
    const event = normalizeEvent({ type: 'note_proposed', ...body });
    expect(event, 'the old name was dropped while deployments may still send it').not.toBeNull();
    expect(event).toEqual({ type: 'note_recorded', ...body });
  });

  it('reads the name off the SSE event line when the payload carries no type', () => {
    expect(normalizeEvent(body, 'note_recorded')).toEqual({ type: 'note_recorded', ...body });
    expect(normalizeEvent(body, 'note_proposed')).toEqual({ type: 'note_recorded', ...body });
  });

  it('still refuses a name neither side has ever sent', () => {
    // The tolerance is for one argued rename, not for anything that looks like it.
    expect(normalizeEvent({ type: 'note_recorded_v2', ...body })).toBeNull();
    expect(normalizeEvent({ type: 'note_written', ...body })).toBeNull();
  });
});
