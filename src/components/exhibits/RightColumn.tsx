/**
 * What sits to the right of the transcript: the entity rail, or the artefact pane that contains it.
 *
 * The decision is made here, eagerly, from one cheap read (`useSessionExhibits`), so that the pane
 * itself — the views, the editors, the export menu — can stay in a chunk of its own that a
 * conversation without artefacts never downloads. `check:bundle` budgets the first load, and the
 * pane is not part of it.
 *
 * **The rail is the default and stays exactly what it was.** The pane replaces it only when all of
 * these hold: the deployment has artefacts (`enabled`, from the list itself — off means the tabs
 * never appear), this conversation has at least one, the screen is wide enough for a column, and
 * the reader has the pane open. Closing the pane puts the rail back; the top bar's toggle brings the
 * pane back. Below `lg` the column does not exist at all and the pane is a sheet, opened from the
 * top bar — the same arrangement the rail has had since it stopped being a phone-sized absence.
 *
 * The Suspense fallback is the rail itself rather than a spinner: while the chunk arrives the reader
 * sees the column they had a moment ago, not an empty one.
 */

import { lazy, Suspense } from 'react';
import { Shapes } from 'lucide-react';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import { EntityRail } from '../EntityRail.tsx';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Loading } from '@/components/chem/Feedback';
import { useSessionExhibits, useWideScreen } from './useExhibits.ts';

const loadPane = () => import('./ExhibitPane.tsx');
const PaneColumn = lazy(() => loadPane().then((m) => ({ default: m.ExhibitPaneColumn })));
const PaneBody = lazy(() => loadPane().then((m) => ({ default: m.PaneBody })));

export function RightColumn({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const { sessionId, enabled, exhibits } = useSessionExhibits(conversationId);
  const open = useExhibitPane((s) => s.open);
  const wide = useWideScreen();

  if (!wide || !enabled || !sessionId || exhibits.length === 0 || !open) {
    return <EntityRail conversationId={conversationId} />;
  }
  return (
    <Suspense fallback={<EntityRail conversationId={conversationId} />}>
      <PaneColumn conversationId={conversationId} sessionId={sessionId} exhibits={exhibits} />
    </Suspense>
  );
}

/**
 * The top bar's way to the pane: a toggle beside the transcript at `lg`, a sheet below it.
 *
 * Absent whenever the pane could not hold anything — artefacts off, or none yet — so nobody is
 * offered a control that opens an empty drawer, which is `EntityRailTrigger`'s rule.
 */
export function ExhibitPaneTrigger({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element | null {
  const { sessionId, enabled, exhibits } = useSessionExhibits(conversationId);
  const open = useExhibitPane((s) => s.open);
  const sheetOpen = useExhibitPane((s) => s.sheetOpen);
  const wide = useWideScreen();

  if (!enabled || !sessionId || exhibits.length === 0) return null;
  const label = `Artefacts (${exhibits.length})`;

  if (wide) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={open}
        aria-label={
          open ? `Hide artefacts (${exhibits.length})` : `Show artefacts (${exhibits.length})`
        }
        onClick={() =>
          open
            ? useExhibitPane.getState().close()
            : useExhibitPane.getState().reveal(sessionId, exhibits[0]!.exhibit_id)
        }
      >
        <Shapes aria-hidden />
        <span className="text-xs">{exhibits.length}</span>
      </Button>
    );
  }

  return (
    <Sheet
      open={sheetOpen}
      onOpenChange={(next) => {
        if (next) useExhibitPane.getState().reveal(sessionId, exhibits[0]!.exhibit_id);
        else useExhibitPane.getState().close();
      }}
    >
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <Shapes />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" title="Artefacts" className="w-[min(36rem,95vw)] p-0">
        {/* The sheet's content mounts only while it is open, so the pane's chunk is fetched the
            first time somebody opens it and never for a reader who does not. */}
        <div className="flex min-h-0 flex-1 flex-col pt-10">
          <Suspense fallback={<Loading className="p-3">Opening the artefacts…</Loading>}>
            <PaneBody
              conversationId={conversationId}
              sessionId={sessionId}
              exhibits={exhibits}
              // Handing an artefact to the composer closes the sheet: the message being written is
              // behind it, which is `NoteSheet`'s rule for a structure.
              onAsked={() => useExhibitPane.setState({ sheetOpen: false })}
            />
          </Suspense>
        </div>
      </SheetContent>
    </Sheet>
  );
}
