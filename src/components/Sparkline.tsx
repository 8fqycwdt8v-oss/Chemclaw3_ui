/**
 * A series, drawn small: the app's one chart primitive (campaign best, scan profile, logD vs pH),
 * so series never disagree about what a line means.
 *
 * No y-axis unit: the wire carries none, so the endpoint shows the value as written, the caption
 * the service's key, plus the point count. One series, no legend; tokens for every colour; the last
 * point is emphasised. Each point has a `<title>` for hover. The plot stretches with
 * `preserveAspectRatio="none"`, so the endpoint dot is a positioned `<div>` (a `<circle>` would
 * become an ellipse).
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
