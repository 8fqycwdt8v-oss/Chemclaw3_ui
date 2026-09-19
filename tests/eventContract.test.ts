import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EVENT_FIELDS, normalizeEvent } from '../shared/events.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import { clientEventTypes } from './backendContract.ts';

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
    awaiting_answer: { request_id: 'await-1' },
    capability_degraded: { connectors: ['eln'] },
    tool_failed: { tool: 'find_notes', message: 'boom' },
    tool_result: { tool: 'find_notes', preview: 'x' },
    evidence_source: { source: 'graph', chunks: 4 },
    handoff: { from_agent: 'default', to_agent: 'safety', reason: 'hazard check' },
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
// default it would fall back to. Transcribed from `src/chemclaw/api/events.py`; when the backend
// adds a field, it is added here in the same change, and this is the assertion that makes
// "same change" mean something.
const full: Array<[string, Record<string, unknown>]> = [
  // Deliberately present with an empty frame rather than omitted. It declares no fields today, so
  // the value-for-value test has nothing to assert — but a field added to `QueuedEvent` later is
  // exactly the case this fixture exists to catch, and an absent member cannot catch it. Found by
  // the declaration check below on its first run.
  ['queued', {}],
  ['plan', { todos: ['step one'], plan_hash: 'abc123' }],
  ['tool_call', { tool: 'find_notes', arguments: '{"q":1}', agent: 'safety' }],
  // `agent` is load-bearing on this one: the backend stamps every token with it and says a
  // consumer "concatenates only the unattributed ones", so a dropped field here splices a
  // subagent's working notes into the answer.
  ['token', { text: 'hello', agent: 'subagent' }],
  ['job_started', { job_id: 'j1', kind: 'qm', plan_step: 'run the conformer search' }],
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
  ['tool_failed', { tool: 'submit_qm_job', message: 'refused', reason: 'plan_gate', agent: 'x' }],
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
});

/**
 * And the fixture above covers every field the union declares — checked against the source.
 *
 * The two tests above are only as good as `full`, and `full` is written by hand. That is the same
 * weakness one level up that let three fields go missing in the first place: `EVENT_TYPES` was the
 * gate, `EVENT_TYPES` was written by hand, and prose in a docstring asking people to remember did
 * not hold for six members and then for three fields.
 *
 * So the fixture is checked against the *declarations* rather than trusted — and the declarations
 * are now the schemas themselves (`EVENT_FIELDS`), which is the honest version of what this used to
 * do with the compiler API. Every field of every member must appear in `full`, and the two tests
 * above then prove `normalizeEvent` actually *carries* it rather than defaulting it.
 *
 * What changed under this, and it is most of the reason F5 was worth doing: "adding a field to an
 * interface and nowhere else" is no longer a thing that can happen. The interface and the decoder
 * are one object. The remaining risk this guards is the other one — a field declared and then
 * *defaulted away* by a wrong fallback — which a fixture carrying a distinguishable value is the
 * only way to see.
 *
 * What this closes and what it does not: it makes this repository unable to gain a field in the
 * mirror without proving the normaliser preserves it. It cannot see the service, so a field added
 * *there* and never mirrored here is still invisible to this suite — that half is
 * `Chemclaw3`'s `tests/test_event_contract.py`, which fails on the side that makes the change and
 * names this file.
 */
/**
 * `shared/events.ts` parsed with the TypeScript compiler API — the same compiler that type-checks
 * it, so there is no second idea of what the file says.
 *
 * Still here for `ErrorCode`, and **only** for it. It used to read the `ChemclawEvent` members'
 * fields as well, by finding each interface in the union and listing its property signatures.
 * There are no interfaces any more: every member is a `valibot` schema and its type is
 * `v.InferOutput` of that schema, so "what does this member declare" has an answer at runtime —
 * `EVENT_FIELDS` — and parsing the file to ask it would be re-deriving a basis that is now
 * observable. `ErrorCode` is a hand-written union with a hand-written runtime list beside it, so
 * the walk below is still the only way to read the half that has no runtime existence.
 *
 * Repo-root relative, as `tests/delivery.test.ts` reads the Jenkinsfile: vitest runs from the root,
 * and `import.meta.url` is not a file: URL under this environment.
 */
const eventsSource = (): ts.SourceFile =>
  ts.createSourceFile(
    'shared/events.ts',
    readFileSync('shared/events.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

/**
 * Every member of `ChemclawEvent`, as `discriminator -> declared field names`.
 *
 * Read off the schemas rather than parsed out of the source. The question this used to answer with
 * forty lines of compiler API — "is there a field in the interface that the normaliser does not
 * carry?" — has no answer any more, because there is no interface for a field to be in: the
 * normaliser IS the declaration. What is left worth asserting is the half below it, that the
 * fixture populates every declared field, and that needs the list rather than the parse.
 */
const declaredMembers = (): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map([...EVENT_FIELDS].map(([type, fields]) => [type, new Set(fields)]));

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
 * The gate and the union are one vocabulary, and this file was reading only one of them.
 *
 * `shared/events.ts` states the rule as **`EVENT_TYPES` is the gate**, and everything above takes
 * its subject from the *interface union* instead: `declaredMembers()` parses `ChemclawEvent` with
 * the compiler API and the fixture is checked against that. The two lists are not the same list.
 * Measured: `'fake_event'` added to `EVENT_TYPES` — admitted by `normalizeEvent` at runtime, with
 * no interface and no branch — produced **zero** failures in this file.
 *
 * The direction that costs events is held (dropping a name from `EVENT_TYPES` reds the
 * round-trips above with no backend checkout at all), so what this closes is the other one: dead
 * names accumulating in the gate, which is where the `handoff` mirror came from — a consumer chain
 * for an event nothing could send.
 *
 * The one name that is legitimately in the gate without an interface of its own is an **alias**: a
 * second wire spelling that normalises onto a declared member, which is what a two-repository
 * rename needs. So aliases are permitted and *pinned* — a new one is a deliberate edit here, not a
 * line in a set literal that nobody has to explain.
 */
describe('the runtime gate and the interface union are one vocabulary', () => {
  /** What the gate admits, read off `EVENT_TYPES` — the same reader the contract check uses. */
  const gate = (): string[] => clientEventTypes();

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
    // a two-repository rename in progress and needs the argument that goes with one.
    expect(
      aliases,
      'a wire name normalising onto another event — argue it in shared/events.ts and in ' +
        "tests/backendContract.test.ts's RETAINED_FOR_ROLLOUT / AHEAD_OF_BACKEND, then pin it here",
    ).toEqual(['note_recorded -> note_proposed']);
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
 * `ErrorCode` (the type) and `ERROR_CODES` (the runtime set) are two hand-maintained lists of the
 * same vocabulary, and nothing bound them to each other.
 *
 * **What the drift costs is specific, not cosmetic.** `normalizeEvent` gates on `ERROR_CODES` and
 * maps anything absent to `internal`. So a code added to the union and forgotten in the set does
 * not merely lose its copy — it arrives as `internal`, which is **not** in
 * `PARTIAL_ANSWER_CODES`, so `streamTurn` treats it as terminal and throws. That runs the
 * `finally`, whose `reader.cancel()` the BFF turns into a destroyed upstream request and FastAPI
 * into a client disconnect: the backend's turn is cancelled before it records the transcript, and
 * the partial answer is lost from the screen *and* from the stored conversation.
 *
 * That is exactly the failure `spend_cap_reached` was added to `PARTIAL_ANSWER_CODES` to prevent,
 * reachable again through a one-line omission in a different file. Both lists happened to be
 * updated together when that code arrived; nothing would have noticed if they had not been.
 *
 * Parsed with the compiler API rather than imported, because the *type* has no runtime existence —
 * importing `ERROR_CODES` proves only what the set holds, and the union is the half a reader edits
 * first.
 */
describe('the error-code union and its runtime set are one vocabulary', () => {
  /** The `ErrorCode` union's string members, read off the declaration. */
  const unionMembers = (): Set<string> => {
    const file = eventsSource();
    for (const statement of file.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== 'ErrorCode') continue;
      if (!ts.isUnionTypeNode(statement.type)) {
        throw new Error('ErrorCode is no longer a union; this check needs updating');
      }
      const members = new Set<string>();
      for (const node of statement.type.types) {
        // **Loud on anything that is not a string literal, rather than skipping it.** A `continue`
        // here reads as harmless and is the one thing that would quietly hollow this test out: an
        // ordinary refactor — extracting three codes into `type TimeoutCode = 'a' | 'b' | 'c'` and
        // writing `ErrorCode = 'internal' | TimeoutCode | …` — leaves the alias unresolved, so
        // those three go unchecked while the test still passes. That is precisely the change a
        // maintainer reaches for when adding a `PartialAnswerCode` alias, i.e. the moment this
        // check matters most.
        //
        // Resolving type references would mean a type *checker* rather than a parse, and the
        // cheaper honest answer is to refuse: whoever writes that alias sees this message and
        // teaches the test about it deliberately.
        if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
          throw new Error(
            `ErrorCode member \`${node.getText(file)}\` is not a string literal, so this check ` +
              'cannot see the codes behind it. Inline it, or teach unionMembers to resolve it — ' +
              'silently skipping it would leave those codes unverified.',
          );
        }
        members.add(node.literal.text);
      }
      return members;
    }
    throw new Error('no ErrorCode declaration found in shared/events.ts');
  };

  it('every code the type declares is one the normaliser will actually accept', () => {
    const declared = unionMembers();
    expect(declared.size).toBeGreaterThan(5);

    // Round-tripped through `normalizeEvent` rather than compared against an imported constant:
    // what matters is not that two lists match but that a declared code *survives normalisation*,
    // which is the property the failure above turns on.
    for (const code of declared) {
      const event = normalizeEvent({
        type: 'error',
        message: 'x',
        code,
        retryable: false,
        correlation_id: 'c1',
      });
      expect(event, `normalizeEvent dropped the ${code} event entirely`).not.toBeNull();
      expect(
        (event as { code: string }).code,
        `'${code}' is declared in the ErrorCode union but missing from ERROR_CODES, so it ` +
          `normalises to 'internal' — and 'internal' is not in PARTIAL_ANSWER_CODES, so a turn ` +
          `carrying it would be cancelled and its partial answer lost`,
      ).toBe(code);
    }
  });
});

/**
 * The note event under both of its names — the reader half of a two-repository rename.
 *
 * The service emits `note_proposed` for an event that is not a proposal, and says so in its own
 * model docstring: nothing reviews a note any more, so the accurate name is `note_recorded`. An
 * SSE discriminator is a contract two repositories switch on, and there is exactly one ordering
 * with no broken state — the reader accepts both names first, the emitter changes afterwards.
 * Done the other way round, every browser that has not been redeployed drops the event silently,
 * which is the failure this file exists to end.
 *
 * Both directions are driven here because "accepts both" is two claims, and the old one is the
 * one a careless rename would take away: every browser in the field speaks it today.
 */
describe('the note event is read under both of its wire names', () => {
  const body = { note_id: 'note-suzuki-42', reference: 'agent/notes/suzuki-42' };

  it('reads the name the service sends today', () => {
    const event = normalizeEvent({ type: 'note_proposed', ...body });
    expect(event, 'the name in production was dropped').not.toBeNull();
    expect(event).toEqual({ type: 'note_proposed', ...body });
  });

  it('reads the name the service is moving to, as the same event', () => {
    const event = normalizeEvent({ type: 'note_recorded', ...body });
    expect(event, 'a `note_recorded` frame is dropped, so the rename would lose it').not.toBeNull();
    // Normalised onto the internal name, so no surface has to learn the second spelling and none
    // can miss it: the trace row, the entity rail and the turn summary all key on `note_proposed`.
    expect(event).toEqual({ type: 'note_proposed', ...body });
  });

  it('reads the new name off the SSE event line when the payload carries no type', () => {
    // The service sets both the `event:` name and the JSON `type`; this is the half that survives
    // a frame whose body was written by something older, and it is the path `src/lib/sse.ts` uses
    // as its fallback. A tolerance that only covered the JSON field would be half a tolerance.
    const event = normalizeEvent(body, 'note_recorded');
    expect(event).toEqual({ type: 'note_proposed', ...body });
  });

  it('still refuses a name neither side has ever sent', () => {
    // The point of the two names is tolerance of one specific, argued rename — not of anything
    // that looks like it. Without this, "accepts both" and "accepts everything" are the same test.
    expect(normalizeEvent({ type: 'note_recorded_v2', ...body })).toBeNull();
    expect(normalizeEvent({ type: 'note_written', ...body })).toBeNull();
  });
});
