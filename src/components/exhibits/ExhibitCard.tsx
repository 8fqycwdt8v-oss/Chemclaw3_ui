/**
 * An artefact, announced in the answer that produced it.
 *
 * The agent's report draft or table is *part of the answer* (the service's
 * `D-2026-10-02-an-artefact-is-part-of-the-answer-not-an-effect`), so it has a place in the answer
 * — after the result blocks, at the depth of the sentence that introduces it — even though its body
 * lives in the pane beside the chat. The card is that place: the kind, the title, which revision
 * this turn wrote, whether a person has edited it since, and **Open**.
 *
 * ## It reads the list, not only the frame
 *
 * The frame says what *this turn* did ("created r1"). The list says what the artefact is *now* — a
 * colleague may have revised it to r3 since — and a card that showed only the frame would offer
 * "rev 1" for a document whose head is somebody's correction. So both are shown: the revision this
 * answer wrote, and the head with its author when that differs. A card rebuilt from a reloaded
 * transcript has no title on the frame (`transcript.ts` says why) and takes it from the list too.
 *
 * Eager rather than lazy: it is a line of chrome in a transcript, and it must render the moment
 * the frame does — the pane is what is lazy.
 */

import { useAuth } from '../../auth/AuthContext.tsx';
import { useApiQuery } from '../../api/queryClient.ts';
import { exhibitsQuery } from '../../api/queries.ts';
import { useChatStore } from '../../state/chatStore.ts';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import type { TraceEntry } from '../../state/types.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KindIcon, editedBy, kindLabel } from './kind.tsx';

type Announced = NonNullable<TraceEntry['exhibit']>;

export function ExhibitCard({
  sessionId,
  exhibit,
}: {
  sessionId: string;
  exhibit: Announced;
}): React.JSX.Element {
  const { auth, ready } = useAuth();
  const viewer = useChatStore((s) => s.viewer);
  const { data } = useApiQuery({ ...exhibitsQuery(sessionId, auth), enabled: ready });
  const header = data?.exhibits.find((x) => x.exhibit_id === exhibit.exhibitId) ?? null;

  const kind = header?.kind || exhibit.kind;
  const title = header?.title || exhibit.title || 'Untitled artefact';
  const head = header?.head_revision ?? exhibit.revision;
  const edited = header ? editedBy(header.head_author_kind, header.head_author, viewer) : null;

  return (
    <div
      data-exhibit-card={exhibit.exhibitId}
      className="my-2 flex max-w-prose items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised px-3 py-2"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
        <KindIcon kind={kind} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={title}>
          {title}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-muted">
          <span>Artefact · {kindLabel(kind)}</span>
          <span aria-hidden>·</span>
          <span>
            {exhibit.op === 'created' ? 'created' : 'revised'} rev {exhibit.revision}
          </span>
          {head > exhibit.revision && (
            <>
              <span aria-hidden>·</span>
              <span>now rev {head}</span>
            </>
          )}
          {edited && <Badge tone="brand">{edited}</Badge>}
        </p>
      </div>
      {/* Only where the pane exists to open into. A deployment with artefacts turned off (or one
          not yet answered) has no pane, and an Open that does nothing is worse than none —
          `PinResult` holds the same rule. The card itself stays: the answer did write it. */}
      {data?.enabled === true && (
        <Button
          variant="outline"
          size="xs"
          aria-label={`Open artefact ${title}`}
          onClick={() => useExhibitPane.getState().show(sessionId, exhibit.exhibitId)}
        >
          Open
        </Button>
      )}
    </div>
  );
}
