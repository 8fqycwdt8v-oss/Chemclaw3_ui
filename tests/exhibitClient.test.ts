/**
 * The artefact contract from this client's side: the decoders, the event, and the requests.
 *
 * Three things are held here that the cross-repository check (`backendContract.test.ts`) cannot
 * hold, because it compares *names* and these are *behaviours*:
 *
 *  - a body the service sent is decoded into exactly the frozen shape, a malformed spec becomes the
 *    `null` the view says something honest about, and one bad row in a list costs that row;
 *  - a stale edit's 409 arrives as a `StaleRevisionError` carrying the head the service named —
 *    the number the whole rebase prompt is built from;
 *  - every id, format and revision reaches the URL encoded or coerced, so a hostile value is
 *    refused by the BFF whitelist rather than reshaping the path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api, filenameFrom } from '../src/api/client.ts';
import { ApiError, StaleRevisionError } from '../src/api/errors.ts';
import { normalizeEvent } from '../shared/events.ts';
import {
  decodeExhibitDiff,
  decodeExhibitList,
  decodeExhibitView,
  EXPORT_FORMATS,
  isSpec,
} from '../shared/exhibits.ts';
import { stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

const SID = 'a'.repeat(32);
const XID = 'xb-0123456789abcdef';
const auth = async (): Promise<string | null> => null;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('the artefact bodies decode into the frozen shape', () => {
  it('reads a view field for field, including the spec and the unverified figures', () => {
    const view = decodeExhibitView(VIEW);
    expect(view).toEqual(VIEW);
  });

  it('reads every kind of spec the contract names', () => {
    const specs = [
      { kind: 'document', markdown: '# Draft' },
      { kind: 'table', columns: [{ key: 'a', label: 'A' }], rows: [] },
      { kind: 'structures', items: [{ smiles: 'CCO' }] },
      { kind: 'chart', chart: 'bar', x_label: 'Solvent', y_label: 'Yield (%)', series: [] },
      { kind: 'result', result_ref: 'c'.repeat(64) },
      { kind: 'link', target: 'protocol', id: 'design-0123456789ab' },
    ];
    for (const spec of specs) {
      expect(isSpec(spec), spec.kind).toBe(true);
      expect(decodeExhibitView({ ...VIEW, kind: spec.kind, spec }).spec?.kind).toBe(spec.kind);
    }
    // The service's defaults, filled in rather than left undefined for a renderer to trip on.
    expect(
      decodeExhibitView({ ...VIEW, spec: { kind: 'structures', items: [{ smiles: 'CCO' }] } }).spec,
    ).toEqual({ kind: 'structures', items: [{ smiles: 'CCO', label: '', props: {} }] });
  });

  it('reads a spec it cannot validate as null, never as a half-coerced document', () => {
    for (const spec of [
      { kind: 'table', columns: [], rows: [] }, // a table with no columns
      { kind: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: { nested: 1 } }] },
      { kind: 'chart', chart: 'pie', x_label: '', y_label: '', series: [] },
      { kind: 'result', result_ref: 'not-a-ref' },
      { kind: 'interactive', html: '<script>' },
    ]) {
      expect(decodeExhibitView({ ...VIEW, spec }).spec, JSON.stringify(spec)).toBeNull();
    }
  });

  it('costs one row of a list for one malformed header, and reads a missing switch as off', () => {
    const listed = decodeExhibitList({
      enabled: true,
      exhibits: [VIEW, 'not a header', { ...VIEW, exhibit_id: 'xb-1111111111111111' }],
    });
    expect(listed.exhibits.map((x) => x.exhibit_id)).toEqual([XID, 'xb-1111111111111111']);
    // Absent `enabled` is off: the reading that cannot put a dead Artefacts tab on screen.
    expect(decodeExhibitList({ exhibits: [] }).enabled).toBe(false);
  });

  it('renders a diff value as the text RevisionDiff draws, whatever its JSON type', () => {
    const diff = decodeExhibitDiff({
      from_revision: 1,
      to_revision: 2,
      changes: [
        { path: 'rows[0].yield', kind: 'changed', before: 78, after: 82 },
        { path: 'rows[1]', kind: 'added', before: null, after: { solvent: 'CPME' } },
      ],
    });
    expect(diff.changes).toEqual([
      { path: 'rows[0].yield', kind: 'changed', before: '78', after: '82' },
      { path: 'rows[1]', kind: 'added', before: '', after: '{"solvent":"CPME"}' },
    ]);
  });

  it('refuses a body that is not an object at all, rather than inventing an empty artefact', () => {
    expect(() => decodeExhibitView('<html>Bad gateway</html>')).toThrow(/cannot read/);
  });

  it('offers server exports exactly where the contract has them', () => {
    expect(EXPORT_FORMATS).toEqual({
      document: ['md'],
      table: ['csv', 'md'],
      structures: ['smi', 'csv'],
      chart: ['csv'],
      result: [],
      link: [],
      geometry: ['xyz'],
    });
  });
});

describe('a calculation file (the C4 byte route)', () => {
  it('asks for one encoded `ref` and hands back the bytes under the stored name and type', async () => {
    const stub = stubFetch(
      () =>
        new Response('3\n\nO 0 0 0\nH 0 0 1\nH 0 1 0\n', {
          status: 200,
          headers: {
            'content-type': 'chemical/x-xyz',
            'content-disposition': 'attachment; filename="xtbopt.xyz"',
          },
        }),
    );
    restore = stub.restore;
    const file = await api.getCalcArtifact(
      'xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:ab:cd#xtbopt.xyz',
      auth,
    );
    expect(stub.calls[0]!.url).toBe(
      '/api/calc-artifacts/content?ref=xtb_opt%40gfn2%2Bxtb%2Bxtb-6.7.1%2Ftblite-0.4.0%3Aab%3Acd%23xtbopt.xyz',
    );
    expect(file.filename).toBe('xtbopt.xyz');
    expect(file.mediaType).toBe('chemical/x-xyz');
    expect(await file.blob.text()).toMatch(/^3\n/);
  });

  it('asks for a real calc key, slashes and all, encoded whole', async () => {
    const stub = stubFetch(() => new Response('x', { status: 200 }));
    restore = stub.restore;
    const key = 'xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:abc:def';
    await api.getCalcArtifact(`${key}#xtbopt.xyz`, auth);
    expect(stub.calls[0]!.url).toBe(
      `/api/calc-artifacts/content?ref=${encodeURIComponent(`${key}#xtbopt.xyz`)}`,
    );
    expect(stub.calls[0]!.url).toContain('%2F');
  });

  it('calls a ref that is not one "not a calculation file", never "no longer stored"', async () => {
    // Refused before asking: no request is made for a ref the BFF would not forward.
    const stub = stubFetch(() => json(200, {}));
    restore = stub.restore;
    for (const bad of ['xtbopt.xyz', 'k@1:a:b#', 'a b#x', 'k#..']) {
      const err = (await api.getCalcArtifact(bad, auth).catch((e: unknown) => e)) as Error;
      expect(err.message, bad).toMatch(/not a calculation file/);
      expect(err.message).not.toMatch(/no longer stored/);
    }
    expect(stub.calls).toHaveLength(0);
    stub.restore();
    // And when the BFF itself refuses (its bare `not found`), the same sentence.
    const refused = stubFetch(() => json(404, { detail: 'not found' }));
    restore = refused.restore;
    const err = (await api.getCalcArtifact('k@1:a:b#x', auth).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/not a calculation file/);
  });

  it('names the file after the ref when the service sent no disposition', async () => {
    const stub = stubFetch(() => new Response('x', { status: 200 }));
    restore = stub.restore;
    expect((await api.getCalcArtifact('k@1:a:b#hessian', auth)).filename).toBe('hessian');
  });

  it('says an evicted file is gone and an oversized one is over the limit, in its own words', async () => {
    for (const [status, sentence] of [
      [404, /no longer stored/],
      [413, /larger than this deployment will send/],
    ] as const) {
      const stub = stubFetch(() => json(status, { detail: 'nope' }));
      restore = stub.restore;
      const err = (await api.getCalcArtifact('k@1:a:b#x', auth).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toMatch(sentence);
      stub.restore();
      restore = null;
    }
  });
});

describe('the exhibit event', () => {
  it('reads an op it does not know as a revision, which can never open the pane', () => {
    const parsed = normalizeEvent({ type: 'exhibit', exhibit_id: XID, revision: 1, op: 'moved' });
    expect(parsed).toMatchObject({ type: 'exhibit', op: 'revised', author_kind: 'agent' });
  });
});

describe('the artefact requests', () => {
  it('lists a session’s artefacts, and reads a service without the route as “off”', async () => {
    const stub = stubFetch(() => json(404, { detail: 'Not Found' }));
    restore = stub.restore;
    await expect(api.listExhibits(SID, auth)).resolves.toEqual({ enabled: false, exhibits: [] });
    expect(stub.calls[0]?.url).toBe(`/api/sessions/${SID}/exhibits`);
  });

  it('asks for a numbered revision and for the head without one', async () => {
    const stub = stubFetch(() => json(200, VIEW));
    restore = stub.restore;
    await api.getExhibit(SID, XID, auth, 2);
    await api.getExhibit(SID, XID, auth, 0);
    await api.getExhibit(SID, XID, auth, 2.7);
    expect(stub.calls.map((c) => c.url)).toEqual([
      `/api/sessions/${SID}/exhibits/${XID}?revision=2`,
      `/api/sessions/${SID}/exhibits/${XID}`,
      `/api/sessions/${SID}/exhibits/${XID}?revision=2`,
    ]);
  });

  it('compares with the contract’s `from` and `to`, coerced to integers', async () => {
    const stub = stubFetch(() => json(200, { from_revision: 1, to_revision: 3, changes: [] }));
    restore = stub.restore;
    await api.getExhibitDiff(SID, XID, 1.9, 3, auth);
    expect(stub.calls[0]?.url).toBe(`/api/sessions/${SID}/exhibits/${XID}/diff?from=1&to=3`);
  });

  it('posts a revision bound to its parent, and leaves the title out unless it changed', async () => {
    const stub = stubFetch(() => json(201, VIEW));
    restore = stub.restore;
    const spec = { kind: 'document' as const, markdown: 'x' };
    await api.postExhibitRevision(SID, XID, { parentRevision: 2, spec, changeNote: 'n' }, auth);
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({
      parent_revision: 2,
      spec,
      change_note: 'n',
    });
  });

  it('turns a stale_revision 409 into a StaleRevisionError carrying the head', async () => {
    const stub = stubFetch(() =>
      json(409, { detail: { code: 'stale_revision', head_revision: 5, message: 'moved' } }),
    );
    restore = stub.restore;
    const err = await api
      .postExhibitRevision(
        SID,
        XID,
        { parentRevision: 3, spec: { kind: 'document', markdown: 'x' }, changeNote: '' },
        auth,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleRevisionError);
    expect((err as StaleRevisionError).headRevision).toBe(5);
    expect((err as StaleRevisionError).kind).toBe('stale_revision');
  });

  it('names no head it was not given, rather than guessing one to rebase onto', async () => {
    const stub = stubFetch(() => json(409, { detail: { code: 'stale_revision' } }));
    restore = stub.restore;
    const err = await api
      .postExhibitRevision(
        SID,
        XID,
        { parentRevision: 3, spec: { kind: 'document', markdown: 'x' }, changeNote: '' },
        auth,
      )
      .catch((e: unknown) => e);
    expect((err as StaleRevisionError).headRevision).toBeNull();
  });

  it('pins a tool result as a result artefact, in the contract’s shape', async () => {
    const stub = stubFetch(() => json(201, VIEW));
    restore = stub.restore;
    const spec = { kind: 'result' as const, result_ref: 'c'.repeat(64), tool: 'screen_hazards' };
    await api.createExhibit(SID, { kind: 'result', title: 'screen_hazards', spec }, auth);
    expect(stub.calls[0]?.url).toBe(`/api/sessions/${SID}/exhibits`);
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({
      kind: 'result',
      title: 'screen_hazards',
      spec,
    });
  });

  it('says the session is full as its own refusal', async () => {
    const stub = stubFetch(() => json(409, { detail: { code: 'exhibit_limit' } }));
    restore = stub.restore;
    const err = await api
      .createExhibit(
        SID,
        {
          kind: 'result',
          title: 't',
          spec: { kind: 'result', result_ref: 'c'.repeat(64), tool: '' },
        },
        auth,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('exhibit_limit');
  });

  it('downloads an export with every segment encoded, named by the service', async () => {
    const stub = stubFetch(
      () =>
        new Response('a,b\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': "attachment; filename*=UTF-8''L%C3%B6slichkeit.csv",
          },
        }),
    );
    restore = stub.restore;
    // Hostile values the app would never mint, carrying the characters that reshape a path.
    const file = await api.exportExhibit('a/b?c', 'xb-1/../x', 'csv', auth, 3);
    expect(stub.calls[0]?.url).toBe(
      '/api/sessions/a%2Fb%3Fc/exhibits/xb-1%2F..%2Fx/export.csv?revision=3',
    );
    expect(file.filename).toBe('Löslichkeit.csv');
    expect(await file.blob.text()).toBe('a,b\r\n');
  });

  it('lists the reader’s artefacts across sessions, capped by the contract’s limit', async () => {
    const stub = stubFetch(() => json(200, { exhibits: [VIEW] }));
    restore = stub.restore;
    const listed = await api.listMyExhibits(auth);
    expect(stub.calls[0]?.url).toBe('/api/exhibits?limit=50');
    expect(listed.map((x) => x.exhibit_id)).toEqual([XID]);
  });
});

describe('the filename an export is saved under', () => {
  it('prefers the RFC 6266 extended name and strips anything that is a path', () => {
    expect(filenameFrom('attachment; filename="table.csv"', 'x')).toBe('table.csv');
    expect(filenameFrom('attachment; filename*=UTF-8\'\'a%2Fb.md; filename="ab.md"', 'x')).toBe(
      'a_b.md',
    );
    expect(filenameFrom(null, 'fallback.csv')).toBe('fallback.csv');
    expect(filenameFrom('attachment', 'fallback.csv')).toBe('fallback.csv');
  });
});
