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
 * ## The axes, and which direction fails
 *
 * Every axis is asymmetric, and getting the asymmetry right is most of the value:
 *
 *  1. **The BFF whitelist against the routes the service registers.** A whitelist entry with no
 *     route upstream is a dead button and fails. A route the whitelist omits is usually a
 *     decision, so it is listed rather than failed — except the three this UI must never forward,
 *     which are asserted in both directions.
 *  2. **Every event the service declares must survive `normalizeEvent`.** This is the direction
 *     that has failed six times. The other direction — a name this client admits and the service
 *     does not send — is dead code, and fails too *unless* it is argued, which a two-repository
 *     rename needs at *both* ends of its skew window: `AHEAD_OF_BACKEND` for a reader that landed
 *     first, `RETAINED_FOR_ROLLOUT` for an old spelling kept until deployed browsers have
 *     reloaded. An entry costs a reason, an `ISSUES.md` row whose deletion retires it, and a date.
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
 *  6. **What it reads back.** Every route annotates its return, so the model is readable route by
 *     route. This client declares the wire shape where it casts the body (`request<PlanStatusOut>`)
 *     and reshapes after that, so the declaration is the model's own name: a property declared here
 *     and sent by nobody fails, and a field sent and not declared fails unless `NOT_READ` argues it.
 *     A call that reads a route answering one readable model and casts it to anything else fails
 *     too (`undeclaredReads`), so an unpaired response is a red build rather than a quiet skip.
 *
 * ## What this cannot check, and therefore does not claim
 *
 *  - **Below the top level of a response.** Axis 6 compares the fields of the model a route
 *    returns; an element type inside it (`ProposalsOut.proposals`' `ProposalOut`) is compared only
 *    where some route returns that element by name too. A response that is not one model —
 *    `dict[str, str]`, `list[str]`, a bare `Response` — is printed, not compared.
 *    `tests/contractDrift.test.tsx` still drives the three fields this has actually cost. Recorded
 *    in `ISSUES.md` Issue 14.
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
  checkoutRequired,
  checkoutRoots,
  clientEventTypes,
  clientRequests,
  literalMembers,
  modelFields,
  normalizeEventReads,
  clientInterfaceFields,
  normalizeTemplate,
  pydanticFields,
  requestModelOf,
  responseModelOf,
  returnAnnotationOf,
  whitelistTemplate,
} from './backendContract.ts';
import type { BackendRoute, ClientRequest } from './backendContract.ts';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * The two maps do different things with that answer, and the difference is what unblocks the
 * removal. For `RETAINED_FOR_ROLLOUT` it is a **notice**, printed from the describe body rather
 * than from inside an `it`, because a notice placed after an assertion is not one: the first
 * edition put the "step 3 is unblocked" line after `expect(unsent).toEqual([])` in the same test,
 * so on the day the service renamed — the only day the line had anything to say — the assertion
 * threw and it never printed. Observed, not reasoned about.
 *
 * For `AHEAD_OF_BACKEND` it is an **assertion**, because that map's end-state is mechanical: the
 * service declaring the name is the whole of it, it is written in the declaration this file
 * already reads, and the remedy is deleting an entry that by then exempts a name needing no
 * exemption. Nothing has to roll out first, so leaving that to the `review` date meant an expired
 * entry could stand for up to a whole window with only a `console.log` noticing.
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
 * The names two argued maps hold in common.
 *
 * Hoisted out of its assertion for the same reason `problems()` is, and it is the same defect: the
 * check shipped as a filter written inline over `AHEAD_OF_BACKEND`, which is empty, so its whole
 * body could be replaced by `const both: string[] = []` with the file still reading 15 passed —
 * driven, before this. A filter over an empty map answers `[]` whatever the predicate does, so the
 * predicate is driven over a pair built to overlap and a pair built not to.
 */
function inBoth(a: Map<string, Argued>, b: Map<string, Argued>): string[] {
  return [...a.keys()].filter((name) => b.has(name));
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
    //
    // Against a literal document rather than the real `ISSUES.md`, and that is not tidiness. This
    // probe used to borrow two phrases from the live Issue 13 row — the row whose deletion is the
    // *designed* retirement path for the entry in `RETAINED_FOR_ROLLOUT`. Driven: deleting that
    // row failed the test above, correctly, **and** this one, with a 7-versus-5 diff about a
    // fixture. On the one day the control fires, the second red is noise pointing at the wrong
    // file. A probe of the validator supplies its own inputs; only the run above reads the tree.
    //
    // All four of them, which took a second pass: the first edition wrote its own document and
    // then handed the validator the live `admitted` set and the real clock. Driven — dropping
    // `queued` from `EVENT_TYPES` reds this probe with a 6-versus-5 diff, on top of the two
    // failures that are the point, and the same would happen to any run on 2099-01-02. Neither
    // has anything to do with the validator.
    const probeIssues = '## Issue 0: a row this probe points at, and nothing else reads\n';
    const probeAdmitted = new Set(['queued', 'answer']);
    const probeToday = '2026-06-01';
    expect(
      problems(
        'PROBE',
        new Map<string, Argued>([
          ['queued', { reason: '', issue: 'a row this probe points at', review: '2099-01-01' }],
          [
            'answer',
            {
              reason: 'x'.repeat(MIN_REASON),
              issue: 'a row nobody ever wrote into ISSUES.md',
              review: '2020-01-01',
            },
          ],
          ['not_an_event', { reason: 'x'.repeat(MIN_REASON), issue: 'Issue 0', review: 'soon' }],
        ]),
        probeIssues,
        probeToday,
        probeAdmitted,
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

  it('names an argued entry the service has caught up with, and only that entry', () => {
    // `stillDeclared` is the predicate behind the one assertion in this file that fails an
    // `AHEAD_OF_BACKEND` entry the service has since declared — and both argued maps are normally
    // empty, so that assertion answers `[]` whatever the predicate does. Driven, before this:
    // replacing the body with `return []` left the file reading 16 passed. It is the same defect
    // `inBoth` below was hoisted out of its assertion for, one `it` later.
    //
    // Both inputs are literals: the map is built to be stale, and the set of names the service
    // declares is written here rather than read out of a checkout, so this runs in every lane and
    // nothing about the sibling repository can move it.
    const entry: Argued = {
      reason: 'x'.repeat(MIN_REASON),
      issue: 'Issue 13',
      review: '2099-01-01',
    };
    const declared: ReadonlySet<string> = new Set(['answer', 'queued']);
    expect(
      stillDeclared(
        new Map<string, Argued>([
          ['answer', entry],
          ['not_an_event', entry],
        ]),
        declared,
      ),
      'the service declares `answer`, so that entry is expired bookkeeping; it declares no ' +
        '`not_an_event`, so that one is still doing its job',
    ).toEqual(['answer']);
    expect(stillDeclared(new Map<string, Argued>([['not_an_event', entry]]), declared)).toEqual([]);
  });

  it('keeps the two maps disjoint, because a name cannot be both not-yet and no-longer', () => {
    expect(
      inBoth(AHEAD_OF_BACKEND, RETAINED_FOR_ROLLOUT),
      'in both argued maps — the two states are mutually exclusive in time',
    ).toEqual([]);

    // The maps are normally empty, so the line above is `[]` for reasons that have nothing to do
    // with the predicate. These two are what make it an assertion about overlap.
    const entry: Argued = {
      reason: 'x'.repeat(MIN_REASON),
      issue: 'Issue 13',
      review: '2099-01-01',
    };
    const ahead = new Map<string, Argued>([['queued', entry]]);
    expect(
      inBoth(
        ahead,
        new Map([
          ['queued', entry],
          ['answer', entry],
        ]),
      ),
    ).toEqual(['queued']);
    expect(inBoth(ahead, new Map([['answer', entry]]))).toEqual([]);
  });
});

/**
 * What a response interface declares that its model does not, and the other way round.
 *
 * A pure function for the reason every other predicate in this file is one: the pairs it runs over
 * are the ones where this client declares the wire shape *by name*, and every one of them agrees
 * today — so the loop that calls it is satisfied by any body at all. The probe below
 * is what makes its run over the real trees mean something.
 *
 * The asymmetry is the same as the event axis's, and for the same reason. A property this client
 * declares and the model does not send arrives `undefined` and renders as a confident blank, so it
 * **fails**; a field the model sends and this client does not declare is a surface nobody built
 * yet, so it is listed.
 */
export function responseDrift(
  model: string,
  declaredHere: readonly string[],
  sentUpstream: readonly string[],
): { wrong: string[]; unread: string[] } {
  const sent = new Set(sentUpstream);
  const read = new Set(declaredHere);
  return {
    wrong: declaredHere.filter((field) => !sent.has(field)).map((field) => `${model}.${field}`),
    unread: sentUpstream.filter((field) => !read.has(field)).map((field) => `${model}.${field}`),
  };
}

/**
 * Response fields the service sends that this client deliberately does not declare, and why.
 *
 * It was empty, and that was the point at which a ratchet is cheapest to fit: the two entries that
 * would have been here (`Digest.disputed`, `Digest.headlines`) were both fields the UI had a surface
 * for, and both are read now. The two it holds arrived with the envelopes being paired at all. An entry is a sentence, not a name — "not needed" is not a reason anybody
 * can check a year later.
 *
 * **A field from a route whose read is a destructive claim may not be exempted at all.**
 * `GET /digests` and `GET /check-ins` consume the rows they return, so a field dropped there is
 * gone rather than deferred: there is no later read to pick it up, and "a note for later" is a
 * description of a field that can be fetched again.
 */
const NOT_READ: Record<string, string> = {
  // Both found the day `listProtocols` stopped declaring its envelope inline (`ISSUES.md` Issue 14):
  // the service added them because a site with more designs than the page "rendered the newest 50
  // as the corpus", and this client unwraps to an array and draws exactly that. Not read here
  // because saying so is copy on `ProtocolsPanel` — whether "50 of 212" or a nudge to filter — and
  // that is a surface decision, not a contract one. Deleting both lines is the whole fix once it is.
  'DesignListOut.total':
    'the protocols panel has no copy for a short listing yet; recorded in ISSUES.md Issue 14',
  'DesignListOut.truncated':
    'the protocols panel has no copy for a short listing yet; recorded in ISSUES.md Issue 14',
};

/**
 * Calls that read a route whose answer is one model the service declares, and do not declare that
 * model at the point the body is cast.
 *
 * The other half of Issue 14's second bullet, and the half that makes the first one stick. Reading
 * the declaration at the cast (`ClientRequest.responseType`) is what lets an envelope-unwrapping
 * function be compared at all — but a call that casts to an inline `{ proposals: X[] }` still
 * declares no model, and the pairing would drop it as silently as before. So a `null` against a
 * readable model is not a quiet pass any more: it is a read of a declared shape this client has
 * written no name for, and it fails. Pure, so it can be driven over calls built to be wrong.
 */
export function undeclaredReads(
  requests: readonly ClientRequest[],
  modelOf: (request: ClientRequest) => string | null,
): string[] {
  return requests.flatMap((request) => {
    const model = modelOf(request);
    if (model === null || request.responseType === model) return [];
    return [
      `${request.method} ${request.template} answers ${model}; ` +
        `${request.file}:${request.line} declares ${request.responseType ?? 'no model'}`,
    ];
  });
}

describe('the wire shape is read where the body is cast, not where the function returns', () => {
  // Built to be the shape Issue 14 named: a function that unwraps an envelope, so what it *returns*
  // is not the wire. The declaration this reader now reads is the type argument at the cast.
  const unwrapping = (cast: string, iface: string): Record<string, string> => ({
    'fixture.ts': [
      iface,
      'export interface ProposalOut { name: string }',
      'const api = {',
      '  listProposals(t: TokenGetter): Promise<ProposalOut[]> {',
      `    return request<${cast}>('/proposals', t).then((page) => page.proposals);`,
      '  },',
      '};',
    ].join('\n'),
  });
  const model = (request: ClientRequest): string | null =>
    request.template === '/proposals' ? 'ProposalsOut' : null;

  it('pairs an envelope-unwrapping call with the envelope, and fails a property nobody sends', () => {
    // Misspelled on purpose. Before this, `responseType` was the function's return — `ProposalOut`
    // — so the call paired with nothing, the envelope was never compared, and this passed.
    const source = unwrapping(
      'ProposalsOut',
      'export interface ProposalsOut { proposal: ProposalOut[] }',
    );
    const [call] = clientRequests(source);
    expect(call?.responseType).toBe('ProposalsOut');
    expect(undeclaredReads(clientRequests(source), model)).toEqual([]);
    expect(
      responseDrift('ProposalsOut', clientInterfaceFields('ProposalsOut', source) ?? [], [
        'proposals',
      ]),
    ).toEqual({ wrong: ['ProposalsOut.proposal'], unread: ['ProposalsOut.proposals'] });
  });

  it('fails a call that casts a declared model to an inline shape', () => {
    // The same function with the envelope written inline: no model named anywhere, which the old
    // pairing skipped without a word. It is a read of a shape the service declares, so it fails.
    const source = unwrapping('{ proposals: ProposalOut[] }', '');
    expect(undeclaredReads(clientRequests(source), model)).toEqual([
      'GET /proposals answers ProposalsOut; fixture.ts:5 declares no model',
    ]);
  });

  it('falls back to the enclosing return through an unannotated closure, and not past a cast', () => {
    const source = {
      'fixture.ts': [
        'function upload(): Promise<AttachmentSummary> {',
        '  return new Promise((resolve) => {',
        "    xhr.open('POST', `${base}/sessions/${encodeURIComponent(id)}/attachments`);",
        '  });',
        '}',
        'async function stop(): Promise<boolean> {',
        "  await request<{ stopped: boolean }>('/stop', t);",
        '  return true;',
        '}',
        "const listed = (): Promise<string[]> => orEmpty('/labels', () => request<Row[]>('/rows', t));",
      ].join('\n'),
    };
    expect(
      clientRequests(source).map((call) => [call.method, call.template, call.responseType]),
    ).toEqual([
      ['POST', '/sessions/{}/attachments', 'AttachmentSummary'],
      ['GET', '/stop', null],
      // `orEmpty`'s first argument names the route it degrades and is not a request of its own.
      ['GET', '/rows', 'Row'],
    ]);
  });
});

describe('a computed field is a field on the wire', () => {
  it('reads `@computed_field` properties beside annotated ones, and no other method', () => {
    const source = [
      'class PageOut(BaseModel):',
      '    rows: list[str] = Field(default_factory=list)',
      '',
      '    @computed_field  # type: ignore[prop-decorator]',
      '    @property',
      '    def verdict(self) -> str:',
      '        return "all of it"',
      '',
      '    @field_validator("rows")',
      '    @classmethod',
      '    def _rows(cls, value: list[str]) -> list[str]:',
      '        return value',
    ].join('\n');
    expect(pydanticFields(source, 'PageOut')).toEqual([
      { name: 'rows', required: false },
      { name: 'verdict', required: false },
    ]);
  });
});

describe('the response drift this client can be held to', () => {
  it('fails a property nobody sends and lists a field nobody reads', () => {
    // Both directions and neither empty, because the two real pairs agree today: a loop over them
    // reports `{ wrong: [], unread: [] }` whatever this function does.
    expect(
      responseDrift(
        'SessionSummary',
        ['session_id', 'titel', 'updated_at'],
        ['session_id', 'title', 'updated_at', 'profile'],
      ),
    ).toEqual({
      wrong: ['SessionSummary.titel'],
      unread: ['SessionSummary.title', 'SessionSummary.profile'],
    });
    expect(responseDrift('Digest', ['a', 'b'], ['b', 'a'])).toEqual({ wrong: [], unread: [] });
  });
});

/**
 * Where the checkout is, driven over environments built to be wrong.
 *
 * The suite normally runs with one checkout, at the default path, with no variable set — so every
 * assertion anywhere else in this file exercises exactly one branch of this resolution and would
 * pass with the other three deleted. That is the shape this repository keeps finding: a predicate
 * whose population is one happy value.
 *
 * This describe needs no Chemclaw3 checkout — it builds its own — so it runs in every lane.
 */
describe('the one resolution of where the Chemclaw3 checkout is', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'chemclaw-checkout-'));
  const MARKER = join('src', 'chemclaw', 'api', 'events.py');
  const OTHER_MARKER = join('src', 'chemclaw', 'protocols', 'store.py');
  const plant = (name: string, marker: string): string => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, marker, '..'), { recursive: true });
    writeFileSync(join(dir, marker), '# planted');
    return dir;
  };
  const named = plant('named', MARKER);
  const compose = plant('compose', MARKER);
  const sparse = plant('sparse', OTHER_MARKER);

  it('prefers the variable a lane sets to the one a developer sets', () => {
    expect(backendCheckout(MARKER, { CHEMCLAW3_DIR: named, CHEMCLAW_REPO: compose })).toBe(named);
  });

  it('resolves the variable README.md and docker-compose.yml document', () => {
    // The whole of this fix: this arm used to resolve to nothing here and to a checkout in
    // `tests/protocolStatusTransitions.test.ts`, which is one question with two answers.
    expect(backendCheckout(MARKER, { CHEMCLAW_REPO: compose })).toBe(compose);
  });

  it('falls back to the sibling path, and only when nothing names one', () => {
    expect(checkoutRoots({})).toEqual([resolve(process.cwd(), '..', 'Chemclaw3')]);
    // An exported-but-empty variable is how a shell hands over "unset", and treating it as a path
    // resolves the repository root — which holds no marker, so the failure would be a silent skip.
    expect(checkoutRoots({ CHEMCLAW3_DIR: '', CHEMCLAW_REPO: '  ' })).toEqual([
      resolve(process.cwd(), '..', 'Chemclaw3'),
    ]);
  });

  it('takes a relative path as relative to where the suite was started', () => {
    expect(checkoutRoots({ CHEMCLAW3_DIR: '../elsewhere' })).toEqual([
      resolve(process.cwd(), '..', 'elsewhere'),
    ]);
  });

  it('treats a directory without the marker as absent rather than as an empty contract', () => {
    expect(backendCheckout(MARKER, { CHEMCLAW3_DIR: join(tmp, 'nothing-here') })).toBe(null);
    // And it keeps looking: a first variable pointing somewhere wrong must not shadow a second
    // that is right, or a stale export in a shell switches the check off.
    expect(
      backendCheckout(MARKER, { CHEMCLAW3_DIR: join(tmp, 'gone'), CHEMCLAW_REPO: compose }),
    ).toBe(compose);
  });

  it('answers per marker, because the lane that has a checkout has a sparse one', () => {
    // `Preflight` fetches four directories of one repository. A reader asking for the file it
    // opens is what keeps "the checkout is there" from meaning "every reader's file is there".
    expect(backendCheckout(OTHER_MARKER, { CHEMCLAW3_DIR: sparse })).toBe(sparse);
    expect(backendCheckout(MARKER, { CHEMCLAW3_DIR: sparse })).toBe(null);
  });

  it('says where it looked, naming the variable that pointed there', () => {
    expect(backendSearchPath(MARKER, { CHEMCLAW_REPO: compose })).toContain('CHEMCLAW_REPO=');
    expect(backendSearchPath(MARKER, {})).toContain('CHEMCLAW3_DIR or CHEMCLAW_REPO');
  });

  it('reads CHEMCLAW3_REQUIRED as the one thing that turns a skip into a failure', () => {
    expect(checkoutRequired({ CHEMCLAW3_REQUIRED: '1' })).toBe(true);
    expect(checkoutRequired({ CHEMCLAW3_REQUIRED: 'true' })).toBe(false);
    expect(checkoutRequired({})).toBe(false);
  });
});

/**
 * The two readers of a handler's signature, driven over a module written to be nested.
 *
 * `api/app.py` declares its one decorated handler inside `register()`, so an unanchored `^def`
 * search misses it. That was found and fixed in `returnAnnotationOf` and left standing in
 * `requestModelOf`, where the same bug is **invisible**: a handler this reader cannot find and a
 * handler that takes no body both answer `null`. The one nested route in the checkout is a `GET`
 * with no body, so no assertion anywhere in this file could tell the two apart — the population
 * that would expose it is empty, which is the shape this repository keeps finding satisfied by
 * being broken.
 *
 * So the module is built here rather than found: a nested handler that *does* take a body, beside
 * a top-level one, so both readers are asked the same question about the same two shapes. This
 * describe needs no Chemclaw3 checkout — it plants its own.
 */
describe('a handler is read the same way by both readers, nested or not', () => {
  const root = mkdtempSync(join(tmpdir(), 'chemclaw-handlers-'));
  mkdirSync(join(root, 'src', 'chemclaw', 'api'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'chemclaw', 'api', 'nested.py'),
    [
      '@router.post("/top")',
      'async def create_top(body: TopIn, principal: CurrentUser) -> TopOut:',
      '    return TopOut()',
      '',
      '',
      'def register(app: FastAPI) -> None:',
      '    @app.post("/nested")',
      '    async def create_nested(body: NestedIn, principal: CurrentUser) -> NestedOut:',
      '        return NestedOut()',
      '',
    ].join('\n'),
  );
  const route = (handler: string): BackendRoute => ({
    method: 'POST',
    template: `/${handler}`,
    handler,
    module: 'api/nested.py',
  });

  it('finds the body model of a top-level handler', () => {
    expect(requestModelOf(root, route('create_top'))).toBe('TopIn');
    expect(returnAnnotationOf(root, route('create_top'))).toBe('TopOut');
  });

  it('finds the body model of a handler declared inside a function', () => {
    // The assertion the shipped checkout cannot make: its one nested route takes no body, so
    // `null` there is right for the wrong reason and stays right until somebody adds one.
    expect(requestModelOf(root, route('create_nested'))).toBe('NestedIn');
    expect(returnAnnotationOf(root, route('create_nested'))).toBe('NestedOut');
  });

  it('answers null for a handler the module does not declare', () => {
    // Guard the guard: a search that matched anything would satisfy both tests above.
    expect(requestModelOf(root, route('create_absent'))).toBe(null);
    expect(returnAnnotationOf(root, route('create_absent'))).toBe(null);
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
        checkoutRequired(),
        'CHEMCLAW3_REQUIRED=1 was set, so a missing checkout is a failure rather than a skip',
      ).toBe(false);
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
    const unrenamed = stillDeclared(RETAINED_FOR_ROLLOUT, sent);
    if (unrenamed.length > 0) {
      console.log(
        `\n  ${unrenamed.length} name(s) in RETAINED_FOR_ROLLOUT the service still declares — the` +
          ` rename they are retained across has not happened upstream yet, so the retention is` +
          ` not doing anything and its removal is not unblocked:\n` +
          unrenamed.map((type) => `      ${type}`).join('\n'),
      );
    }

    it('holds no AHEAD_OF_BACKEND entry for a name the service has since declared', () => {
      // The other map gets a notice for this and this one gets an assertion, because the two
      // end-states are not alike: `RETAINED_FOR_ROLLOUT` ends when a *deployment* has reloaded
      // every browser, which nothing here can observe, while this map ends when the service
      // declares the name — which is in the file this test just read. By then the entry exempts a
      // name that needs no exemption, and removing it is a deletion with nothing to coordinate.
      expect(
        stillDeclared(AHEAD_OF_BACKEND, sent),
        'the service now declares these, so the AHEAD_OF_BACKEND entry is expired bookkeeping: ' +
          'delete it, the name is ordinary now',
      ).toEqual([]);
    });

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
      // **An assertion, not a print.** This axis reported its finding through `console.log` inside
      // a green run — and the sibling axis below had already been converted for exactly that
      // reason, with the sentence "A print nobody reads is not the control it looks like". The very
      // next event field the service added, `plan.scope`, landed in the hole: it was printed here
      // for a whole wave while the approval card went on collecting a yes to a tool list it had not
      // been shown, and nothing was red.
      //
      // `EVENT_NOT_READ` is the argued exemption, and it is **empty** — the cheapest state for a
      // ratchet to be fitted in. An entry here says "this client deliberately ignores that field",
      // which is a claim a reviewer can check; `test_no_event_exemption_is_stale` then fails on one
      // the service no longer sends, so the map cannot outlive its subjects either.
      expect(
        unread.filter((field) => !EVENT_NOT_READ.has(field)),
        'fields the service sends on an event that `normalizeEvent` drops on the floor. Read them, ' +
          'or add them to EVENT_NOT_READ with the reason this client does not need them.',
      ).toEqual([]);
      expect(
        [...EVENT_NOT_READ].filter((field) => !unread.includes(field)),
        'EVENT_NOT_READ exempts event fields the service no longer sends: delete them. An ' +
          'exemption nobody can trip is a claim that a control exists.',
      ).toEqual([]);
    });
  });

  //: Event fields the service sends that `normalizeEvent` deliberately does not read, each with the
  //: reason. Empty today, and that is the point: it was fitted while there was nothing to exempt, so
  //: the first entry anybody adds is a decision somebody has to write down rather than a print in a
  //: green log. A field on a **destructive-read** route may not be exempted at all — there is no
  //: later read, so "a note for later" is false by construction.
  const EVENT_NOT_READ = new Set<string>();

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

  describe('what this client reads back', () => {
    // The axis `ISSUES.md` Issue 14 recorded as absent, both halves of which turned out not to be.
    // The service's half: every route it registers annotates its return. This client's half: every
    // call casts its body to the model's own name and reshapes after the cast, so what the reader
    // compares is the wire as this client declares it rather than what it builds out of it.
    const requests = clientRequests();

    it('is named on every route the service registers, which is the premise of the rest', () => {
      // `ISSUES.md` Issue 14 said what would close this axis is the return models being readable
      // route by route, "which is a shape the backend does not owe anybody today". It owes it:
      // every registered route annotates its return. That is asserted rather than transcribed
      // because the day it stops being true is the day this axis silently narrows — a handler
      // with no annotation drops out of every comparison below and nothing goes red.
      const unannotated = backend
        .filter((route) => returnAnnotationOf(root, route) === null)
        .map((route) => `${route.method} ${route.template} → ${route.handler} (${route.module})`);
      expect(
        unannotated,
        'these handlers declare no return type, so what they answer with is not readable here',
      ).toEqual([]);
      // Guard the guard: an empty `backend` would pass the line above without reading anything.
      expect(backend.length, 'no route was read off the service at all').toBeGreaterThan(5);

      // Printed rather than asserted: `Response`, `dict[str, str]` and `NoteView | Response` are
      // all deliberate, and none of them is one model this reader may pair with an interface.
      const unnamed = backend
        .filter((route) => responseModelOf(root, route) === null)
        .map((route) => `${route.method} ${route.template} → ${returnAnnotationOf(root, route)}`);
      console.log(
        `\n  ${unnamed.length} service route(s) whose return is not one model by name:\n` +
          unnamed.map((route) => `      ${route}`).join('\n'),
      );
    });

    const named = requests.flatMap((request) => {
      const route = backend.find(
        (candidate) =>
          candidate.method === request.method &&
          normalizeTemplate(candidate.template) === request.template,
      );
      const model = route ? responseModelOf(root, route) : null;
      return model !== null && request.responseType === model ? [{ request, model }] : [];
    });

    it('declares the model by name for every response that is one readable model', () => {
      // What makes the pairing below a population rather than a sample. A call reading a route that
      // answers one model this reader can open either casts to that model's name — and is compared
      // below — or is listed here and fails. There is no third outcome any more, which is the one
      // Issue 14 described: most calls reshaped their answer, declared the reshaped type, and were
      // silently not compared at all.
      const modelOf = (request: ClientRequest): string | null => {
        const route = backend.find(
          (candidate) =>
            candidate.method === request.method &&
            normalizeTemplate(candidate.template) === request.template,
        );
        const model = route ? responseModelOf(root, route) : null;
        return model !== null && modelFields(root, model) !== null ? model : null;
      };
      expect(
        undeclaredReads(requests, modelOf),
        'these read a response the service declares as one model and cast it to something else — ' +
          'declare the model by its own name at the cast, and reshape after it',
      ).toEqual([]);
      // Guard the guard: a reader that stopped resolving models would pass the line above empty.
      expect(requests.filter((request) => modelOf(request) !== null).length).toBeGreaterThan(20);
    });

    it('declares the wire shape itself for the responses it declares at all', () => {
      // Both sides have to be *readable* as well as named the same, and refusing where one is not
      // is the whole of why this axis can exist at all: `JobRecordSummary` is on the wire as a
      // model declared in `durable/`, outside the `api/` package these wire models live in, and
      // the sibling's own record argues for restating a worker shape at the wire rather than
      // importing it. Reaching into that package to compare anyway is precisely the invented
      // pairing `ISSUES.md` Issue 14 refuses. So it is listed, not compared, not failed.
      const unreadable: string[] = [];
      const pairs = named.filter(({ model }) => {
        const readable = modelFields(root, model) !== null && clientInterfaceFields(model) !== null;
        if (!readable) unreadable.push(model);
        return readable;
      });
      if (unreadable.length > 0) {
        console.log(
          `\n  ${unreadable.length} response(s) named the same on both sides that this reader ` +
            `cannot read one half of:\n` +
            unreadable.map((model) => `      ${model}`).join('\n'),
        );
      }
      // Every pair agrees today, so the loop below would pass with its body deleted — which is why
      // the comparison is a function driven over built inputs above, and why the pairs it *cannot*
      // make are printed rather than silently dropped.
      expect(
        pairs.length,
        'no response this client declares is the wire model by name — the pairing this axis ' +
          'rests on has stopped resolving, and the two assertions here now check nothing',
      ).toBeGreaterThan(1);

      const wrong: string[] = [];
      const unread: string[] = [];
      for (const { request, model } of pairs) {
        const declared = modelFields(root, model) ?? [];
        const read = clientInterfaceFields(model) ?? [];
        const drift = responseDrift(
          model,
          read,
          declared.map((field) => field.name),
        );
        wrong.push(...drift.wrong.map((field) => `${field} (${request.file}:${request.line})`));
        unread.push(...drift.unread);
      }
      expect(
        wrong,
        'this client declares these properties on a response and no model upstream sends them — ' +
          'every one arrives `undefined`, which is the confident blank this axis exists to catch',
      ).toEqual([]);
      // **The other direction is asserted too now, against an argued list rather than printed.**
      // A client is entitled not to read a field, which is why this was a `console.log` — and what
      // that spent was the only notice anybody got: `Digest.disputed` and `Digest.headlines` were
      // printed by this line for as long as the card rendered bare note ids, and the service's own
      // model says `headlines` exists because without it "a client can do nothing but print them".
      // A print nobody reads is not the control it looks like. So an entitlement has to be written
      // down: `NOT_READ` carries the reason per field, and the list is held in both directions —
      // an entry that has stopped drifting fails too, because a stale exemption reads as a live
      // one.
      expect(
        unread.filter((field) => !(field in NOT_READ)),
        'the service sends these and this client declares none of them — read the field or add it ' +
          'to `NOT_READ` with the reason it is not worth reading',
      ).toEqual([]);
      expect(
        Object.keys(NOT_READ).filter((field) => !unread.includes(field)),
        'these are exempted from being read and are no longer missing — delete the exemption',
      ).toEqual([]);
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
