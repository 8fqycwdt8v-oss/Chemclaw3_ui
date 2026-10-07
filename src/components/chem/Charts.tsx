/**
 * The two charts a Bayesian-optimization result needs, as inline SVG (no charting dependency).
 *
 * 1. Nothing is encoded in colour alone, and each chart sits beside the numbers it draws. 2. Axes
 * carry the objective's name and direction. 3. Colours come from the design tokens.
 *
 * `SeriesChart.tsx` (artefacts) follows the same rules and reuses this geometry. Coordinates are
 * viewBox units, so `fontSize` is an SVG attribute.
 */

import { useId } from 'react';

/** The drawing area, in viewBox units. Wide and short: a progress series is read left to right. */
export const WIDTH = 360;
export const HEIGHT = 168;
export const PAD = { top: 14, right: 16, bottom: 30, left: 48 } as const;
export const INNER_W = WIDTH - PAD.left - PAD.right;
export const INNER_H = HEIGHT - PAD.top - PAD.bottom;

/**
 * A numeric domain never narrower than `floor` (callers pass the assay noise), so a flat series
 * does not divide by zero.
 */
export function domainOf(values: readonly number[], floor: number): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = Math.max(span * 0.12, floor / 2, Math.abs(max) * 1e-6, Number.MIN_VALUE);
  return { min: min - pad, max: max + pad };
}

/** Four significant figures, trailing zeros dropped — the precision these models report to. */
export function sig(value: number, digits = 4): string {
  return Number(value.toPrecision(digits)).toString();
}

/** The arrow a chemist reads as "this way is better". Not exported: an axis label is this file's. */
const directionMark = (direction: string): string =>
  direction === 'minimize' ? '↓ lower is better' : '↑ higher is better';

/**
 * The running best after each evaluation, with the assay noise drawn as a band around it: gains
 * inside the band are not distinguishable from the current best. Drawn as a step (it holds until
 * beaten), never interpolated.
 */
export function BestSoFarChart({
  series,
  objective,
  direction,
  noise,
  best,
}: {
  /** `CampaignProgress.best_so_far` — the running best after each evaluation, in run order. */
  series: readonly number[];
  objective: string;
  direction: string;
  /** `assay_noise`, in the objective's own units. */
  noise: number;
  /** `best_value` — the current best, which the band is centred on. */
  best: number;
}): React.JSX.Element {
  const titleId = useId();
  const descId = useId();
  const n = series.length;
  const { min, max } = domainOf([...series, best - noise, best + noise], noise);

  const xAt = (index: number): number =>
    n === 1 ? PAD.left + INNER_W / 2 : PAD.left + (index * INNER_W) / (n - 1);
  const yAt = (value: number): number =>
    PAD.top + INNER_H - ((value - min) / (max - min)) * INNER_H;

  // Step-after with `H`/`V`: a diagonal would draw values never measured.
  const path = series
    .map((value, index) =>
      index === 0 ? `M ${xAt(0)} ${yAt(value)}` : `H ${xAt(index)} V ${yAt(value)}`,
    )
    .join(' ');

  const bandTop = yAt(best + noise);
  const bandBottom = yAt(best - noise);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
    >
      <title id={titleId}>
        Best {objective} so far, over {n} evaluation(s)
      </title>
      <desc id={descId}>
        {/*
          "improving", not "rising": a minimized objective's best falls.
        */}
        A step chart of the running best {objective} ({directionMark(direction)}), improving from{' '}
        {sig(series[0] ?? best)} to {sig(best)}. The shaded band spans ±{sig(noise)} around the
        current best — the assay&rsquo;s own reproducibility, so any value inside it is not
        distinguishable from the best already in hand.
      </desc>

      {/* The noise band first, so the series draws over it. */}
      <rect
        x={PAD.left}
        y={Math.min(bandTop, bandBottom)}
        width={INNER_W}
        height={Math.abs(bandBottom - bandTop)}
        className="fill-warn-soft"
      />
      <line
        x1={PAD.left}
        x2={PAD.left + INNER_W}
        y1={yAt(best)}
        y2={yAt(best)}
        strokeDasharray="3 3"
        strokeWidth={1}
        className="stroke-warn"
      />

      {/* Frame: left and bottom only — a full box adds ink and says nothing. */}
      <line
        x1={PAD.left}
        x2={PAD.left}
        y1={PAD.top}
        y2={PAD.top + INNER_H}
        strokeWidth={1}
        className="stroke-border-strong"
      />
      <line
        x1={PAD.left}
        x2={PAD.left + INNER_W}
        y1={PAD.top + INNER_H}
        y2={PAD.top + INNER_H}
        strokeWidth={1}
        className="stroke-border-strong"
      />

      <path d={path} fill="none" strokeWidth={1.75} className="stroke-brand" />

      {/* Every evaluation as a dot, so a reader can count the runs behind the line. */}
      {series.map((value, index) => (
        <circle key={index} cx={xAt(index)} cy={yAt(value)} r={1.8} className="fill-brand" />
      ))}

      {/* The current best, marked and named — a ring rather than a colour, so the mark survives
          a monochrome print and a reader who cannot separate the two blues. */}
      <circle
        cx={xAt(n - 1)}
        cy={yAt(best)}
        r={4}
        fill="none"
        strokeWidth={1.75}
        className="stroke-brand"
      />
      <text
        x={Math.min(xAt(n - 1) + 7, WIDTH - PAD.right)}
        y={yAt(best) - 6}
        fontSize={9}
        textAnchor="end"
        className="fill-current text-ink"
      >
        best {sig(best)}
      </text>

      <text x={2} y={PAD.top + 4} fontSize={9} className="fill-current text-ink-subtle">
        {sig(max)}
      </text>
      <text x={2} y={PAD.top + INNER_H} fontSize={9} className="fill-current text-ink-subtle">
        {sig(min)}
      </text>
      <text x={PAD.left} y={HEIGHT - 8} fontSize={9} className="fill-current text-ink-subtle">
        evaluation 1
      </text>
      <text
        x={PAD.left + INNER_W}
        y={HEIGHT - 8}
        fontSize={9}
        textAnchor="end"
        className="fill-current text-ink-subtle"
      >
        {n}
      </text>
      <text
        x={PAD.left + INNER_W / 2}
        y={HEIGHT - 19}
        fontSize={9}
        textAnchor="middle"
        className="fill-current text-ink-subtle"
      >
        {objective} · {directionMark(direction)}
      </text>
    </svg>
  );
}

/** One axis of a trade-off: which objective, which way is better, and what the runs spanned. */
export interface ParetoAxis {
  name: string;
  direction: string;
  /** `ObjectiveScale.observed_min` / `observed_max` — the span of **every** run supplied, which is
   *  why the front sits inside the frame rather than filling it. */
  min: number;
  max: number;
}

/** One point on the front: its two objective values, and the conditions that produced them. */
export interface ParetoPoint {
  x: number;
  y: number;
  /**
   * The run's conditions, as the mark's `<title>`, so each point can be matched to its table row.
   */
  label: string;
}

/**
 * The Pareto front of a two-objective campaign — exactly two axes (with three or more,
 * `SuggestionResult` shows a table instead). The dashed line joining front members is not data; the
 * `<desc>` says so.
 */
export function ParetoScatter({
  x,
  y,
  points,
}: {
  x: ParetoAxis;
  y: ParetoAxis;
  points: readonly ParetoPoint[];
}): React.JSX.Element {
  const titleId = useId();
  const descId = useId();
  const xs = domainOf([x.min, x.max, ...points.map((p) => p.x)], 0);
  const ys = domainOf([y.min, y.max, ...points.map((p) => p.y)], 0);

  const xAt = (value: number): number =>
    PAD.left + ((value - xs.min) / (xs.max - xs.min)) * INNER_W;
  const yAt = (value: number): number =>
    PAD.top + INNER_H - ((value - ys.min) / (ys.max - ys.min)) * INNER_H;

  const ordered = [...points].sort((a, b) => a.x - b.x);
  const connector = ordered
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(p.x)} ${yAt(p.y)}`)
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
    >
      <title id={titleId}>
        Trade-off between {x.name} and {y.name}: {points.length} run(s) on the front
      </title>
      <desc id={descId}>
        A scatter of the {points.length} run(s) nothing else beats on both objectives at once.
        Horizontal axis {x.name} ({directionMark(x.direction)}), vertical axis {y.name} (
        {directionMark(y.direction)}). The dashed line joins them in order of {x.name} to show the
        shape of the trade-off; no run lies on it between the marked points. Every point is listed
        with its conditions in the table below.
      </desc>

      <line
        x1={PAD.left}
        x2={PAD.left}
        y1={PAD.top}
        y2={PAD.top + INNER_H}
        strokeWidth={1}
        className="stroke-border-strong"
      />
      <line
        x1={PAD.left}
        x2={PAD.left + INNER_W}
        y1={PAD.top + INNER_H}
        y2={PAD.top + INNER_H}
        strokeWidth={1}
        className="stroke-border-strong"
      />

      {points.length > 1 && (
        <path
          d={connector}
          fill="none"
          strokeWidth={1}
          strokeDasharray="4 3"
          className="stroke-brand opacity-60"
        />
      )}

      {ordered.map((point, index) => (
        <circle
          key={`${point.label}-${index}`}
          cx={xAt(point.x)}
          cy={yAt(point.y)}
          r={4}
          strokeWidth={1.5}
          className="fill-brand-soft stroke-brand"
        >
          <title>
            {point.label} — {x.name} {sig(point.x)}, {y.name} {sig(point.y)}
          </title>
        </circle>
      ))}

      <text x={2} y={PAD.top + 4} fontSize={9} className="fill-current text-ink-subtle">
        {sig(ys.max)}
      </text>
      <text x={2} y={PAD.top + INNER_H} fontSize={9} className="fill-current text-ink-subtle">
        {sig(ys.min)}
      </text>
      <text x={PAD.left} y={HEIGHT - 19} fontSize={9} className="fill-current text-ink-subtle">
        {sig(xs.min)}
      </text>
      <text
        x={PAD.left + INNER_W}
        y={HEIGHT - 19}
        fontSize={9}
        textAnchor="end"
        className="fill-current text-ink-subtle"
      >
        {sig(xs.max)}
      </text>
      <text
        x={PAD.left + INNER_W / 2}
        y={HEIGHT - 6}
        fontSize={9}
        textAnchor="middle"
        className="fill-current text-ink-subtle"
      >
        {x.name} · {directionMark(x.direction)}
      </text>
      <text
        transform={`rotate(-90 ${12} ${PAD.top + INNER_H / 2})`}
        x={12}
        y={PAD.top + INNER_H / 2}
        fontSize={9}
        textAnchor="middle"
        className="fill-current text-ink-subtle"
      >
        {y.name} · {directionMark(y.direction)}
      </text>
    </svg>
  );
}
