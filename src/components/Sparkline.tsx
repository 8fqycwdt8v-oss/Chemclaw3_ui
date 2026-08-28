/**
 * A series, drawn small.
 *
 * The one chart primitive in this app, and it is deliberately one: a campaign's running best, a
 * scan profile and logD across pH are all "a run of numbers whose shape is the reading", and three
 * chart components would be three chances for them to disagree about what a line means.
 *
 * ## What it will not do
 *
 * It does not label the y axis, because nothing on the wire carries a unit — `tool_result.numbers`
 * and the arrays inside a stored result are bare. Drawing "72 %" beside a number the service never
 * called a percentage is the same class of invention as pairing an unlabelled `[4.76, 1.6]` into
 * "pKa 4.76 ± 1.6". So the endpoint is labelled with the value as written, the caller supplies the
 * key the service filed the series under, and the reader is told how many points there are.
 *
 * ## The marks
 *
 * One series, so there is no legend and no categorical palette — the caption names it. The line is
 * 2px with a soft area under it, the grid is two hairlines rather than a lattice, and the only
 * emphasised point is the last one, because "where did this end up" is the question a series in a
 * chat answer is being asked. Every colour comes from a token, so both themes are one definition.
 *
 * Each point carries a `<title>`, which is the cheapest honest hover layer there is: it needs no
 * script, survives keyboard focus on the group, and says the index and the value rather than
 * inventing a tooltip vocabulary.
 *
 * ## Why the endpoint dot is a `<div>` and not a `<circle>`
 *
 * The plot is stretched to its container with `preserveAspectRatio="none"`, which is what lets one
 * viewBox serve a 300px card and a 900px bleed at a constant height. Strokes survive that with
 * `vector-effect`; a circle does not — it becomes an ellipse, and the wider the card the more
 * obviously. The last point is always at the right edge, so its marker can be positioned in CSS
 * from one number and stay round at every width.
 */

import { cn } from '@/lib/utils';

const WIDTH = 300;
const HEIGHT = 92;
const PAD = { top: 8, right: 8, bottom: 8, left: 8 };

export function Sparkline({
  values,
  label,
  className,
}: {
  values: readonly number[];
  /** What the service called this series. Used in the accessible description, never invented. */
  label: string;
  className?: string;
}): React.JSX.Element | null {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series is a real answer — "nothing moved" — so it is drawn as a line through the middle
  // rather than divided by a zero range.
  const span = max - min || 1;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (i * innerW) / (values.length - 1);
  const y = (v: number): number => PAD.top + innerH - ((v - min) / span) * innerH;

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${PAD.left},${(HEIGHT - PAD.bottom).toFixed(1)} ${points} ${(
    WIDTH - PAD.right
  ).toFixed(1)},${(HEIGHT - PAD.bottom).toFixed(1)}`;
  const last = values[values.length - 1]!;

  // Where the last point sits, as a fraction of the box — the one number the CSS marker needs.
  const endTop = y(last) / HEIGHT;

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${values.length} points, from ${values[0]} to ${last}, lowest ${min}, highest ${max}.`}
        className="h-20 w-full"
      >
        {/* Recessive: two hairlines, not a lattice. `vector-effect` keeps every stroke at its
          intended width under the non-uniform scale this viewBox is stretched by. */}
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top}
          y2={PAD.top}
          className="stroke-border-subtle"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={HEIGHT - PAD.bottom}
          y2={HEIGHT - PAD.bottom}
          className="stroke-border-subtle"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <polygon points={area} className="fill-brand/15" />
        <polyline
          points={points}
          fill="none"
          className="stroke-brand"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {values.map((v, i) => (
          <rect
            key={i}
            x={x(i) - innerW / values.length / 2}
            y={0}
            width={innerW / values.length}
            height={HEIGHT}
            fill="transparent"
          >
            <title>{`${i + 1}: ${v}`}</title>
          </rect>
        ))}
      </svg>
      {/* The endpoint is the only emphasised mark. Its ring is the surface colour, so the dot
          reads as sitting on the line rather than being cut out of it. */}
      <span
        aria-hidden
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand ring-2 ring-surface-raised"
        style={{ left: `calc(100% - ${PAD.right}px)`, top: `${(endTop * 100).toFixed(2)}%` }}
      />
    </div>
  );
}
