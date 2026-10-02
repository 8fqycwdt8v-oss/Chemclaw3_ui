/**
 * The `@artefact` chips above the composer: artefacts the next message hands back to the agent.
 *
 * "Ask about this" in the pane puts one here. It travels as a *structured field* —
 * `exhibit_refs: [{exhibit_id, revision}]` on `POST /sessions/{id}/messages` — and not as text the
 * agent would have to recognise: the service resolves each ref within the session and puts a
 * framed copy of that revision in front of the model as data, which an id typed into the prose
 * could never be. The revision is the one the chemist was looking at, so "is this right?" is asked
 * about the document they saw, not about whatever the head has become by the time the turn runs.
 *
 * The same strip treatment as the upload notice beside it: above the box, quiet, removable, and
 * gone once the message is sent. At most `MAX_EXHIBIT_REFS` (the service's cap), and the strip says
 * so rather than letting a sixth chip turn into a 422 after the message was typed.
 */

import { AtSign, X } from 'lucide-react';
import { MAX_EXHIBIT_REFS } from '../../../shared/exhibits.ts';
import { refsOf, useExhibitPane } from '../../state/exhibitPane.ts';
import { useSessionExhibits } from './useExhibits.ts';

export function ExhibitRefChips({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const refs = useExhibitPane((s) => refsOf(s, conversationId));
  const { exhibits } = useSessionExhibits(conversationId);
  if (refs.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <ul aria-label="Artefacts attached to this message" className="flex flex-wrap gap-1.5">
        {refs.map((ref) => {
          const title =
            exhibits.find((x) => x.exhibit_id === ref.exhibit_id)?.title || ref.exhibit_id;
          return (
            <li
              key={ref.exhibit_id}
              className="flex items-center gap-1 rounded-md border border-brand/40 bg-brand-soft py-0.5 pr-0.5 pl-1.5 text-xs text-brand-ink"
            >
              <AtSign aria-hidden className="size-3" />
              <span className="max-w-48 truncate">{title}</span>
              <span className="font-mono text-2xs">r{ref.revision}</span>
              <button
                type="button"
                aria-label={`Remove ${title} from this message`}
                onClick={() => useExhibitPane.getState().removeRef(conversationId, ref.exhibit_id)}
                className="tap-target rounded-sm p-0.5 hover:bg-brand/15 focus-ring"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          );
        })}
      </ul>
      {refs.length >= MAX_EXHIBIT_REFS && (
        <span role="status" className="text-2xs text-ink-muted">
          {MAX_EXHIBIT_REFS} artefacts is the most one message can carry.
        </span>
      )}
    </div>
  );
}
