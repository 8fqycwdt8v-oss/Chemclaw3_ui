/**
 * A geometry artefact (wave 2): one 3D structure, inline, read from the calculation that made it, or
 * read from the structure store (`structure_id`, hardening item 1 — which the service resolves to
 * `xyz` before the view ever sees it, so it is drawn exactly as an inline block is).
 *
 * Two sources, one drawing. An inline `xyz` block is drawn as it is; a `source` names a stored calc
 * by-product (`<calc_key>#<name>`) and its bytes are fetched through `GET /calc-artifacts/content`
 * — the same route the XYZ download of a cited geometry resolves on the service, so what is drawn
 * and what is downloaded are the same file. Either way the text goes through one parser
 * (`parseXyz` in `src/chem/geometry.ts`), so a cited file nothing validated on its way out of the calc
 * store meets the same refusals an inline block met on its way in.
 *
 * The viewer itself is a separate lazy chunk: only a geometry artefact needs it.
 *
 * **What a failure says.** A source that is gone is the calc store doing what it was designed to do
 * (by-products are eviction-managed), and the sentence says so and points at the calculation; a
 * stored structure that has vanished resolves to no `xyz` at all, and the sentence names the id
 * (the pane's strip above says the same from the `bindings[]` row); a block that does not parse says
 * which line. None falls back to drawing *something*: a partial structure shown as the artefact
 * would be a molecule nobody computed.
 */

import { lazy, Suspense, useMemo } from 'react';
import { useAuth } from '../../../auth/AuthContext.tsx';
import { useApiQuery } from '../../../api/queryClient.ts';
import { calcArtifactTextQuery } from '../../../api/queries.ts';
import { parseXyz, XyzError, type Geometry } from '../../../chem/geometry.ts';
import {
  calcArtifactRef,
  type ExhibitView,
  type GeometrySpec,
} from '../../../../shared/exhibits.ts';
import { EmptyState, Loading } from '@/components/chem/Feedback';
import { CalcArtifactDownload } from '../../CalcArtifactDownload.tsx';

const GeometryViewer = lazy(() =>
  import('@/components/chem/GeometryViewer').then((m) => ({ default: m.GeometryViewer })),
);

/** The parsed structure, or the sentence that says why there is none. */
function read(text: string): { geometry: Geometry } | { problem: string } {
  try {
    return { geometry: parseXyz(text) };
  } catch (err) {
    return {
      problem:
        err instanceof XyzError
          ? err.message
          : 'The coordinates could not be read as an XYZ block.',
    };
  }
}

function Drawing({
  text,
  spec,
  view,
}: {
  text: string;
  spec: GeometrySpec;
  view: ExhibitView;
}): React.JSX.Element {
  const parsed = useMemo(() => read(text), [text]);
  if ('problem' in parsed) {
    return (
      <EmptyState title="These coordinates cannot be drawn" className="py-6">
        {parsed.problem}
      </EmptyState>
    );
  }
  return (
    <Suspense fallback={<Loading>Preparing the 3D view…</Loading>}>
      <GeometryViewer
        geometry={parsed.geometry}
        label={spec.label || view.title}
        highlight={spec.highlight_atoms}
        energyHartree={spec.energy_hartree}
      />
    </Suspense>
  );
}

/** A cited geometry: the calc store's bytes, fetched once and cached as the immutable read they are. */
function FromSource({
  reference,
  spec,
  view,
}: {
  reference: string;
  spec: GeometrySpec;
  view: ExhibitView;
}): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error } = useApiQuery({
    ...calcArtifactTextQuery(reference, auth),
    enabled: ready,
  });
  if (error) {
    return (
      <EmptyState title="The cited calculation file could not be read" className="py-6">
        {error.message}
      </EmptyState>
    );
  }
  if (data === undefined) return <Loading>Reading the calculation file…</Loading>;
  return <Drawing text={data} spec={spec} view={view} />;
}

export function GeometryView({
  view,
  spec,
}: {
  view: ExhibitView;
  spec: GeometrySpec;
}): React.JSX.Element {
  const reference = spec.source ? calcArtifactRef(spec.source) : null;
  const structure = spec.structure_id;
  if (structure && spec.xyz === undefined) {
    return (
      <EmptyState title="The stored structure is no longer available" className="py-6">
        This geometry cites the structure <span className="font-mono break-all">{structure}</span>,
        which the structure store no longer holds, so there is nothing to draw.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {structure && (
        <p className="text-2xs text-ink-muted">
          From the stored structure <span className="font-mono break-all">{structure}</span>
        </p>
      )}
      {reference ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
            <span>
              From the calculation file <span className="font-mono break-all">{reference}</span>
            </span>
            <CalcArtifactDownload reference={reference} />
          </p>
          <FromSource reference={reference} spec={spec} view={view} />
        </>
      ) : (
        <Drawing text={spec.xyz ?? ''} spec={spec} view={view} />
      )}
    </div>
  );
}
