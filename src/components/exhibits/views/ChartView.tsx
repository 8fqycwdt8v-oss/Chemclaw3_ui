/**
 * A chart artefact: line, scatter or bar, with the agent's axis labels and the numbers beside it.
 *
 * **The caption is the point.** A drawn line reads as a measurement whether or not it is one, and
 * a series' points are either literal values the agent transcribed or — since wave 3 — bound to a
 * tool result, verbatim. So an agent-authored revision says, under the figure, which it is: every
 * series transcribed is the contract's sentence unchanged; some is the same sentence naming those
 * series; none is no caption, because every value on it is linked and each series' marker says to
 * what. A chemist's revision carries no caption: a person who typed the numbers knows where they
 * came from, and the caption would be wrong about them.
 *
 * A bound series carries a provenance marker in the series list (one per bound axis), and its rows
 * in the values table are marked as linked. Detach, from the marker, is the one write this view
 * makes — a chart has no point editor.
 *
 * The table under the chart is the accessible reading of the same fact (`Charts.tsx`, rule 1), not
 * a fallback for it: a screen reader gets every value with its series and its axis label, and so
 * does anyone checking a point against its source.
 */

import { forwardRef } from 'react';
import { Link2 } from 'lucide-react';
import type { ChartSpec, ExhibitView } from '../../../../shared/exhibits.ts';
import { formatScientificNumber } from '../../../lib/format.ts';
import { SeriesChart, SeriesSwatch } from '@/components/chem/SeriesChart';
import { ProvenanceMarker, SOURCE_GONE } from '../Provenance.tsx';
import { ReviseNotices } from '../ReviseNotices.tsx';
import { useRevise } from '../useRevise.ts';
import {
  canDetach,
  detach,
  pathOf,
  provenanceAt,
  rawOf,
  transcribedSeries,
  type BoundTarget,
  type Provenance,
} from '../bindings.ts';

export const TRANSCRIBED_CAPTION = 'Values transcribed by the agent — not linked to tool results.';

/**
 * The caption for an agent-authored chart, or `null` when nothing on it is transcribed.
 *
 * Partial names the series, quoted, because "some values" would leave the reader to guess which
 * line to distrust.
 */
export function transcribedCaption(transcribed: readonly string[], total: number): string | null {
  if (transcribed.length === 0) return null;
  if (transcribed.length === total) return TRANSCRIBED_CAPTION;
  const names = transcribed.map((name) => `“${name}”`).join(', ');
  return `Values of ${names} transcribed by the agent — not linked to tool results. The other series are linked.`;
}

const cell = (value: number | string | undefined): string =>
  value === undefined ? '—' : typeof value === 'number' ? formatScientificNumber(value) : value;

export const ChartView = forwardRef<
  HTMLDivElement,
  { sessionId: string; view: ExhibitView; spec: ChartSpec; isHead: boolean }
>(function ChartView({ sessionId, view, spec, isHead }, ref) {
  const revise = useRevise(sessionId, view);
  const raw = rawOf(view, 'chart');
  const bound = spec.series.map((_, index) => ({
    x: provenanceAt(view, { at: 'series', series: index, axis: 'x' }),
    y: provenanceAt(view, { at: 'series', series: index, axis: 'y' }),
  }));
  const linked = bound.some((b) => b.x || b.y);
  const rows = spec.series.flatMap((series, index) =>
    series.y.map((y, i) => ({
      series: series.name,
      x: series.x[i],
      y,
      linked: Boolean(bound[index]?.y),
    })),
  );
  const caption =
    view.author_kind === 'agent'
      ? transcribedCaption(transcribedSeries(view.raw_spec, spec), spec.series.length)
      : null;

  const detachFor = (target: BoundTarget, provenance: Provenance): (() => void) | undefined => {
    if (!isHead || !raw || !canDetach(target, provenance)) return undefined;
    const base = view.revision;
    return () => {
      const next = detach(raw, spec, target);
      if (next) void revise.save(next, `Detached ${pathOf(target)} from its tool result`, base);
    };
  };
  const marker = (index: number, axis: 'x' | 'y'): React.JSX.Element | null => {
    const provenance = bound[index]?.[axis];
    if (!provenance) return null;
    const target: BoundTarget = { at: 'series', series: index, axis };
    return (
      <span className="inline-flex items-center gap-0.5">
        <span className="font-mono">{axis}</span>
        <ProvenanceMarker
          provenance={provenance}
          onDetach={detachFor(target, provenance)}
          detachDisabled={revise.state.status === 'saving'}
        />
        {provenance.ok === false && <span className="text-warn-ink">{SOURCE_GONE}</span>}
      </span>
    );
  };
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
      {(spec.series.length > 1 || linked) && (
        <ul aria-label="Series" className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-muted">
          {spec.series.map((series, index) => (
            <li key={`${series.name}-${index}`} className="flex items-center gap-1">
              <SeriesSwatch index={index} />
              {series.name}
              {marker(index, 'x')}
              {marker(index, 'y')}
            </li>
          ))}
        </ul>
      )}
      {caption && <figcaption className="text-2xs text-ink-muted italic">{caption}</figcaption>}
      <ReviseNotices sessionId={sessionId} exhibitId={view.exhibit_id} revise={revise} />
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
                <td className="px-2.5 py-1">
                  {row.series}
                  {row.linked && (
                    <>
                      <Link2 aria-hidden className="ml-1 inline size-3 text-brand" />
                      <span className="sr-only"> (linked to a tool result)</span>
                    </>
                  )}
                </td>
                <td className="px-2.5 py-1 font-mono tabular-nums">{cell(row.x)}</td>
                <td className="px-2.5 py-1 text-right font-mono tabular-nums">{cell(row.y)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
});
