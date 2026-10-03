/**
 * The geometry artefact as a reader meets it: the drawing, the controls a keyboard can reach, the
 * table that says the same thing in words, and the two ways the coordinates arrive.
 *
 * The SVG is asserted as a drawing — how many balls, which ones are ringed, whether a key press
 * moved anything — because that is what happy-dom can check without a 2D context and what a screen
 * reader is handed. The arithmetic under it is `tests/geometry.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DRAWN_ATOM_LIMIT, GeometryViewer } from '../src/components/chem/GeometryViewer.tsx';
import { GeometryView } from '../src/components/exhibits/views/GeometryView.tsx';
import { GoneSourcesStrip } from '../src/components/exhibits/Provenance.tsx';
import { goneBindings } from '../src/components/exhibits/bindings.ts';
import { parseXyz } from '../src/chem/geometry.ts';
import { queryClient } from '../src/api/queryClient.ts';
import { decodeExhibitView, type ExhibitView, type GeometrySpec } from '../shared/exhibits.ts';
import { stubFetch } from './helpers.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const WATER = `3
optimised
O      0.00000000    0.00000000    0.11779000
H      0.00000000    0.75545000   -0.47116000
H      0.00000000   -0.75545000   -0.47116000
`;

let restore: (() => void) | null = null;
let reduced = true;

beforeEach(() => {
  // Reduced motion by default, so a key press turns the view in one synchronous step a test can
  // read; the eased path is asserted on its own below.
  reduced = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduced : true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
  vi.unstubAllGlobals();
  queryClient.clear();
});

const balls = (container: HTMLElement): SVGCircleElement[] =>
  [
    ...container.querySelectorAll('g[data-atom] > circle:not([data-highlight])'),
  ] as SVGCircleElement[];

const positions = (container: HTMLElement): string =>
  balls(container)
    .map(
      (c) =>
        `${Number(c.getAttribute('cx')).toFixed(2)},${Number(c.getAttribute('cy')).toFixed(2)}`,
    )
    .sort()
    .join(' ');

const radius = (container: HTMLElement): number => Number(balls(container)[0]!.getAttribute('r'));

describe('the viewer', () => {
  it('draws every atom and names the structure for a screen reader', () => {
    const { container } = render(
      <GeometryViewer geometry={parseXyz(WATER)} label="Water" energyHartree={-5.070544} />,
    );
    expect(balls(container)).toHaveLength(3);
    const drawing = screen.getByRole('img');
    expect(drawing.getAttribute('aria-label')).toBe(
      'Water: H2O; 3 atoms, 2 bonds by distance; energy -5.070544 Eh (-3,181.8 kcal/mol)',
    );
    // Bonds are lines, two halves each, each drawn as an outline and a fill.
    // (Inside the drawing: the buttons' icons are SVG lines too.)
    expect(drawing.querySelectorAll('line').length).toBe(2 * 2 * 2);
    expect(screen.getByText(/no bond orders are implied/)).toBeTruthy();
  });

  it('rings the highlighted atoms, 0-based, and says so in the table', () => {
    const { container } = render(
      <GeometryViewer geometry={parseXyz(WATER)} label="Water" highlight={[0]} />,
    );
    const rings = container.querySelectorAll('circle[data-highlight]');
    expect(rings).toHaveLength(1);
    expect(rings[0]!.closest('g')!.getAttribute('data-atom')).toBe('0');
    const table = screen.getByRole('region', { name: 'Water — atoms and coordinates' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toContain('O — highlighted');
    expect(rows[2]!.textContent).not.toContain('highlighted');
    expect(rows[2]!.textContent).toContain('0.7554');
  });

  it('turns with the arrow keys, zooms with + and -, and resets with 0', () => {
    const { container } = render(<GeometryViewer geometry={parseXyz(WATER)} label="Water" />);
    const frame = screen.getByRole('application', { name: /Water — arrow keys turn it/ });
    expect(frame.getAttribute('tabindex')).toBe('0');
    expect(frame.getAttribute('aria-roledescription')).toBe('3D structure viewer');

    const start = positions(container);
    const startRadius = radius(container);
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(positions(container)).not.toBe(start);

    fireEvent.keyDown(frame, { key: '+' });
    expect(radius(container)).toBeCloseTo(startRadius * 1.25, 6);
    fireEvent.keyDown(frame, { key: '-' });
    expect(radius(container)).toBeCloseTo(startRadius, 6);

    fireEvent.keyDown(frame, { key: '0' });
    expect(positions(container)).toBe(start);
  });

  it('offers the same three actions as buttons, so nothing depends on knowing a key', () => {
    const { container } = render(<GeometryViewer geometry={parseXyz(WATER)} label="Water" />);
    const startRadius = radius(container);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(radius(container)).toBeGreaterThan(startRadius);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(radius(container)).toBeLessThan(startRadius);
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(radius(container)).toBeCloseTo(startRadius, 6);
  });

  it('eases a key step over animation frames unless the reader asked for less motion', async () => {
    reduced = false;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const { container } = render(<GeometryViewer geometry={parseXyz(WATER)} label="Water" />);
    const start = positions(container);
    fireEvent.keyDown(screen.getByRole('application', { name: /arrow keys/ }), {
      key: 'ArrowRight',
    });
    // Nothing moved synchronously: the step is scheduled, not applied.
    expect(positions(container)).toBe(start);
    expect(frames.length).toBe(1);
    // Drain the eased step.
    for (let i = 0; i < 20 && frames.length > 0; i += 1) {
      const next = frames.shift()!;
      await waitFor(() => next(0));
    }
    expect(positions(container)).not.toBe(start);
  });

  it('turns on a pointer drag', async () => {
    const { container } = render(<GeometryViewer geometry={parseXyz(WATER)} label="Water" />);
    const frame = screen.getByRole('application');
    // happy-dom lays nothing out; the drag is scaled by the drawn width, so give it one.
    frame.getBoundingClientRect = () => ({ width: 400, height: 300 }) as DOMRect;
    const start = positions(container);
    fireEvent.pointerDown(frame, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(frame, { clientX: 160, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    await waitFor(() => expect(positions(container)).not.toBe(start));
  });

  it('keeps the table and stops drawing above its atom limit', () => {
    const n = DRAWN_ATOM_LIMIT + 1;
    const lines = Array.from({ length: n }, (_, i) => `C ${i * 1.5} 0 0`);
    render(<GeometryViewer geometry={parseXyz(`${n}\n\n${lines.join('\n')}\n`)} label="Chain" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain(
      `${n} atoms is more than this viewer draws`,
    );
    expect(screen.getByText(`Atom table (${n})`)).toBeTruthy();
  });
});

const geometryView = (spec: Record<string, unknown>): ExhibitView & { spec: GeometrySpec } =>
  decodeExhibitView({
    ...VIEW,
    kind: 'geometry',
    title: 'Optimised water',
    spec: { kind: 'geometry', ...spec },
  }) as ExhibitView & { spec: GeometrySpec };

describe('the geometry spec', () => {
  it('reads an inline block with the service’s defaults', () => {
    const view = geometryView({ xyz: WATER });
    expect(view.spec).toEqual({
      kind: 'geometry',
      format: 'xyz',
      xyz: WATER,
      label: '',
      highlight_atoms: [],
    });
  });

  it('refuses a spec with both sources or neither, rather than choosing one', () => {
    expect(
      geometryView({ xyz: WATER, source: { calc_key: 'xtb_opt@6.7.1:ab:cd', name: 'xtbopt.xyz' } })
        .spec,
    ).toBeNull();
    expect(geometryView({}).spec).toBeNull();
    expect(geometryView({ xyz: WATER, highlight_atoms: [-1] }).spec).toBeNull();
  });

  it('stores exactly one of xyz, source and structure_id (hardening item 1)', () => {
    const raw = (spec: Record<string, unknown>) =>
      decodeExhibitView({
        ...VIEW,
        kind: 'geometry',
        spec: { kind: 'geometry', xyz: WATER },
        raw_spec: { kind: 'geometry', ...spec },
      }).raw_spec;
    expect(raw({ structure_id: 'st-water' })).toMatchObject({ structure_id: 'st-water' });
    expect(raw({ structure_id: 'st-water', xyz: WATER })).toBeNull();
    expect(
      raw({ structure_id: 'st-water', source: { calc_key: 'k@1:a:b', name: 'x.xyz' } }),
    ).toBeNull();
    expect(raw({ structure_id: '' })).toBeNull();
  });

  it('reads a resolved structure_id as the xyz it resolved to, or as nothing when it vanished', () => {
    expect(geometryView({ structure_id: 'st-water', xyz: WATER }).spec).toMatchObject({
      structure_id: 'st-water',
      xyz: WATER,
    });
    // Vanished: no xyz. Readable, so the view can say so rather than "cannot show".
    expect(geometryView({ structure_id: 'st-gone' }).spec).toMatchObject({
      structure_id: 'st-gone',
    });
    expect(
      geometryView({ structure_id: 'st-x', source: { calc_key: 'k@1:a:b', name: 'x.xyz' } }).spec,
    ).toBeNull();
  });
});

describe('a geometry artefact in the pane', () => {
  it('draws an inline block', async () => {
    const view = geometryView({ xyz: WATER, label: 'Water, GFN2', energy_hartree: -5.07 });
    render(<GeometryView view={view} spec={view.spec} />);
    const drawing = await screen.findByRole('img');
    expect(drawing.getAttribute('aria-label')).toMatch(/^Water, GFN2: H2O; 3 atoms/);
  });

  it('reads a cited calculation file through the byte route, encoded as one query parameter', async () => {
    const stub = stubFetch(
      () => new Response(WATER, { status: 200, headers: { 'content-type': 'chemical/x-xyz' } }),
    );
    restore = stub.restore;
    const view = geometryView({
      source: {
        calc_key: 'xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:abc123:def456',
        name: 'xtbopt.xyz',
      },
    });
    render(<GeometryView view={view} spec={view.spec} />);
    await screen.findByRole('img');
    expect(stub.calls[0]!.url).toBe(
      '/api/calc-artifacts/content?ref=xtb_opt%40gfn2%2Bxtb%2Bxtb-6.7.1%2Ftblite-0.4.0%3Aabc123%3Adef456%23xtbopt.xyz',
    );
    // The ref is shown, and the file itself can be taken away (C4).
    expect(
      screen.getByText('xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:abc123:def456#xtbopt.xyz'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download xtbopt.xyz' })).toBeTruthy();
  });

  it('says an evicted file is gone, rather than drawing anything', async () => {
    const stub = stubFetch(
      () =>
        // The service's own 404 (`routes/calc_artifacts.py`), not the BFF's bare `not found`.
        new Response(
          JSON.stringify({ detail: "'xtb_opt@6.7.1:a:b#gone.xyz' is no longer stored" }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    restore = stub.restore;
    const view = geometryView({ source: { calc_key: 'xtb_opt@6.7.1:a:b', name: 'gone.xyz' } });
    render(<GeometryView view={view} spec={view.spec} />);
    expect(await screen.findByText('The cited calculation file could not be read')).toBeTruthy();
    expect(screen.getByText(/no longer stored/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws a stored structure from the xyz the service resolved, naming the structure', async () => {
    const view = geometryView({ structure_id: 'st-water', xyz: WATER });
    render(<GeometryView view={view} spec={view.spec} />);
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.getByText('st-water')).toBeTruthy();
  });

  it('says a vanished stored structure is gone, and the strip says it in its own words', () => {
    const view = decodeExhibitView({
      ...VIEW,
      kind: 'geometry',
      spec: { kind: 'geometry', structure_id: 'st-gone' },
      raw_spec: { kind: 'geometry', structure_id: 'st-gone' },
      bindings: [
        {
          path: 'xyz',
          result_ref: '',
          tool: 'structure',
          pointer: 'st-gone',
          ok: false,
          error: 'structure not found',
        },
      ],
    }) as ExhibitView & { spec: GeometrySpec };
    render(
      <>
        <GoneSourcesStrip gone={goneBindings(view)} />
        <GeometryView view={view} spec={view.spec} />
      </>,
    );
    expect(screen.getByText('The stored structure is no longer available')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    const strip = screen.getByRole('note').textContent ?? '';
    expect(strip).toContain('st-gone');
    expect(strip).toContain('source no longer available');
    expect(strip).toContain('structure not found');
    // Not a tool result, so not the tool-result sentence.
    expect(strip).not.toContain('tool result');
  });

  it('names the line of a block that does not parse', async () => {
    const view = geometryView({ source: { calc_key: 'k@1:a:b', name: 'bad.xyz' } });
    const stub = stubFetch(() => new Response('2\n\nO 0 0 0\n', { status: 200 }));
    restore = stub.restore;
    render(<GeometryView view={view} spec={view.spec} />);
    expect(await screen.findByText('These coordinates cannot be drawn')).toBeTruthy();
    expect(screen.getByText(/says 2 atoms, but the block ends after 1/)).toBeTruthy();
  });
});
