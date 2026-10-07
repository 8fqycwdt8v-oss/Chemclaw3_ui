/**
 * The right column when the conversation has artefacts: tabs **Artefacts | Index** (the entity
 * rail's `RailBody`, unchanged). Lazily loaded by `RightColumn.tsx`. An `<aside>` beside `<main>`,
 * not inside it. Deployments with artefacts off render the plain rail.
 *
 * One artefact's header: title and kind, a revision picker (`r3 · agent · 14:02`), Compare (the
 * service's diff in `RevisionDiff`), Export (service formats plus SDF/SVG made here), Print, "Ask
 * about this" (a composer chip), and promotions (save as note, make a protocol) sent as requests to
 * the agent.
 */

import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Tabs } from 'radix-ui';
import {
  AtSign,
  Download,
  GitCompare,
  MoreHorizontal,
  Printer,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useAuth } from '../../auth/AuthContext.tsx';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/queryClient.ts';
import { exhibitDiffQuery, exhibitQuery, exhibitRevisionsQuery } from '../../api/queries.ts';
import { useChatStore } from '../../state/chatStore.ts';
import { prefill } from '../../state/composerEvents.ts';
import { focusOf, revisionShown, useExhibitPane } from '../../state/exhibitPane.ts';
import { createDraftOf, reviseDraftOf, useExhibitDrafts } from '../../state/exhibitDrafts.ts';
import { rdkitAvailable } from '../../chem/rdkit.ts';
import { saveBlob } from '../../lib/download.ts';
import {
  EXPORT_FORMATS,
  type ExhibitHeader,
  type ExhibitRevision,
  type ExhibitView,
  type ExportFormat,
} from '../../../shared/exhibits.ts';
import { RevisionDiff } from '../RevisionDiff.tsx';
import { RailBody, useSubjectCount } from '../EntityRail.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, Loading } from '@/components/chem/Feedback';
import { cn } from '@/lib/utils';
import { KindIcon, editedBy, kindLabel } from './kind.tsx';
import { Resizer } from './Resizer.tsx';
import { fileStem, sdfOf, svgFileOf } from './exports.ts';
import { ChartView } from './views/ChartView.tsx';
import { DocumentView } from './views/DocumentView.tsx';
import { DraftView } from './views/DraftView.tsx';
import { GeometryView } from './views/GeometryView.tsx';
import { LinkView } from './views/LinkView.tsx';
import { ResultView } from './views/ResultView.tsx';
import { StructuresView } from './views/StructuresView.tsx';
import { TableView } from './views/TableView.tsx';
import { GoneSourcesStrip } from './Provenance.tsx';
import { goneBindings } from './bindings.ts';

/** The HTML view in its own chunk; few conversations hold an `html` artefact. */
const HtmlView = lazy(() =>
  import('./views/HtmlView.tsx').then((module) => ({ default: module.HtmlView })),
);

/** What every half of the pane is handed. The list is the shell's — one read, shared. */
export interface PaneProps {
  conversationId: string;
  sessionId: string;
  exhibits: ExhibitHeader[];
  /**
   * Artefacts are off but this conversation has some: view, compare, export and print only — no
   * edit, Detach, "Ask about this" or promotion.
   */
  readOnly?: boolean;
}

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  md: 'Markdown (.md)',
  csv: 'CSV (.csv)',
  smi: 'SMILES (.smi)',
  xyz: 'XYZ coordinates (.xyz)',
  // Saved as `.html.txt`: opened as a page outside the sandbox, its scripts would run.
  html: 'HTML source (.html.txt) — runs its scripts if opened as a web page',
};

/** The saved filename: the service's own, except `html`, saved as `<stem>.html.txt`. */
export function savedName(format: ExportFormat, served: string, stem: string): string {
  if (format !== 'html') return served;
  const base = served.replace(/\.html?(\.txt)?$/i, '') || stem;
  return `${base}.html.txt`;
}

/** `14:02` in local time, 24-hour, or nothing for an unreadable timestamp. */
function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * One revision as the picker names it: `r3 · agent · 14:02` — the author ("you" for the reader)
 * answers whose numbers these are.
 */
export function revisionLabel(revision: ExhibitRevision, viewer: string | null): string {
  const who =
    revision.author_kind === 'agent'
      ? 'agent'
      : viewer && revision.author === viewer
        ? 'you'
        : revision.author || 'a person';
  return [`r${revision.revision}`, who, clock(revision.created_at)].filter(Boolean).join(' · ');
}

/**
 * The `unverified_figures` warning, above the view: figures no tool returned, "unchecked, not
 * necessarily wrong" (a derived figure is flagged too).
 */
export function UnverifiedStrip({
  figures,
}: {
  figures: readonly string[];
}): React.JSX.Element | null {
  if (figures.length === 0) return null;
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Not found in any tool result this session (unchecked — not necessarily wrong):{' '}
        <span className="font-mono">{figures.join(', ')}</span>
      </span>
    </p>
  );
}

/** The body of one revision, by its spec's kind. */
function Body({
  sessionId,
  view,
  editable,
  chartRef,
}: {
  sessionId: string;
  view: ExhibitView;
  /** The head of a deployment that writes artefacts: the one place editing is offered. Handed to
   *  the views as their `isHead`, which is the only thing they gate an edit on. */
  editable: boolean;
  chartRef: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  const spec = view.spec;
  if (!spec) {
    // A spec this build cannot read: said, not half-drawn. The history, the comparison and the
    // service's exports all still work, because none of them needs the shape.
    return (
      <EmptyState title="This build cannot show this artefact's content" className="py-6">
        Its revision history, its comparisons and its downloads still work. Reloading after the app
        updates may be enough.
      </EmptyState>
    );
  }
  switch (spec.kind) {
    case 'document':
      return <DocumentView sessionId={sessionId} view={view} spec={spec} isHead={editable} />;
    case 'table':
      return <TableView sessionId={sessionId} view={view} spec={spec} isHead={editable} />;
    case 'structures':
      return <StructuresView sessionId={sessionId} view={view} spec={spec} isHead={editable} />;
    case 'chart':
      return (
        <ChartView ref={chartRef} sessionId={sessionId} view={view} spec={spec} isHead={editable} />
      );
    case 'result':
      return <ResultView sessionId={sessionId} spec={spec} />;
    case 'link':
      return <LinkView sessionId={sessionId} spec={spec} />;
    case 'geometry':
      return <GeometryView view={view} spec={spec} />;
    case 'html':
      return (
        <Suspense fallback={<Loading>Preparing the sandboxed preview…</Loading>}>
          <HtmlView view={view} spec={spec} />
        </Suspense>
      );
  }
}

/** The export menu: the service's formats for this kind, plus what this browser makes itself. */
function ExportMenu({
  sessionId,
  view,
  chartRef,
  onProblem,
}: {
  sessionId: string;
  view: ExhibitView;
  chartRef: React.RefObject<HTMLDivElement | null>;
  onProblem: (message: string | null) => void;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  const kind = view.spec?.kind ?? view.kind;
  const server = EXPORT_FORMATS[kind as keyof typeof EXPORT_FORMATS] ?? [];
  const stem = fileStem(view.title, view.exhibit_id);
  const sdf = view.spec?.kind === 'structures';
  const svg = view.spec?.kind === 'chart';
  if (server.length === 0 && !sdf && !svg) return null;

  const fromServer = async (format: ExportFormat): Promise<void> => {
    onProblem(null);
    try {
      const file = await api.exportExhibit(sessionId, view.exhibit_id, format, auth, view.revision);
      saveBlob(file.blob, savedName(format, file.filename, stem));
    } catch (err) {
      onProblem(err instanceof Error ? err.message : 'The download failed.');
    }
  };

  const asSdf = async (): Promise<void> => {
    onProblem(null);
    if (view.spec?.kind !== 'structures') return;
    if (!(await rdkitAvailable())) {
      onProblem(
        'The structure toolkit did not load in this browser, so an SDF cannot be made here. The SMILES download still works.',
      );
      return;
    }
    const made = await sdfOf(view.spec.items);
    if ('unreadable' in made) {
      onProblem(
        `No SDF was written: RDKit could not read ${made.unreadable.length} of the structures (${made.unreadable.slice(0, 3).join(', ')}${made.unreadable.length > 3 ? ', …' : ''}). The SMILES download has all of them.`,
      );
      return;
    }
    saveBlob(new Blob([made.sdf], { type: 'chemical/x-mdl-sdfile' }), `${stem}.sdf`);
  };

  const asSvg = (): void => {
    onProblem(null);
    const drawing = chartRef.current?.querySelector('svg');
    if (!drawing) {
      onProblem('The chart is not on screen to export.');
      return;
    }
    saveBlob(new Blob([svgFileOf(drawing)], { type: 'image/svg+xml' }), `${stem}.svg`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs">
          <Download aria-hidden className="size-3.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {server.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void fromServer(format)}>
            {FORMAT_LABEL[format]}
          </DropdownMenuItem>
        ))}
        {sdf && (
          <DropdownMenuItem onSelect={() => void asSdf()}>SDF (.sdf), made here</DropdownMenuItem>
        )}
        {svg && <DropdownMenuItem onSelect={asSvg}>SVG (.svg), made here</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compare: the revision on screen against an earlier one, through the service's diff. */
function Compare({
  sessionId,
  view,
  revisions,
  viewer,
}: {
  sessionId: string;
  view: ExhibitView;
  revisions: ExhibitRevision[];
  viewer: string | null;
}): React.JSX.Element {
  const { auth } = useAuth();
  const earlier = revisions.filter((r) => r.revision < view.revision);
  // Compare against the parent revision by default.
  const [from, setFrom] = useState(
    view.parent_revision > 0 ? view.parent_revision : (earlier.at(-1)?.revision ?? 0),
  );
  const fieldId = useId();
  const {
    data: diff,
    error,
    isPending,
  } = useApiQuery({
    ...exhibitDiffQuery(sessionId, view.exhibit_id, from, view.revision, auth),
    enabled: from > 0 && from < view.revision,
  });

  if (earlier.length === 0) {
    return (
      <p className="text-xs text-ink-muted">
        Revision {view.revision} is the first, so there is nothing earlier to compare it with.
      </p>
    );
  }
  return (
    <section aria-label="Compare revisions" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={fieldId} className="text-ink-subtle">
          Compare revision {view.revision} with
        </label>
        <select
          id={fieldId}
          value={from}
          onChange={(e) => setFrom(Number(e.target.value))}
          className="rounded-md border border-border-subtle bg-surface-raised px-1.5 py-0.5 text-xs focus-ring"
        >
          {earlier.map((r) => (
            <option key={r.revision} value={r.revision}>
              {revisionLabel(r, viewer)}
            </option>
          ))}
        </select>
      </div>
      {isPending && !error && <Loading size="xs">Comparing…</Loading>}
      {error && <p className="text-xs text-danger-ink">{error.message}</p>}
      {diff && <RevisionDiff diff={diff} />}
    </section>
  );
}

/** One artefact: its header, its warnings, and its body at the revision picked. */
function ExhibitDetail({
  conversationId,
  sessionId,
  header,
  readOnly = false,
  onAsked,
}: {
  conversationId: string;
  sessionId: string;
  header: ExhibitHeader;
  readOnly?: boolean;
  /** The reader handed this artefact to the composer — the sheet closes so they can type. */
  onAsked?: () => void;
}): React.JSX.Element {
  const { auth, ready } = useAuth();
  const viewer = useChatStore((s) => s.viewer);
  // The revision picked on this artefact in this session, or the head (`revisionShown`).
  const revision = useExhibitPane((s) => revisionShown(s, sessionId, header.exhibit_id));
  const setRevision = (picked: number): void =>
    useExhibitPane.getState().setRevision(sessionId, header.exhibit_id, picked);
  // The agent rewriting this artefact right now (wave 2): its new text is drawn over the body, under
  // a banner, until the `exhibit` frame lands the revision — the header and the history stay.
  const revising = useExhibitDrafts((s) => reviseDraftOf(s, sessionId, header.exhibit_id));
  const [comparing, setComparing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const pickerId = useId();

  const { data: view, error } = useApiQuery({
    ...exhibitQuery(sessionId, header.exhibit_id, revision, auth),
    enabled: ready,
  });
  const { data: revisions = [] } = useApiQuery({
    ...exhibitRevisionsQuery(sessionId, header.exhibit_id, auth),
    enabled: ready,
  });

  if (error) {
    return (
      <EmptyState title="This artefact could not be read" className="py-6">
        {error.message}
      </EmptyState>
    );
  }
  if (!view) return <Loading>Reading the artefact…</Loading>;

  const isHead = view.revision === view.head_revision;
  const edited = editedBy(view.author_kind, view.author, viewer);
  const shownRef = { exhibit_id: view.exhibit_id, revision: view.revision };

  const ask = (): void => {
    useExhibitPane.getState().addRef(conversationId, shownRef);
    onAsked?.();
    document.getElementById('composer-input')?.focus();
  };
  const promote = (request: string): void => {
    useExhibitPane.getState().addRef(conversationId, shownRef);
    prefill(request);
    onAsked?.();
  };

  /**
   * Print this artefact only: `data-print="document"` (which the print stylesheet keys on) is set
   * for one `window.print()` and removed, so printing the conversation still works.
   */
  const print = (): void => {
    setPrinting(true);
    window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 0);
  };

  return (
    <article
      aria-labelledby={`${pickerId}-title`}
      data-print={printing ? 'document' : undefined}
      className="flex flex-col gap-3"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <KindIcon kind={view.kind} className="mt-1 size-4 shrink-0 text-ink-subtle" />
          <h2
            id={`${pickerId}-title`}
            className="min-w-0 flex-1 text-base font-semibold break-words"
          >
            {view.title || 'Untitled artefact'}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
          <Badge>{kindLabel(view.kind)}</Badge>
          {edited && <Badge tone="brand">{edited}</Badge>}
          {view.change_note && <span className="truncate">“{view.change_note}”</span>}
        </div>

        <div data-print="hide" className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={pickerId} className="sr-only">
            Revision
          </label>
          <select
            id={pickerId}
            value={view.revision}
            onChange={(e) => {
              const picked = Number(e.target.value);
              setRevision(picked === view.head_revision ? 0 : picked);
              setComparing(false);
            }}
            className="rounded-md border border-border-subtle bg-surface-raised px-1.5 py-0.5 text-xs focus-ring"
          >
            {(revisions.length > 0
              ? [...revisions].reverse()
              : [
                  {
                    revision: view.revision,
                    parent_revision: view.parent_revision,
                    author_kind: view.author_kind,
                    author: view.author,
                    change_note: view.change_note,
                    created_at: view.revision_created_at,
                    byte_size: 0,
                  },
                ]
            ).map((r) => (
              <option key={r.revision} value={r.revision}>
                {revisionLabel(r, viewer)}
                {r.revision === view.head_revision ? ' (latest)' : ''}
              </option>
            ))}
          </select>
          <Button
            variant={comparing ? 'secondary' : 'outline'}
            size="xs"
            aria-pressed={comparing}
            onClick={() => setComparing((c) => !c)}
          >
            <GitCompare aria-hidden className="size-3.5" />
            Compare
          </Button>
          <ExportMenu
            sessionId={sessionId}
            view={view}
            chartRef={chartRef}
            onProblem={setProblem}
          />
          <Button variant="outline" size="xs" onClick={print}>
            <Printer aria-hidden className="size-3.5" />
            Print
          </Button>
          {!readOnly && (
            <Button variant="outline" size="xs" onClick={ask}>
              <AtSign aria-hidden className="size-3.5" />
              Ask about this
            </Button>
          )}
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More for this artefact">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    promote(
                      `Save the attached artefact “${view.title}” (revision ${view.revision}) as a knowledge note, citing what it rests on.`,
                    )
                  }
                >
                  Save as note
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    promote(
                      `Draft an experiment protocol from the attached artefact “${view.title}” (revision ${view.revision}).`,
                    )
                  }
                >
                  Make a protocol
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {readOnly ? (
          <p role="status" className="text-2xs text-ink-muted">
            Artefacts are turned off in this deployment, so this one is shown read-only: it can be
            read, compared, exported and printed, but not edited or handed to the agent.
          </p>
        ) : (
          !isHead && (
            <p role="status" className="text-2xs text-ink-muted">
              An earlier revision — the latest is revision {view.head_revision}. Editing is offered
              on the latest only.
            </p>
          )
        )}
        {problem && (
          <p role="alert" className="text-xs text-danger-ink">
            {problem}
          </p>
        )}
      </header>

      <UnverifiedStrip figures={view.unverified_figures} />
      <GoneSourcesStrip gone={goneBindings(view)} />

      {comparing && (
        <div data-print="hide" className="rounded-lg border border-border-subtle p-2">
          <Compare sessionId={sessionId} view={view} revisions={revisions} viewer={viewer} />
        </div>
      )}

      {revising && isHead ? (
        <DraftView draft={revising} revising />
      ) : (
        <Body
          sessionId={sessionId}
          view={view}
          editable={isHead && !readOnly}
          chartRef={chartRef}
        />
      )}
    </article>
  );
}

/** The Artefacts tab: which artefact, then that artefact. */
function ArtefactsTab({
  conversationId,
  sessionId,
  exhibits,
  readOnly,
  onAsked,
}: PaneProps & { onAsked?: () => void }): React.JSX.Element {
  const focus = useExhibitPane((s) => focusOf(s, sessionId));
  // A new document being written (wave 2) is what the pane shows while it is written: it is the
  // artefact this turn is making, and it has no id to focus until the tool has run.
  const drafting = useExhibitDrafts((s) => createDraftOf(s, sessionId));
  const pickerId = useId();
  const chosen = focus ? exhibits.find((x) => x.exhibit_id === focus.exhibitId) : undefined;
  const fallback = exhibits[0];
  // With nothing chosen, show the fallback and pin it, so reordering cannot swap the document under
  // a draft. Not while a draft is in front.
  useEffect(() => {
    if (!drafting && !chosen && fallback) {
      useExhibitPane.getState().pin(sessionId, fallback.exhibit_id);
    }
  }, [drafting, chosen, fallback, sessionId]);
  if (drafting) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <DraftView draft={drafting} />
      </div>
    );
  }
  if (exhibits.length === 0) {
    return (
      <p className="p-3 text-sm text-ink-muted">
        No artefacts in this conversation yet. When the agent writes a report, a table or a figure,
        it appears here.
      </p>
    );
  }
  const focused = chosen ?? exhibits[0]!;

  return (
    <div className="flex flex-col gap-3 p-3">
      {exhibits.length > 1 && (
        <div className="flex items-center gap-2 text-xs" data-print="hide">
          <label htmlFor={pickerId} className="shrink-0 text-ink-subtle">
            Artefact
          </label>
          <select
            id={pickerId}
            value={focused.exhibit_id}
            onChange={(e) => useExhibitPane.getState().pin(sessionId, e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-raised px-1.5 py-0.5 text-xs focus-ring"
          >
            {exhibits.map((x) => (
              <option key={x.exhibit_id} value={x.exhibit_id}>
                {x.title || 'Untitled'} — {kindLabel(x.kind)}, r{x.head_revision}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* Keyed on the artefact, so a switch resets the compare toggle and any half-made edit
          rather than carrying them onto a different document. */}
      <ExhibitDetail
        key={focused.exhibit_id}
        conversationId={conversationId}
        sessionId={sessionId}
        header={focused}
        readOnly={readOnly}
        onAsked={onAsked}
      />
    </div>
  );
}

/** The tabbed body, shared by the column and the sheet so the two cannot drift. */
export function PaneBody({
  conversationId,
  sessionId,
  exhibits,
  readOnly,
  onClose,
  onAsked,
}: PaneProps & { onClose?: () => void; onAsked?: () => void }): React.JSX.Element {
  const tab = useExhibitPane((s) => s.tab);
  const setTab = useExhibitPane((s) => s.setTab);
  const subjects = useSubjectCount(conversationId);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => setTab(value === 'index' ? 'index' : 'artefacts')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5">
        <Tabs.List aria-label="Artefacts and index" className="flex gap-1">
          {(['artefacts', 'index'] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium text-ink-muted focus-ring',
                'hover:text-ink data-[state=active]:bg-surface-sunken data-[state=active]:text-ink',
              )}
            >
              {value === 'artefacts' ? `Artefacts (${exhibits.length})` : `Index (${subjects})`}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Close the artefact pane"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </div>
      <Tabs.Content value="artefacts" className="min-h-0 flex-1 overflow-y-auto focus-ring">
        <ArtefactsTab
          conversationId={conversationId}
          sessionId={sessionId}
          exhibits={exhibits}
          readOnly={readOnly}
          onAsked={onAsked}
        />
      </Tabs.Content>
      <Tabs.Content value="index" className="min-h-0 flex-1 overflow-y-auto p-3 focus-ring">
        {subjects === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing indexed yet — molecules, jobs and notes this conversation mentions appear here.
          </p>
        ) : (
          <RailBody conversationId={conversationId} />
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}

/** The column at `lg` and wider, at the reader's width, with the resizer on its leading edge. */
export function ExhibitPaneColumn(props: PaneProps): React.JSX.Element {
  const width = useExhibitPane((s) => s.widthPx);
  const setWidth = useExhibitPane((s) => s.setWidth);
  const id = useId();
  return (
    <aside
      id={id}
      aria-label="Artefacts"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border-subtle bg-surface-sunken"
    >
      <Resizer width={width} onResize={setWidth} controls={id} />
      <PaneBody {...props} onClose={() => useExhibitPane.getState().close()} />
    </aside>
  );
}
