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
 * Wire names this client accepts that the service does not declare — each with the reason, and
 * each a deliberate step in a two-repository rename that has to land on the reader first.
 *
 * Empty is the normal state. An entry here is a promise that the *other* repository has a row for
 * the step that removes it; see `ISSUES.md`.
 */
const AHEAD_OF_BACKEND = new Map<string, string>();

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
      const sent = new Set(events.map((event) => event.wire));
      const unsent = clientEventTypes().filter(
        (type) => !sent.has(type) && !AHEAD_OF_BACKEND.has(type),
      );
      expect(
        unsent,
        'mirrored here, declared nowhere upstream: either dead code, or an argued entry in AHEAD_OF_BACKEND',
      ).toEqual([]);

      // The other end of the same promise: an argued name the service has since shipped is no
      // longer ahead of anything, and the step that removes the old spelling is now unblocked.
      const landed = [...AHEAD_OF_BACKEND.keys()].filter((type) => sent.has(type));
      if (landed.length > 0) {
        console.log(
          `\n  ${landed.length} name(s) in AHEAD_OF_BACKEND the service now declares — the` +
            ` removal step they were waiting on is unblocked:\n` +
            landed.map((type) => `      ${type}`).join('\n'),
        );
      }
    });

    it('is read field by field off the fields the service declares', () => {
      const reads = normalizeEventReads();
      const wrong: string[] = [];
      const unread: string[] = [];
      for (const event of events) {
        // Not a formality: every loop below iterates this entry, so an event with none would pass
        // both directions by having nothing to compare.
        expect(reads.has(event.wire), `normalizeEvent has no branch for ${event.wire}`).toBe(true);
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
