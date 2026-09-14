/**
 * The wire contract, from the consumer's side, against what the service actually declares.
 *
 * Both halves of this contract live in two repositories, and until now only one of them was
 * checked anywhere. The service has its own tests; this repo has its own tests; nothing compared
 * the two. `shared/events.ts` carries the bill in its header — six events shipped upstream and
 * were silently dropped here, each one an event whose whole job was to *qualify* what the agent
 * had just said, so a degraded answer rendered as a confident one. `server/routes.ts` carries the
 * other half: `/jobs`, `/proposals` and `/profiles` sat outside the whitelist for months looking
 * like decisions while being implemented, tested routes this UI simply could not reach.
 *
 * `scripts/check-openapi.mjs` is the existing answer and it is the right check with the wrong
 * prerequisite: it needs a running service, so no pipeline has ever run it — the backend's own
 * `D-2026-09-07-a-contract-check-that-cannot-reach-the-contract` records that it was fetching a
 * 404 from a route that did not exist yet, and its own honest signal ("this check did not run")
 * read as a mistyped URL. This file needs no service: the contract is *declared* in Python source
 * that is on disk beside this checkout.
 *
 * ## The five axes, and which direction fails
 *
 * Every axis is asymmetric, and getting the asymmetry right is most of the value:
 *
 *  1. **The BFF whitelist against the routes the service registers.** A whitelist entry with no
 *     route upstream is a dead button and fails. A route the whitelist omits is usually a
 *     decision, so it is listed rather than failed — except the three this UI must never forward,
 *     which are asserted in both directions.
 *  2. **Every event the service declares must survive `normalizeEvent`.** This is the direction
 *     that has failed six times. The other direction — a name this client admits and the service
 *     does not send — is dead code, and fails too *unless* it is argued in `AHEAD_OF_BACKEND`,
 *     which is what a deliberate two-repo rename needs to be able to land on this side first.
 *  3. **Every field `normalizeEvent` reads must be declared on the model that sends it.** A
 *     renamed field is the drift no name-level check can see: the client goes on reading the old
 *     key, `asString` fills in `''`, and a chemist reads a confident blank. The other direction —
 *     a field the service sends and this client ignores — is a feature nobody surfaced yet, and
 *     is listed.
 *  4. **Every closed set this client mirrors.** `ErrorCode`, `RefusalReason` and `AnswerCheck` are
 *     `Literal`s upstream and narrowing filters here, so a member added upstream does not arrive
 *     as an unknown value — it arrives as `internal`, as `null`, or as a check that did not run.
 *     Probed through `normalizeEvent` rather than read off a list, because the filter is the thing
 *     that has to know.
 *  5. **What this client sends.** Every path it requests must be a route the service registers and
 *     one the BFF forwards; every key in every JSON body must be a field of that route's request
 *     model, and every *required* field of that model must be in the body. Six of those models are
 *     `extra="forbid"`, so a stale key there is a 422 rather than a silent drop.
 *
 * ## What this cannot check, and therefore does not claim
 *
 *  - **Response shapes.** The client's TypeScript interfaces for what it reads back
 *    (`SessionSummary`, `TranscriptMessage`, `NoteView`, …) are not compared to the models the
 *    handlers return. The mapping is not mechanical — one handler returns `list[SessionSummaryOut]`
 *    where the client reads a page plus a header — and a check that guessed it would produce
 *    confident findings about a pairing it invented. `tests/contractDrift.test.tsx` covers the
 *    three fields this has actually cost so far, by driving them. Recorded in `ISSUES.md`.
 *  - **Semantics.** That `plan_hash` is the hash of the plan shown, that `preview` is 200
 *    characters, that a 409 means what this client says it means — none of that is in a
 *    declaration.
 *  - **Query parameters.** Dropped from every template on both sides.
 *  - **The BFF's own routes.** `/api/client-events` has no upstream; `src/lib/logger.ts` is out of
 *    scope by name in the reader, not by accident.
 *  - **Anything at all, when the checkout is absent.** The suite then says so rather than passing.
 */

import { describe, expect, it } from 'vitest';
import { ROUTES } from '../server/routes.ts';
import { normalizeEvent } from '../shared/events.ts';
import {
  backendCheckout,
  backendEvents,
  backendRoutes,
  backendSearchPath,
  clientEventTypes,
  clientRequests,
  literalMembers,
  modelFields,
  normalizeEventReads,
  normalizeTemplate,
  requestModelOf,
  whitelistTemplate,
} from './backendContract.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = backendCheckout();

/**
 * A wire name this client admits that the checked-out service does not declare, with its argument.
 *
 * Two maps below hold names in exactly that state, and no check can tell them apart: a name the
 * service has *not yet* declared and one it *no longer* declares are the same absence. What
 * differs is what ends the entry, and that is the whole reason there are two — an entry waiting on
 * somebody else's deploy is a different promise from one waiting on this repository's own users.
 */
interface Argued {
  /**
   * Why this client admits a name the service does not declare.
   *
   * Never empty, and that is asserted below. An entry is the one thing that turns this file's
   * strictest failure into a pass, so a map whose entries need no argument is a map in which this
   * client may admit anything it likes — which it was: `['fake_event', '']` satisfied "argued".
   */
  reason: string;
  /**
   * A phrase that occurs in `ISSUES.md`, naming the row that tracks the step which removes this.
   *
   * The expiry that is not a date. Closing an issue in this repository means deleting its row, so
   * the row going away fails the entry that pointed at it — a reason on its own expires only when
   * somebody happens to re-read it.
   */
  issue: string;
  /**
   * The date by which somebody re-takes this decision, `YYYY-MM-DD`.
   *
   * Past is a **failure**, not a warning, and deliberately: the harm an entry of this kind does is
   * that it is quiet, and a backwards-compatibility window nobody has re-taken in a quarter is the
   * shape this repository keeps finding written down and believed. The failure names both ways
   * out — remove the name because the window is over, or move the date and say why.
   */
  review: string;
}

/**
 * Names this client admits *before* the service declares them — the reader landing first.
 *
 * Empty is the normal state, and it is empty: `note_recorded` sat here for W30.2 and the service
 * has since shipped it (`src/chemclaw/api/events.py` declares
 * `type: Literal["note_recorded"]`), so it is an ordinary name now and needs no argument.
 */
const AHEAD_OF_BACKEND = new Map<string, Argued>([]);

/**
 * Names this client admits *after* the service has stopped declaring them — the old spelling, kept
 * until every browser in the field has been redeployed.
 *
 * This state had nowhere to be recorded, and that was a defect rather than an omission. The moment
 * the service shipped the rename, the old name became "dead code" by this file's own failure
 * message, and the only mechanical remedy that message offered was to delete it — which is Issue
 * 13's step 3 performed before step 2 has rolled out, the ordering that repository says loses the
 * event in every tab that has not reloaded. A retained name is a first-class state here, held to
 * the same argued-entry discipline as one that is ahead.
 */
const RETAINED_FOR_ROLLOUT = new Map<string, Argued>([
  [
    'note_proposed',
    {
      reason:
        'Issue 13 step 3. The service renamed this event to `note_recorded` and no longer ' +
        'declares the old spelling; its own model docstring says the step that drops the old ' +
        'name from this reader "is theirs and happens after this ships". Every browser already ' +
        'loaded speaks the old name, so this client keeps reading it until that rollout is done. ' +
        'Removal takes the `note_proposed` entry in `EVENT_TYPES`, the fall-through case in ' +
        '`normalizeEvent`, and the internal rename with it.',
      issue: 'the note event is renamed in two repositories',
      review: '2026-12-31',
    },
  ],
]);

/** Both maps as one lookup: the filter below cannot tell "not yet" from "no longer", and the
 *  distinction is about who unblocks the removal, not about what this client accepts. */
const ARGUED = new Map<string, Argued>([...AHEAD_OF_BACKEND, ...RETAINED_FOR_ROLLOUT]);

/**
 * The names in an argued map that the checked-out service *does* declare.
 *
 * A function, and called from a describe body rather than from inside an `it`, because the
 * consequence is a notice and a notice placed after an assertion is not one: the first edition put
 * the "step 3 is unblocked" line after `expect(unsent).toEqual([])` in the same test, so on the
 * day the service renamed — the only day the line had anything to say — the assertion threw and it
 * never printed. Observed, not reasoned about.
 */
function stillDeclared(map: Map<string, Argued>, sent: ReadonlySet<string>): string[] {
  return [...map.keys()].filter((type) => sent.has(type));
}

/**
 * The shortest thing that can be called an argument for admitting a name.
 *
 * A number rather than "non-empty" because non-empty is what the first edition effectively had:
 * the map took a bare string and `['fake_event', '']` satisfied it. A word is not an argument;
 * this is the length of a sentence that names what and why.
 */
const MIN_REASON = 40;

/**
 * Everything wrong with an argued map, as a list of strings — one line per defect.
 *
 * A pure function rather than assertions written inline, and the reason is the state these maps
 * are normally in: **empty**. A loop over an empty map passes without checking anything, which is
 * the shape of every test this repository has caught passing with its subject broken. So the
 * validator is driven twice below — over the real maps, where the answer must be nothing, and over
 * a map built to be wrong in every way it can be, where the answer must name each defect. The
 * second run is what makes the first one mean something on the day both maps are empty.
 */
function problems(
  label: string,
  map: Map<string, Argued>,
  issues: string,
  today: string,
  admitted: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [name, entry] of map) {
    const where = `${label}['${name}']`;
    if (entry.reason.trim().length < MIN_REASON) {
      out.push(`${where}: the reason is ${entry.reason.trim().length} characters — argue it`);
    }
    if (entry.issue.trim() === '' || !issues.includes(entry.issue)) {
      out.push(`${where}: no row in ISSUES.md contains "${entry.issue}", so nothing expires this`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.review)) {
      out.push(`${where}: review "${entry.review}" is not a YYYY-MM-DD date`);
    } else if (entry.review < today) {
      out.push(
        `${where}: review date ${entry.review} has passed — remove the name because the window is` +
          ' over, or move the date and say why in the reason',
      );
    }
    if (!admitted.has(name)) {
      out.push(
        `${where}: this client does not admit '${name}' at all, so the entry is bookkeeping`,
      );
    }
  }
  return out;
}

/**
 * The argued maps hold the one thing that can turn this file's strictest failure into a pass, so
 * what an entry costs to write is the whole of their integrity — and it cost nothing.
 *
 * Driven, before this: adding `'fake_event'` to `EVENT_TYPES` and `['fake_event', '']` to the map
 * made the suite green. An empty string satisfied "argued", no entry named anything that could
 * retire it, and the only expiry in the design was a `console.log` that could not be reached.
 *
 * This describe needs no sibling checkout — the maps and their discipline are this repository's —
 * so it runs in every CI lane, which is the half of this file that is a gate rather than a
 * warning.
 */
describe('a name this client admits and the service does not is argued, not merely listed', () => {
  const issues = readFileSync(join(process.cwd(), 'ISSUES.md'), 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const admitted = new Set(clientEventTypes());

  it('holds every entry to a reason, a row that can retire it, and a date', () => {
    expect([
      ...problems('AHEAD_OF_BACKEND', AHEAD_OF_BACKEND, issues, today, admitted),
      ...problems('RETAINED_FOR_ROLLOUT', RETAINED_FOR_ROLLOUT, issues, today, admitted),
    ]).toEqual([]);
  });

  it('refuses an empty reason, a dangling row, a passed date and a name nobody admits', () => {
    // The real maps are empty most of the time, so this is what proves the rule above is a rule.
    // Exact equality rather than a count: each line is a different defect, and a check that fired
    // four times for one reason would pass a count and be worthless.
    expect(
      problems(
        'PROBE',
        new Map<string, Argued>([
          ['queued', { reason: '', issue: 'the note event is renamed', review: '2099-01-01' }],
          [
            'answer',
            {
              reason: 'x'.repeat(MIN_REASON),
              issue: 'a row nobody ever wrote into ISSUES.md',
              review: '2020-01-01',
            },
          ],
          ['not_an_event', { reason: 'x'.repeat(MIN_REASON), issue: 'Issue 13', review: 'soon' }],
        ]),
        issues,
        today,
        admitted,
      ),
    ).toEqual([
      "PROBE['queued']: the reason is 0 characters — argue it",
      'PROBE[\'answer\']: no row in ISSUES.md contains "a row nobody ever wrote into ISSUES.md", so' +
        ' nothing expires this',
      "PROBE['answer']: review date 2020-01-01 has passed — remove the name because the window is" +
        ' over, or move the date and say why in the reason',
      'PROBE[\'not_an_event\']: review "soon" is not a YYYY-MM-DD date',
      "PROBE['not_an_event']: this client does not admit 'not_an_event' at all, so the entry is" +
        ' bookkeeping',
    ]);
  });

  it('keeps the two maps disjoint, because a name cannot be both not-yet and no-longer', () => {
    const both = [...AHEAD_OF_BACKEND.keys()].filter((name) => RETAINED_FOR_ROLLOUT.has(name));
    expect(both, 'in both argued maps — the two states are mutually exclusive in time').toEqual([]);
  });
});

if (root === null) {
  describe('the backend contract', () => {
    it('is not checked here, and this run is not evidence about it', () => {
      console.warn(
        `\n  ⚠ backend contract NOT CHECKED — no Chemclaw3 checkout at ${backendSearchPath()}.` +
          `\n    The route whitelist, the SSE event union and every request body this client sends` +
          `\n    went unverified in this run. Set CHEMCLAW3_REQUIRED=1 to make that a failure.\n`,
      );
      expect(
        process.env.CHEMCLAW3_REQUIRED,
        'CHEMCLAW3_REQUIRED=1 was set, so a missing checkout is a failure rather than a skip',
      ).not.toBe('1');
    });
  });
} else {
  const backend = backendRoutes(root);
  const registered = new Set(backend.map((r) => `${r.method} ${normalizeTemplate(r.template)}`));
  const whitelist = ROUTES.map((route) => ({
    method: route.method,
    template: normalizeTemplate(whitelistTemplate(route.target)),
  }));

  describe('the routes the BFF forwards', () => {
    it('are all routes the service registers', () => {
      const dead = whitelist.filter(
        (route) => !registered.has(`${route.method} ${route.template}`),
      );
      expect(
        dead.map((r) => `${r.method} ${r.template}`),
        'whitelisted in server/routes.ts, registered nowhere in the service — each forwards to a 404',
      ).toEqual([]);
    });

    it('are a deliberate subset, and the rest are listed rather than assumed', () => {
      const unforwarded = [...registered].filter(
        (route) => !whitelist.some((entry) => `${entry.method} ${entry.template}` === route),
      );
      // Informational by design — the whitelist is narrower than the service on purpose — but
      // printed on every run, because `/jobs`, `/proposals` and `/profiles` sat in exactly this
      // list for months looking like decisions while being gaps nobody had read.
      console.log(
        `\n  ${unforwarded.length} service route(s) the BFF does not forward:\n` +
          unforwarded.map((route) => `      ${route}`).join('\n'),
      );
      expect(unforwarded.length).toBeGreaterThan(0);
    });

    it('do not include the three this UI has no business reaching', () => {
      // Both directions. If one of these stops being a route the service serves, the exclusion is
      // stale and the comment in `server/routes.ts` naming it is wrong — which is the half a
      // one-directional assertion would let rot.
      for (const excluded of ['GET /metrics', 'GET /schedules', 'GET /openapi.json']) {
        expect(registered.has(excluded), `${excluded} is no longer a service route`).toBe(true);
        expect(
          whitelist.some((entry) => `${entry.method} ${entry.template}` === excluded),
          `${excluded} is forwarded by the BFF`,
        ).toBe(false);
      }
    });
  });

  describe('the SSE event union', () => {
    const events = backendEvents(root);
    const sent = new Set(events.map((event) => event.wire));

    // Both notices are built here, in the describe body, where no assertion can run first. The
    // edition before this one put the second of them after the `expect` two tests below, which is
    // why it printed on every run except the one it was written for.
    const landed = stillDeclared(AHEAD_OF_BACKEND, sent);
    if (landed.length > 0) {
      console.log(
        `\n  ${landed.length} name(s) in AHEAD_OF_BACKEND the service now declares — each is an` +
          ` ordinary name and its entry is bookkeeping that has expired:\n` +
          landed.map((type) => `      ${type}`).join('\n'),
      );
    }
    const unrenamed = stillDeclared(RETAINED_FOR_ROLLOUT, sent);
    if (unrenamed.length > 0) {
      console.log(
        `\n  ${unrenamed.length} name(s) in RETAINED_FOR_ROLLOUT the service still declares — the` +
          ` rename they are retained across has not happened upstream yet, so the retention is` +
          ` not doing anything and its removal is not unblocked:\n` +
          unrenamed.map((type) => `      ${type}`).join('\n'),
      );
    }

    it('is admitted in full by normalizeEvent', () => {
      const dropped = events
        .filter((event) => normalizeEvent({ type: event.wire }) === null)
        .map((event) => `${event.wire} (${event.className})`);
      expect(
        dropped,
        'the service sends these and shared/events.ts drops them on the floor — EVENT_TYPES is the gate',
      ).toEqual([]);
    });

    it('admits nothing the service does not send, unless it is argued', () => {
      const unsent = clientEventTypes().filter((type) => !sent.has(type) && !ARGUED.has(type));
      expect(
        unsent,
        'mirrored here, declared nowhere upstream: dead code, unless it is an argued entry in ' +
          'AHEAD_OF_BACKEND (the service has not declared it yet) or in RETAINED_FOR_ROLLOUT (the ' +
          'service has stopped declaring it and deployed browsers still speak it)',
      ).toEqual([]);
    });

    it('is read field by field off the fields the service declares', () => {
      const reads = normalizeEventReads();
      const wrong: string[] = [];
      const unread: string[] = [];
      for (const event of events) {
        // Not a formality: every loop below iterates this entry, so an event with none would pass
        // both directions by having nothing to compare.
        expect(reads.has(event.wire), `normalizeEvent has no branch for ${event.wire}`).toBe(true);
        // A branch that reads *nothing* while the model carries fields passes both loops below by
        // having nothing to compare, and that is not hypothetical: a fall-through clause looked
        // exactly like one until the reader learned that an empty clause reads what it falls
        // through to. It cost the note event — the one a rename is in flight on — its whole share
        // of this axis, and printed its two fields as ones this client ignores.
        if (event.fields.length > 0) {
          expect(
            (reads.get(event.wire) ?? []).length,
            `normalizeEvent's ${event.wire} branch reads no field at all, while the service ` +
              `declares ${event.fields.length} — either the event renders blank, or this reader ` +
              'is attributing the branch to the wrong name',
          ).toBeGreaterThan(0);
        }
        const declared = new Set(event.fields);
        for (const field of reads.get(event.wire) ?? []) {
          if (!declared.has(field)) wrong.push(`${event.wire}.${field}`);
        }
        const read = new Set(reads.get(event.wire) ?? []);
        for (const field of event.fields)
          if (!read.has(field)) unread.push(`${event.wire}.${field}`);
      }
      expect(
        wrong,
        'normalizeEvent reads these keys and no model on the wire has them — every one renders as an empty default',
      ).toEqual([]);
      if (unread.length > 0) {
        console.log(
          `\n  ${unread.length} field(s) the service sends and this client ignores:\n` +
            unread.map((field) => `      ${field}`).join('\n'),
        );
      }
    });
  });

  describe('the closed sets this client mirrors', () => {
    const literal = (relative: string, name: string): string[] => {
      const members = literalMembers(
        readFileSync(join(root, 'src', 'chemclaw', relative), 'utf8'),
        name,
      );
      expect(members, `${name} is no longer a Literal in ${relative}`).not.toBeNull();
      // Every assertion below is a loop over this list, so an empty one is a test that passes
      // without testing — which is the failure this repository has shipped fifteen times across
      // six waves. Two is the smallest a closed set with a choice in it can be.
      expect((members ?? []).length, `${name} parsed to no members at all`).toBeGreaterThan(1);
      return members ?? [];
    };

    it('carry every error code the service can end a turn with', () => {
      // An unknown code degrades to `internal` rather than dropping the event, which is the right
      // default and is also why this drift is invisible: the banner still renders, saying the
      // least useful of the ten things it could have said. `at_capacity` is the member that
      // arrived this way.
      for (const code of literal('api/events.py', 'ErrorCode')) {
        const parsed = normalizeEvent({ type: 'error', message: 'x', code });
        expect(parsed && 'code' in parsed && parsed.code, `error code ${code}`).toBe(code);
      }
    });

    it('carry every refusal reason the service can attach to a failed tool call', () => {
      // An unrecognised reason normalises to `null` — deliberately, so that an unknown refusal
      // reads as an ordinary failure rather than as a gate this build cannot name. Which means a
      // sixth member upstream silently demotes a *held* call to a *failed* one.
      for (const reason of literal('core/turn_signals.py', 'RefusalReason')) {
        const parsed = normalizeEvent({ type: 'tool_failed', tool: 't', message: 'm', reason });
        expect(parsed && 'reason' in parsed && parsed.reason, `refusal reason ${reason}`).toBe(
          reason,
        );
      }
    });

    it('carry every answer check the service can report having run', () => {
      // `asAnswerChecks` filters, so a third check upstream reads here as that check *not having
      // run* — the safe direction, and the one nothing would ever notice.
      for (const check of literal('agent/verifier.py', 'AnswerCheck')) {
        const parsed = normalizeEvent({ type: 'answer', text: 'a', checks_run: [check] });
        expect(
          parsed && 'checks_run' in parsed && parsed.checks_run,
          `answer check ${check}`,
        ).toEqual([check]);
      }
    });
  });

  describe('what this client sends', () => {
    const requests = clientRequests();

    it('goes to routes the service registers', () => {
      const unknown = requests
        .filter((request) => !registered.has(`${request.method} ${request.template}`))
        .map(
          (request) => `${request.method} ${request.template} (${request.file}:${request.line})`,
        );
      expect(unknown, 'this client requests these and the service registers no such route').toEqual(
        [],
      );
    });

    it('goes through routes the BFF forwards', () => {
      const blocked = requests
        .filter(
          (request) =>
            !whitelist.some(
              (entry) => entry.method === request.method && entry.template === request.template,
            ),
        )
        .map(
          (request) => `${request.method} ${request.template} (${request.file}:${request.line})`,
        );
      expect(
        blocked,
        'this client requests these and the BFF whitelist refuses them — a 404 from its own proxy',
      ).toEqual([]);
    });

    it('sends only keys the route declares, and every key it requires', () => {
      const undeclared: string[] = [];
      const missing: string[] = [];
      let checked = 0;
      for (const request of requests) {
        if (request.bodyKeys === null) continue;
        const route = backend.find(
          (candidate) =>
            candidate.method === request.method &&
            normalizeTemplate(candidate.template) === request.template,
        );
        if (!route) continue; // already failed above, with a better message
        const model = requestModelOf(root, route);
        const fields = model === null ? null : modelFields(root, model);
        expect(
          fields,
          `${route.method} ${route.template} takes a body this reader cannot find`,
        ).not.toBeNull();
        if (!fields) continue;
        checked += 1;
        const declared = new Set(fields.map((field) => field.name));
        for (const key of request.bodyKeys) {
          if (!declared.has(key))
            undeclared.push(`${model}.${key} (${request.file}:${request.line})`);
        }
        for (const field of fields) {
          if (field.required && !request.bodyKeys.includes(field.name)) {
            missing.push(`${model}.${field.name} (${request.file}:${request.line})`);
          }
        }
      }
      expect(
        undeclared,
        'sent by this client, declared by no model upstream — six of them are extra="forbid", so this is a 422',
      ).toEqual([]);
      expect(missing, 'required upstream and absent from the body this client builds').toEqual([]);
      // A count, because the interesting failure of this assertion is it checking nothing: the
      // reader finds bodies by shape, and a refactor that spells one differently would empty the
      // loop silently.
      expect(checked, 'no request body was checked at all — the reader found none').toBeGreaterThan(
        5,
      );
    });
  });
}
