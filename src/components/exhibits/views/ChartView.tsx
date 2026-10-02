/**
 * A chart artefact: line, scatter or bar, with the agent's axis labels and the numbers beside it.
 *
 * **The caption is the point.** A chart's points are literal values the agent transcribed — phase
 * 0 measured the binding design out, so nothing links a point to the tool result it came from — and
 * a drawn line reads as a measurement whether or not it is one. So an agent-authored revision says
 * so under the figure, in the contract's own words, every time. A chemist's revision does not: a
 * person who typed the numbers knows where they came from, and the caption would be wrong about
 * them.
 *
 * The table under the chart is the accessible reading of the same fact (`Charts.tsx`, rule 1), not
 * a fallback for it: a screen reader gets every value with its series and its axis label, and so
 * does anyone checking a point against its source.
 */

import { forwardRef } from 'react';
import type { ChartSpec, ExhibitView } from '../../../../shared/exhibits.ts';
import { formatScientificNumber } from '../../../lib/format.ts';
import { SeriesChart, SeriesSwatch } from '@/components/chem/SeriesChart';

export const TRANSCRIBED_CAPTION = 'Values transcribed by the agent — not linked to tool results.';

const cell = (value: number | string | undefined): string =>
  value === undefined ? '—' : typeof value === 'number' ? formatScientificNumber(value) : value;

export const ChartView = forwardRef<HTMLDivElement, { view: ExhibitView; spec: ChartSpec }>(
  function ChartView({ view, spec }, ref) {
    const rows = spec.series.flatMap((series) =>
      series.y.map((y, i) => ({ series: series.name, x: series.x[i], y })),
    );
    return (
      <figure className="flex flex-col gap-2">
        {/* The ref is on the drawing's wrapper so the export menu can serialise this exact SVG. */}
        <div ref={ref} className="rounded-lg border border-border-subtle bg-surface-raised p-2">
          <SeriesChart
            chart={spec.chart}
            xLabel={spec.x_label}
            yLabel={spec.y_label}
            series={spec.series}
          />
        </div>
        {spec.series.length > 1 && (
          <ul
            aria-label="Series"
            className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-muted"
          >
            {spec.series.map((series, index) => (
              <li key={`${series.name}-${index}`} className="flex items-center gap-1">
                <SeriesSwatch index={index} />
                {series.name}
              </li>
            ))}
          </ul>
        )}
        {view.author_kind === 'agent' && (
          <figcaption className="text-2xs text-ink-muted italic">{TRANSCRIBED_CAPTION}</figcaption>
        )}
        <div
          tabIndex={0}
          role="region"
          aria-label={`${view.title} — the values plotted`}
          className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
        >
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-sunken text-2xs text-ink-subtle">
              <tr>
                <th scope="col" className="px-2.5 py-1.5 font-medium">
                  Series
                </th>
                <th scope="col" className="px-2.5 py-1.5 font-medium">
                  {spec.x_label}
                </th>
                <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                  {spec.y_label}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="px-2.5 py-1">{row.series}</td>
                  <td className="px-2.5 py-1 font-mono tabular-nums">{cell(row.x)}</td>
                  <td className="px-2.5 py-1 text-right font-mono tabular-nums">{cell(row.y)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    );
  },
);
