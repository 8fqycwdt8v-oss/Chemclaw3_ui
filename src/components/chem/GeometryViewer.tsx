/**
 * A 3D structure, drawn ball-and-stick, turned by hand — with a table under it that says the same.
 *
 * The drawing half of `src/chem/geometry.ts`, which holds every number this component draws. It is
 * loaded lazily (`GeometryView` imports it with `lazy()`), because only a `geometry` artefact needs
 * it and `check:bundle` budgets the first load.
 *
 * ## SVG, not `<canvas>`
 *
 * Both were open. SVG is chosen because the things this viewer must *also* be are things a canvas
 * cannot: every mark is in the DOM, so the drawing prints with the pane's print stylesheet, scales
 * without a resize listener, and is a node a test can count under happy-dom (which has no 2D
 * context). The usual cost — DOM work per frame — is bounded here by the service's own atom cap
 * (`exhibit_max_atoms`, 500), and above `DRAWN_ATOM_LIMIT` the viewer stops drawing and keeps the
 * table rather than freezing the pane.
 *
 * ## Operable without a pointer, readable without sight
 *
 * - The frame is one focusable `application` — the role that tells a screen reader to hand the
 *   arrow keys to the page rather than read by line with them — and arrow keys turn it (Shift for
 *   a larger step), `+`/`-` zoom, `0` resets. The same three actions are buttons beside it, so nothing depends on knowing a key.
 * - The drawing is an `img` whose name is the summary — the formula, the atom count, the energy —
 *   and the **atom table** under it lists every atom with its element and coordinates, highlighted
 *   ones marked in words. A screen-reader user gets the structure; a sighted user can check one
 *   coordinate against the calculation it came from.
 * - `prefers-reduced-motion`: a key press turns the view in a short eased step by default, and in
 *   one jump when the reader asked for less motion. Nothing ever moves on its own.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import {
  IDENTITY,
  depthOpacity,
  elementColour,
  formula,
  isKnownElement,
  paint,
  perceiveBonds,
  project,
  turn,
  type Camera,
  type Geometry,
} from '../../chem/geometry.ts';
import { formatEnergy } from '../../lib/format.ts';
import { Button } from '@/components/ui/button';

/** The frame, in SVG user units. Fixed, so the projection never needs a measurement. */
const FRAME_W = 400;
const FRAME_H = 300;

/** One arrow-key press, and one with Shift — fifteen and forty-five degrees. */
const KEY_STEP = Math.PI / 12;
const KEY_STEP_LARGE = Math.PI / 4;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 8;
/** How long an eased key step takes, in frames (~120 ms at 60 Hz). */
const EASE_FRAMES = 8;

/**
 * Above this many atoms the drawing is not made and the table carries the structure alone.
 *
 * Four times the service's inline cap, because a *cited* calc artifact has no cap of its own;
 * past it, per-frame DOM work makes the pane stutter on a laptop, and a frozen pane is worse than
 * a table.
 */
export const DRAWN_ATOM_LIMIT = 2000;

const START: Camera = { rotation: IDENTITY, zoom: 1 };

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** Whether the reader asked for less motion. Read live, so a change mid-session is honoured. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const coordinate = (value: number): string => value.toFixed(4);

export interface GeometryViewerProps {
  geometry: Geometry;
  /** What the structure is called — the artefact's label, or its title. */
  label: string;
  /** 0-based atom indices to ring, as the spec's `highlight_atoms` gives them. */
  highlight?: readonly number[];
  /** The energy the artefact states, shown as stated. Not computed here. */
  energyHartree?: number;
}

export function GeometryViewer({
  geometry,
  label,
  highlight = [],
  energyHartree,
}: GeometryViewerProps): React.JSX.Element {
  const { atoms } = geometry;
  const bonds = useMemo(() => perceiveBonds(atoms), [atoms]);
  const [camera, setCamera] = useState<Camera>(START);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const pending = useRef({ dx: 0, dy: 0, frame: 0 });
  const frameRef = useRef<HTMLDivElement | null>(null);
  // A gradient id per element, unique to this instance: two viewers on one page must not share
  // `url(#…)` targets, and `useId`'s own characters are not all legal in one.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const highlighted = useMemo(() => new Set(highlight), [highlight]);
  const drawn = atoms.length <= DRAWN_ATOM_LIMIT;

  const marks = useMemo(
    () => (drawn ? paint(project(atoms, camera, FRAME_W, FRAME_H), bonds) : []),
    [atoms, bonds, camera, drawn],
  );
  const elements = useMemo(() => [...new Set(atoms.map((a) => a.element))], [atoms]);

  const summary = [
    `${label || 'Structure'}: ${formula(atoms)}`,
    `${atoms.length} atom${atoms.length === 1 ? '' : 's'}, ${bonds.length} bond${bonds.length === 1 ? '' : 's'} by distance`,
    energyHartree !== undefined ? `energy ${formatEnergy(energyHartree)}` : null,
    highlight.length > 0 ? `${highlight.length} highlighted` : null,
  ]
    .filter(Boolean)
    .join('; ');

  /** Turn by `(dx, dy)` radians, eased over a few frames unless the reader asked for no motion. */
  const step = useCallback((dx: number, dy: number) => {
    if (prefersReducedMotion()) {
      setCamera((c) => ({ ...c, rotation: turn(c.rotation, dx, dy) }));
      return;
    }
    let left = EASE_FRAMES;
    const tick = (): void => {
      setCamera((c) => ({ ...c, rotation: turn(c.rotation, dx / EASE_FRAMES, dy / EASE_FRAMES) }));
      left -= 1;
      if (left > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setCamera((c) => ({ ...c, zoom: clampZoom(c.zoom * factor) }));
  }, []);

  // The wheel needs a non-passive listener to keep the pane from scrolling under the zoom, and
  // React registers `onWheel` as passive — so it is attached here, on the frame only.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const queued = pending.current;
    return () => cancelAnimationFrame(queued.frame);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const by = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const act: Record<string, () => void> = {
      ArrowLeft: () => step(-by, 0),
      ArrowRight: () => step(by, 0),
      ArrowUp: () => step(0, -by),
      ArrowDown: () => step(0, by),
      '+': () => zoomBy(ZOOM_STEP),
      '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP),
      '0': () => setCamera(START),
      Home: () => setCamera(START),
    };
    const action = act[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = drag.current;
    if (!from || from.id !== event.pointerId) return;
    // A drag across the whole frame is half a turn, whatever size the frame is drawn at.
    const across = Math.max(1, event.currentTarget.getBoundingClientRect().width);
    const queued = pending.current;
    queued.dx += ((event.clientX - from.x) / across) * Math.PI;
    queued.dy += ((event.clientY - from.y) / across) * Math.PI;
    drag.current = { ...from, x: event.clientX, y: event.clientY };
    // One state update per animation frame, however many pointer events arrive inside it.
    if (queued.frame) return;
    queued.frame = requestAnimationFrame(() => {
      const { dx, dy } = queued;
      queued.dx = 0;
      queued.dy = 0;
      queued.frame = 0;
      setCamera((c) => ({ ...c, rotation: turn(c.rotation, dx, dy) }));
    });
  };
  const endDrag = (): void => {
    drag.current = null;
  };

  return (
    <figure className="flex flex-col gap-2">
      {drawn ? (
        <>
          {/* An `application` is a widget that takes its own keys — the role this frame is — but
              `jsx-a11y` classes it with the static landmarks, so both rules below are about a kind
              of element this is not. The `Resizer`'s separator carries the same two exemptions for
              the same reason, and axe passes both in `e2e/a11y.spec.ts`. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={frameRef}
            role="application"
            aria-roledescription="3D structure viewer"
            aria-label={`${label || 'Structure'} — arrow keys turn it, plus and minus zoom, 0 resets`}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="cursor-grab touch-none rounded-lg border border-border-subtle bg-surface-raised text-ink-muted select-none focus-ring active:cursor-grabbing"
          >
            <svg
              viewBox={`0 0 ${FRAME_W} ${FRAME_H}`}
              role="img"
              aria-label={summary}
              className="block h-auto w-full"
            >
              <defs>
                {elements.map((element) => (
                  <radialGradient key={element} id={`${uid}-${element}`} cx="35%" cy="35%" r="65%">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
                    <stop offset="35%" stopColor={elementColour(element)} />
                    <stop offset="100%" stopColor={elementColour(element)} stopOpacity="0.75" />
                  </radialGradient>
                ))}
              </defs>
              {marks.map((mark) => {
                if (mark.kind === 'bond') {
                  const width = Math.max(1.5, Math.min(mark.from.radius, mark.to.radius) * 0.45);
                  return (
                    <g
                      key={`b${mark.from.index}-${mark.to.index}`}
                      opacity={depthOpacity((mark.from.nearness + mark.to.nearness) / 2)}
                      strokeLinecap="round"
                    >
                      <line
                        x1={mark.x1}
                        y1={mark.y1}
                        x2={mark.x2}
                        y2={mark.y2}
                        stroke="currentColor"
                        strokeWidth={width + 1.5}
                      />
                      <line
                        x1={mark.x1}
                        y1={mark.y1}
                        x2={mark.x2}
                        y2={mark.y2}
                        stroke={elementColour(atoms[mark.from.index]!.element)}
                        strokeWidth={width}
                      />
                    </g>
                  );
                }
                const { atom } = mark;
                const element = atoms[atom.index]!.element;
                return (
                  <g
                    key={`a${atom.index}`}
                    opacity={depthOpacity(atom.nearness)}
                    data-atom={atom.index}
                  >
                    <circle
                      cx={atom.sx}
                      cy={atom.sy}
                      r={atom.radius}
                      fill={`url(#${uid}-${element})`}
                      stroke="currentColor"
                      strokeWidth={0.75}
                    />
                    {highlighted.has(atom.index) && (
                      <circle
                        cx={atom.sx}
                        cy={atom.sy}
                        r={atom.radius + 3}
                        fill="none"
                        className="stroke-brand"
                        strokeWidth={2}
                        strokeDasharray="3 2"
                        data-highlight=""
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div data-print="hide" className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="xs" onClick={() => zoomBy(ZOOM_STEP)}>
              <ZoomIn aria-hidden className="size-3.5" />
              Zoom in
            </Button>
            <Button variant="outline" size="xs" onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <ZoomOut aria-hidden className="size-3.5" />
              Zoom out
            </Button>
            <Button variant="outline" size="xs" onClick={() => setCamera(START)}>
              <RotateCcw aria-hidden className="size-3.5" />
              Reset view
            </Button>
            <span className="text-2xs text-ink-subtle">Drag or use the arrow keys to turn it.</span>
          </div>
        </>
      ) : (
        <p role="note" className="text-xs text-ink-muted">
          {atoms.length} atoms is more than this viewer draws ({DRAWN_ATOM_LIMIT}); every atom is in
          the table below, and the XYZ download has the whole structure.
        </p>
      )}

      <figcaption className="text-2xs text-ink-muted">
        <span className="font-mono">{formula(atoms)}</span> · {atoms.length} atom
        {atoms.length === 1 ? '' : 's'}
        {energyHartree !== undefined && (
          <>
            {' '}
            · <span className="font-mono tabular-nums">{formatEnergy(energyHartree)}</span>
          </>
        )}
        {geometry.frames > 1 && <> · first of {geometry.frames} frames in the file</>}. Bonds are
        drawn by distance (covalent radii); no bond orders are implied.
      </figcaption>

      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted focus-ring">
          Atom table ({atoms.length})
        </summary>
        <div
          tabIndex={0}
          role="region"
          aria-label={`${label || 'Structure'} — atoms and coordinates`}
          className="mt-1 max-h-72 overflow-auto rounded-lg border border-border-subtle focus-ring"
        >
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-sunken text-2xs text-ink-subtle">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  #
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  Element
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  x (Å)
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  y (Å)
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  z (Å)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle font-mono tabular-nums">
              {atoms.map((atom, index) => (
                <tr key={index} className={highlighted.has(index) ? 'bg-brand-soft' : undefined}>
                  {/* 0-based, as `highlight_atoms` and every program's array index count. */}
                  <td className="px-2 py-0.5">{index}</td>
                  <td className="px-2 py-0.5 font-sans">
                    {atom.element}
                    {!isKnownElement(atom.element) && ' (unrecognised)'}
                    {highlighted.has(index) && ' — highlighted'}
                  </td>
                  <td className="px-2 py-0.5 text-right">{coordinate(atom.x)}</td>
                  <td className="px-2 py-0.5 text-right">{coordinate(atom.y)}</td>
                  <td className="px-2 py-0.5 text-right">{coordinate(atom.z)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
