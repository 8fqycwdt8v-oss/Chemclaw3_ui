/**
 * The five protocol calls, and the two policies they have to get right.
 *
 * **List swallows a 404, fetch does not.** `api/client.ts` states the split at the top of the file
 * and it is not stylistic: `/protocols` is called speculatively when a screen opens, so an older
 * service should yield an empty screen rather than a banner about a feature it does not have —
 * while `/protocols/{id}` is opened by a click on a row that exists, so a 404 there is a design
 * that vanished, and hiding it would leave a blank document that reads like a design with nothing
 * in it.
 *
 * **The 409 has to arrive as its own kind.** Two chemists editing one design is the ordinary case
 * in a lab, and the whole point of posting `parent_revision` is that the second save is refused
 * rather than silently rebased onto the first. The status alone cannot be told apart from
 * `turn_in_flight` — one number, two meanings, and only the caller knows which route it asked —
 * which is exactly why `decidePlan` re-kinds its own 409 and why this does too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import { jsonError, stubFetch } from './helpers.ts';
import type {
  DesignOut,
  DesignRevision,
  DesignSummary,
  ExperimentDesign,
} from '../shared/protocols.ts';

const DESIGN = 'design-0123456789ab';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const token = async (): Promise<string | null> => 't';

const ok = (body: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Annotated with the interfaces the service is declared to return rather than left as bare
 * literals. Zero runtime cost, and it makes `tsc -b` — already a CI step — the drift check: a field
 * renamed upstream and mirrored in `shared/protocols.ts` fails the typecheck here instead of
 * leaving this fixture describing a shape the service stopped sending.
 */
const SUMMARY: DesignSummary = {
  design_id: DESIGN,
  title: 'Amination solvent screen',
  mode: 'screen',
  status: 'draft',
  project: 'PRJ-4',
  opened_by: 'chemist@example.com',
  head_revision: 2,
  arms: 8,
  blockers: 0,
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
};

const DOCUMENT: ExperimentDesign = {
  request: {
    title: 'Amination solvent screen',
    goal: 'Find a solvent that keeps selectivity above 9:1.',
    mode: 'screen',
    reaction_smiles: '',
    components: [],
    objectives: ['yield'],
    scale: { value: '', basis: 'absent', quote: '' },
    plate_format: { value: '24', basis: 'inferred', quote: '' },
    max_runs: { value: '', basis: 'absent', quote: '' },
    deadline: { value: '', basis: 'absent', quote: '' },
    forbidden: [],
    prior_work: '',
    project: 'PRJ-4',
    notes: '',
  },
  base: {
    setpoints: {
      temperature_c: 80,
      time_h: 16,
      pressure_bar: null,
      atmosphere: 'N2',
      concentration_molar: 0.2,
      solvent: '2-MeTHF',
      ph: null,
    },
    charge: [],
    steps: [],
    analytics: [],
    in_process_controls: [],
    hazards: [],
    waste: '',
    expected: { yield_percent: null, selectivity: '', basis: 'assumed', detail: '' },
  },
  factors: [],
  arms: [],
  layout: null,
  evidence: [],
};

const REVISION: DesignRevision = {
  design_id: DESIGN,
  revision: 2,
  kind: 'protocol',
  author_kind: 'agent',
  author: 'chemclaw',
  change_note: 'Drafted from the structured request.',
  design: DOCUMENT,
  checks: [],
  created_at: '2026-08-21T09:00:00Z',
};

/** One whole read, in the service's own shape — a `DesignRevision` flat, plus what rides along. */
const READ: DesignOut = { ...REVISION, summary: SUMMARY, history: [], status_history: [] };

describe('listProtocols', () => {
  it('unwraps the envelope and passes the filters through', async () => {
    const stub = stubFetch(() => ok({ designs: [SUMMARY] }));
    restore = stub.restore;

    const designs = await api.listProtocols(token, { status: 'draft', project: 'PRJ-4' });

    expect(designs).toEqual([SUMMARY]);
    const url = new URL(stub.calls[0]!.url, 'http://x');
    expect(url.searchParams.get('status')).toBe('draft');
    expect(url.searchParams.get('project')).toBe('PRJ-4');
  });

  it('sends an integer limit or none, never a fraction', async () => {
    // The service validates it, but a fractional or NaN limit is a bug on this side and sending it
    // gets back a 422 describing the wrong problem.
    const stub = stubFetch(() => ok({ designs: [] }));
    restore = stub.restore;

    await api.listProtocols(token, { limit: 24.7 });
    await api.listProtocols(token, { limit: Number.NaN });

    expect(new URL(stub.calls[0]!.url, 'http://x').searchParams.get('limit')).toBe('24');
    expect(new URL(stub.calls[1]!.url, 'http://x').searchParams.get('limit')).toBeNull();
  });

  it('degrades a 404 into an empty list, like every other list route', async () => {
    const stub = stubFetch(() => jsonError(404, 'no such route'));
    restore = stub.restore;
    await expect(api.listProtocols(token)).resolves.toEqual([]);
  });
});

describe('getProtocol', () => {
  it('reads the head when no revision is named', async () => {
    const stub = stubFetch(() => ok(READ));
    restore = stub.restore;

    const view = await api.getProtocol(DESIGN, token);

    // FLAT. `revision` is a number and the revision's own fields sit beside it — the shape the
    // service returns. This assertion used to read `view.revision.revision`, against a stub that
    // agreed with it and with nothing else.
    expect(view.revision).toBe(2);
    expect(view.design).toEqual(DOCUMENT);
    expect(view.summary?.status).toBe('draft');
    expect(view.status_history).toEqual([]);
    expect(stub.calls[0]!.url).toContain(`/protocols/${DESIGN}`);
    expect(stub.calls[0]!.url).not.toContain('revision=');
  });

  it('asks for one revision as an integer', async () => {
    const stub = stubFetch(() => ok(READ));
    restore = stub.restore;

    await api.getProtocol(DESIGN, token, 1);

    expect(new URL(stub.calls[0]!.url, 'http://x').searchParams.get('revision')).toBe('1');
  });

  it('does NOT swallow a 404 — a design that vanished is a fault, not an empty document', async () => {
    const stub = stubFetch(() => jsonError(404, 'unknown design'));
    restore = stub.restore;
    await expect(api.getProtocol(DESIGN, token)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('putProtocolRevision', () => {
  it('posts the whole document with the parent it was edited against', async () => {
    const stub = stubFetch(() => ok({ revision: 3, checks: [], changed_paths: ['base'] }));
    restore = stub.restore;

    const written = await api.putProtocolRevision(
      DESIGN,
      DOCUMENT,
      2,
      'raised the temperature',
      token,
    );

    expect(written.revision).toBe(3);
    expect(stub.calls[0]!.init?.method).toBe('POST');
    const body = JSON.parse(String(stub.calls[0]!.init?.body)) as {
      document: ExperimentDesign;
      parent_revision: number;
      change_note: string;
    };
    expect(body.parent_revision).toBe(2);
    expect(body.change_note).toBe('raised the temperature');
    // The whole document, not a patch: the service takes the document it is given.
    expect(body.document.base.setpoints.solvent).toBe('2-MeTHF');
  });

  it('re-kinds the 409 and keeps the message the service put inside the object', async () => {
    // **The service's own shape**: this route answers a stale edit with a `detail` *object*
    // (`{"code": "revision_conflict", "message": …}`), not a string, which is what `jsonError`
    // sends and what this test used to assert against. `readFailure` kept only strings, so the
    // sentence naming the head revision was dropped and the banner fell back to the generic 409
    // — "A turn is already running for this conversation." — on a conflict about an *edit*.
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: { code: 'revision_conflict', message: 'parent_revision 2 is not the head' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    restore = stub.restore;

    await expect(api.putProtocolRevision(DESIGN, DOCUMENT, 2, 'note', token)).rejects.toMatchObject(
      { kind: 'revision_conflict', status: 409, message: 'parent_revision 2 is not the head' },
    );
  });

  it('carries the correlation id across the re-kind', async () => {
    // The rebuild is a fresh `ApiError`, and it used to be constructed with no `options` — so the
    // reference `errorFromStatus` had just read off the response was thrown away by the one line
    // whose only job was to change the kind. `api/errors.ts` states the rule: every banner carries
    // a reference. Without it, the two conflict banners in `ProtocolDocument` are the only failures
    // in this app a chemist cannot quote a single log line for.
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: { code: 'revision_conflict', message: 'stale' } }), {
          status: 409,
          headers: { 'content-type': 'application/json', 'x-chemclaw-correlation-id': 'corr-put' },
        }),
    );
    restore = stub.restore;

    await expect(api.putProtocolRevision(DESIGN, DOCUMENT, 2, 'note', token)).rejects.toMatchObject(
      { kind: 'revision_conflict', correlationId: 'corr-put' },
    );
  });

  it('leaves every other failure alone', async () => {
    // Only 409 means "somebody else moved it". A 422 is this client sending something wrong and
    // must not be presented as a conflict with a colleague.
    const stub = stubFetch(() => jsonError(422, 'document failed validation'));
    restore = stub.restore;

    await expect(api.putProtocolRevision(DESIGN, DOCUMENT, 2, 'note', token)).rejects.toMatchObject(
      { kind: 'message_too_long' },
    );
  });
});

describe('getProtocolDiff and setProtocolStatus', () => {
  it('asks for a comparison by two integer revisions', async () => {
    const stub = stubFetch(() => ok({ from_revision: 1, to_revision: 2, changes: [] }));
    restore = stub.restore;

    const diff = await api.getProtocolDiff(DESIGN, 1, 2, token);

    expect(diff.changes).toEqual([]);
    // **The names the route binds.** This asserted `from`/`to`, which the service does not read —
    // FastAPI ignores an unknown query parameter, so every comparison answered 200 with the
    // route's defaults (revision 1 against the head) while the header printed the numbers the
    // chemist clicked. The test agreed with the client and with nothing else.
    const url = new URL(stub.calls[0]!.url, 'http://x');
    expect(url.searchParams.get('from_revision')).toBe('1');
    expect(url.searchParams.get('to_revision')).toBe('2');
    expect(url.searchParams.get('from')).toBeNull();
  });

  it('records a status move against the revision and the status on screen, with its reason', async () => {
    const stub = stubFetch(() => ok(null, 204));
    restore = stub.restore;

    await expect(
      api.setProtocolStatus(DESIGN, 'abandoned', 3, 'approved', 'superseded by the DoE', token),
    ).resolves.toBeUndefined();

    expect(stub.calls[0]!.url).toContain(`/protocols/${DESIGN}/status`);
    // `expected_revision` is `parent_revision`'s twin for a sign-off: the service refuses a move
    // that names anything but the head, so a colleague's save between reading and clicking is a
    // 409 rather than this chemist's name on a document they never saw.
    //
    // `expected_status` closes the half it cannot see. It is required by the service, so it being
    // in this body is the whole reason the control exists at all rather than only in a docstring —
    // which is why this assertion is `toEqual` on the exact body rather than a subset check.
    expect(JSON.parse(String(stub.calls[0]!.init?.body))).toEqual({
      status: 'abandoned',
      expected_revision: 3,
      expected_status: 'approved',
      reason: 'superseded by the DoE',
    });
  });

  it('gives a status conflict its own kind, distinct from a revision conflict', async () => {
    // One route, two 409s, and only the service can say which: `revision_conflict` means the
    // document moved and a diff is worth reading, `status_conflict` means a colleague already
    // decided. Reporting the second as the first would send a chemist to a diff showing nothing —
    // and before this route had a `status_conflict` at all, both moves were simply told 204.
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: {
              code: 'status_conflict',
              message: "this design is 'abandoned', not 'draft' as you saw it",
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    restore = stub.restore;

    await expect(
      api.setProtocolStatus(DESIGN, 'approved', 1, 'draft', 'looks fine', token),
    ).rejects.toMatchObject({
      kind: 'status_conflict',
      status: 409,
      message: "this design is 'abandoned', not 'draft' as you saw it",
    });
  });

  it('reports the revision half of the same 409 as a revision conflict', async () => {
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: { code: 'revision_conflict', message: 'revision 1 is not the head (2)' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    restore = stub.restore;

    await expect(
      api.setProtocolStatus(DESIGN, 'approved', 1, 'draft', 'looks fine', token),
    ).rejects.toMatchObject({ kind: 'revision_conflict', status: 409 });
  });

  it('carries the correlation id across the re-kind here too', async () => {
    // The same defect, copied. This one is the site where losing the reference costs most: a
    // refused sign-off is the failure a chemist is likeliest to have to ask somebody about, and
    // the codeless branch is exactly the older deployment where the rest of the diagnosis is
    // thinnest.
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'revision 1 is not the head (2)' }), {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'x-chemclaw-correlation-id': 'corr-status',
          },
        }),
    );
    restore = stub.restore;

    await expect(
      api.setProtocolStatus(DESIGN, 'approved', 1, 'draft', 'looks fine', token),
    ).rejects.toMatchObject({ kind: 'revision_conflict', correlationId: 'corr-status' });
  });

  it('reads a codeless 409 from an older service as a revision conflict', async () => {
    // The only 409 a deployment predating `expected_status` can produce on this route, and it
    // arrives as a bare string with nothing to branch on. `turn_in_flight` — the message route's
    // default — would tell a chemist a turn is running, on a screen with no conversation on it.
    const stub = stubFetch(() => jsonError(409, 'revision 1 is not the head (2)'));
    restore = stub.restore;

    await expect(
      api.setProtocolStatus(DESIGN, 'approved', 1, 'draft', 'looks fine', token),
    ).rejects.toMatchObject({
      kind: 'revision_conflict',
      status: 409,
      message: 'revision 1 is not the head (2)',
    });
  });
});
