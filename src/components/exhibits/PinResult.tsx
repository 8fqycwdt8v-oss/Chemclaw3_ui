/**
 * "Pin as artefact": keep one tool result beside the conversation, as a `result` artefact.
 *
 * The one artefact the agent cannot make. A pinned result is the chemist's choice of which output
 * matters — the hazard table they will cite, the Pareto front they will argue from — and the
 * service accepts it only for a ref its own tool-result store holds for this session, so pinning
 * cannot smuggle in a result the conversation never produced. The title is the tool's name, as the
 * contract says; nothing is paraphrased into it.
 *
 * Offered only where it can succeed: a stored ref (an inline-only result has nothing the service
 * could point at) and a deployment that has artefacts at all. A pin opens the pane on the new
 * artefact, because the reader just asked for it to be kept *there*.
 */

import { useState } from 'react';
import { Pin } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext.tsx';
import { api } from '../../api/client.ts';
import { keys, queryClient, useApiQuery } from '../../api/queryClient.ts';
import { exhibitsQuery } from '../../api/queries.ts';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import { Button } from '@/components/ui/button';

export function PinResult({
  sessionId,
  resultRef,
  tool,
}: {
  sessionId: string;
  resultRef: string;
  tool: string;
}): React.JSX.Element | null {
  const { auth, ready } = useAuth();
  const { data } = useApiQuery({ ...exhibitsQuery(sessionId, auth), enabled: ready });
  const [state, setState] = useState<'idle' | 'pinning' | 'pinned' | { failed: string }>('idle');

  if (!resultRef || data?.enabled !== true) return null;

  const pin = async (): Promise<void> => {
    setState('pinning');
    try {
      const made = await api.createExhibit(
        sessionId,
        { kind: 'result', title: tool, spec: { kind: 'result', result_ref: resultRef, tool } },
        auth,
      );
      setState('pinned');
      void queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
      useExhibitPane.getState().show(sessionId, made.exhibit_id);
    } catch (err) {
      setState({ failed: err instanceof Error ? err.message : 'The result could not be pinned.' });
    }
  };

  return (
    <>
      <Button
        variant="link"
        size="xs"
        className="-ml-2 px-2 no-underline hover:underline"
        // Once per block: a second click would be a second artefact holding the same result.
        disabled={state === 'pinning' || state === 'pinned'}
        onClick={() => void pin()}
      >
        <Pin aria-hidden className="size-3.5" />
        {state === 'pinned'
          ? 'Pinned as artefact'
          : state === 'pinning'
            ? 'Pinning…'
            : 'Pin as artefact'}
      </Button>
      {typeof state === 'object' && (
        <span role="alert" className="text-2xs text-danger-ink">
          {state.failed}
        </span>
      )}
    </>
  );
}
