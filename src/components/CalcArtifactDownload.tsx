/**
 * Download one calculation by-product — the C4 story's control.
 *
 * Wherever this app shows a calc artifact ref (`<calc_key>#<name>`): a `list_artifacts` /
 * `fetch_artifact` result block, and a geometry artefact that cites the calculation it came from.
 * One component, because "take the optimised geometry or the Hessian into another package" is one
 * act whichever surface the chemist found the ref on, and its two failure sentences (evicted, too
 * large) belong to the route rather than to the surface.
 *
 * Imported only by lazily-loaded surfaces (the result renderers and the artefact pane), so it costs
 * the first load nothing.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { api } from '../api/client.ts';
import { saveBlob } from '../lib/download.ts';
import { Button } from '@/components/ui/button';

export function CalcArtifactDownload({
  reference,
  label = 'Download',
}: {
  /** `<calc_key>#<name>`, as `list_artifacts` and a geometry's `source` spell it. */
  reference: string;
  label?: string;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [state, setState] = useState<{ busy: boolean; problem: string | null }>({
    busy: false,
    problem: null,
  });
  const name = reference.slice(reference.lastIndexOf('#') + 1);

  const download = async (): Promise<void> => {
    setState({ busy: true, problem: null });
    try {
      const file = await api.getCalcArtifact(reference, auth);
      saveBlob(file.blob, file.filename);
      setState({ busy: false, problem: null });
    } catch (err) {
      setState({
        busy: false,
        problem: err instanceof Error ? err.message : 'The download failed.',
      });
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="xs"
        disabled={state.busy}
        aria-label={`${label} ${name}`}
        onClick={() => void download()}
      >
        <Download aria-hidden className="size-3.5" />
        {state.busy ? 'Downloading…' : label}
      </Button>
      {state.problem && (
        <span role="alert" className="text-2xs text-danger-ink">
          {state.problem}
        </span>
      )}
    </span>
  );
}
