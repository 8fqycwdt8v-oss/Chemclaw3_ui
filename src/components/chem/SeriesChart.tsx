/**
 * The general chart an artefact draws — line, scatter or bar — kept out of `Charts.tsx`.
 *
 * A file of its own rather than a third export beside `BestSoFarChart` and `ParetoScatter`, and
 * the reason is the bundle rather than taste: `Charts.tsx` is imported by the result registry,
 * which is on the first load, while this is drawn only inside the artefact pane, which is lazy.
 * Measured, keeping it there spent most of `check:bundle`'s gzip headroom on a chart a conversation
 * without artefacts never draws. The geometry and the domain rule are `Charts.tsx`'s, imported, so
 * the three charts still share one coordinate system and one honest-domain rule.
 */

import { useId } from 'react';
import { HEIGHT, INNER_H, INNER_W, PAD, WIDTH, domainOf, sig } from './Charts.tsx';

/** One named series. `x` holds numbers, or category names for a bar chart. */
export interface ChartSeriesData {
  name: string;
  x: readonly (number | string)[];
  y: readonly number[];
}

/**
 * How series are told apart **without colour** — rule 1 above, applied to more than one series.
 *
 * A marker shape and a stroke pattern per series, cycling together, so a monochrome print and a
 * reader who cannot separate the token hues still have two independent cues. The tone is the third
 * cue, never the only one. Four, because a chart of an artefact with more series than that is a
 * table pretending to be a figure, and the table under it is the reading that scales.
 */
const SERIES_STYLES = [
  { tone: 'stroke-brand fill-brand', dash: undefined, mark: 'circle' },
  { tone: 'stroke-warn fill-warn', dash: '5 3', mark: 'square' },
  { tone: 'stroke-ok fill-ok', dash: '1.5 2.5', mark: 'triangle' },
  { tone: 'stroke-danger fill-danger', dash: '7 2 1.5 2', mark: 'diamond' },
] as const;

const styleOf = (index: number) => SERIES_STYLES[index % SERIES_STYLES.length]!;

/** A marker at (x, y) in the series' own shape. */
function Mark({
  shape,
  x,
  y,
  className,
  children,
}: {
  shape: (typeof SERIES_STYLES)[number]['mark'];
  x: number;
  y: number;
  className: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const r = 3;
  if (shape === 'square') {
    return (
      <rect x={x - r} y={y - r} width={2 * r} height={2 * r} className={className}>
        {children}
      </rect>
    );
  }
  if (shape === 'triangle') {
    return (
      <polygon
        points={`${x},${y - r - 0.5} ${x + r},${y + r} ${x - r},${y + r}`}
        className={className}
      >
        {children}
      </polygon>
    );
  }
  if (shape === 'diamond') {
    return (
      <polygon
        points={`${x},${y - r - 1} ${x + r + 1},${y} ${x},${y + r + 1} ${x - r - 1},${y}`}
        className={className}
      >
        {children}
      </polygon>
    );
  }
  return (
    <circle cx={x} cy={y} r={r} className={className}>
      {children}
    </circle>
  );
}

/**
 * A line, scatter or bar chart of literal series — `BestSoFarChart` and `ParetoScatter`,
 * generalised for the one consumer that cannot know its data's meaning in advance: an artefact.
 *
 * **What it keeps from the two it generalises**: geometry in viewBox units, colour from tokens, a
 * frame on two sides only, and a `<title>`/`<desc>` that say in words what the drawing says in
 * marks. **What it deliberately does not take**: the noise band and the direction arrow. Both are
 * statements about an *objective* — "anything inside ±2% is not a gain", "lower is better" — that
 * a BO result carries and an artefact's series does not, so drawing either here would invent a
 * claim the data never made. The axis labels are the agent's own `x_label`/`y_label`, units and
 * all, and nothing here adds a unit they did not state.
 *
 * Not a library, for the reason at the top of this file. The caller renders the same numbers as a
 * table beside it (`ChartView`), which is the accessible reading of the chart rather than a
 * fallback for it.
 */
export function SeriesChart({
  chart,
  xLabel,
  yLabel,
  series,
}: {
  chart: 'line' | 'scatter' | 'bar';
  xLabel: string;
  yLabel: string;
  series: readonly ChartSeriesData[];
}): React.JSX.Element {
  const titleId = useId();
  const descId = useId();
  const ys = series.flatMap((s) => s.y);
  // A bar starts at zero or it lies about proportion; a line or a scatter frames its data.
  const yDomain =
    chart === 'bar'
      ? { min: Math.min(0, ...ys), max: domainOf([0, ...ys], 0).max }
      : domainOf(ys.length > 0 ? ys : [0], 0);
  const yAt = (value: number): number =>
    PAD.top + INNER_H - ((value - yDomain.min) / (yDomain.max - yDomain.min)) * INNER_H;

  // Categories in first-seen order across every series, for a bar chart.
  const categories =
    chart === 'bar' ? [...new Set(series.flatMap((s) => s.x.map((x) => String(x))))] : [];
  const xsNumeric = series.flatMap((s) => s.x.filter((x): x is number => typeof x === 'number'));
  const xDomain = domainOf(xsNumeric.length > 0 ? xsNumeric : [0], 0);
  const xAt = (value: number): number =>
    PAD.left + ((value - xDomain.min) / (xDomain.max - xDomain.min)) * INNER_W;

  const band = categories.length > 0 ? INNER_W / categories.length : INNER_W;
  const barWidth = Math.max(2, (band * 0.7) / Math.max(1, series.length));
  const zeroY = yAt(Math.max(yDomain.min, Math.min(0, yDomain.max)));

  const points = series.reduce((n, s) => n + Math.min(s.x.length, s.y.length), 0);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      data-chart={chart}
    >
      <title id={titleId}>
        {yLabel} against {xLabel}: {series.length} series, {points} point(s)
      </title>
      <desc id={descId}>
        A {chart} chart. Horizontal axis {xLabel}, vertical axis {yLabel}
        {chart === 'bar'
          ? `, starting at zero`
          : `, from ${sig(yDomain.min)} to ${sig(yDomain.max)}`}
        .
        {series.length > 1 &&
          ` Series are told apart by marker shape and line pattern: ${series
            .map((s, i) => `${s.name} (${styleOf(i).mark})`)
            .join(', ')}.`}{' '}
        Every value is listed in the table below the chart.
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

      {series.map((s, index) => {
        const style = styleOf(index);
        const pairs = s.y
          .slice(0, s.x.length)
          .map((y, i) => ({ x: s.x[i]!, y }))
          .filter((p) => chart === 'bar' || typeof p.x === 'number');
        if (chart === 'bar') {
          return (
            <g key={`${s.name}-${index}`}>
              {pairs.map((p, i) => {
                const slot = categories.indexOf(String(p.x));
                const left = PAD.left + slot * band + band * 0.15 + index * barWidth;
                const top = Math.min(yAt(p.y), zeroY);
                return (
                  <rect
                    key={i}
                    x={left}
                    y={top}
                    width={barWidth - 1}
                    height={Math.max(0.5, Math.abs(zeroY - yAt(p.y)))}
                    strokeWidth={1}
                    strokeDasharray={style.dash}
                    fillOpacity={0.35}
                    className={style.tone}
                  >
                    <title>
                      {s.name} — {String(p.x)}: {sig(p.y)}
                    </title>
                  </rect>
                );
              })}
            </g>
          );
        }
        const ordered = [...pairs].sort((a, b) => (a.x as number) - (b.x as number));
        const path = ordered
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(p.x as number)} ${yAt(p.y)}`)
          .join(' ');
        return (
          <g key={`${s.name}-${index}`}>
            {chart === 'line' && ordered.length > 1 && (
              <path
                d={path}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={style.dash}
                className={style.tone.split(' ')[0]}
              />
            )}
            {ordered.map((p, i) => (
              <Mark
                key={i}
                shape={style.mark}
                x={xAt(p.x as number)}
                y={yAt(p.y)}
                className={style.tone}
              >
                <title>
                  {s.name} — {xLabel} {sig(p.x as number)}, {yLabel} {sig(p.y)}
                </title>
              </Mark>
            ))}
          </g>
        );
      })}

      <text x={2} y={PAD.top + 4} fontSize={9} className="fill-current text-ink-subtle">
        {sig(yDomain.max)}
      </text>
      <text x={2} y={PAD.top + INNER_H} fontSize={9} className="fill-current text-ink-subtle">
        {sig(yDomain.min)}
      </text>
      {chart === 'bar' ? (
        categories.map((category, i) => (
          <text
            key={category}
            x={PAD.left + i * band + band / 2}
            y={HEIGHT - 19}
            fontSize={8}
            textAnchor="middle"
            className="fill-current text-ink-subtle"
          >
            {category.length > 10 ? `${category.slice(0, 9)}…` : category}
          </text>
        ))
      ) : (
        <>
          <text x={PAD.left} y={HEIGHT - 19} fontSize={9} className="fill-current text-ink-subtle">
            {sig(xDomain.min)}
          </text>
          <text
            x={PAD.left + INNER_W}
            y={HEIGHT - 19}
            fontSize={9}
            textAnchor="end"
            className="fill-current text-ink-subtle"
          >
            {sig(xDomain.max)}
          </text>
        </>
      )}
      <text
        x={PAD.left + INNER_W / 2}
        y={HEIGHT - 6}
        fontSize={9}
        textAnchor="middle"
        className="fill-current text-ink-subtle"
      >
        {xLabel}
      </text>
      <text
        transform={`rotate(-90 ${12} ${PAD.top + INNER_H / 2})`}
        x={12}
        y={PAD.top + INNER_H / 2}
        fontSize={9}
        textAnchor="middle"
        className="fill-current text-ink-subtle"
      >
        {yLabel}
      </text>
    </svg>
  );
}

/** The legend's swatch for series `index`: the same shape and pattern the chart draws it with. */
export function SeriesSwatch({ index }: { index: number }): React.JSX.Element {
  const style = styleOf(index);
  return (
    <svg viewBox="0 0 24 10" className="inline-block h-2.5 w-6 align-middle" aria-hidden>
      <line
        x1={0}
        x2={24}
        y1={5}
        y2={5}
        strokeWidth={1.5}
        strokeDasharray={style.dash}
        className={style.tone.split(' ')[0]}
      />
      <Mark shape={style.mark} x={12} y={5} className={style.tone} />
    </svg>
  );
}
