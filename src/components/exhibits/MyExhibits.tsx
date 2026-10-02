/**
 * Every artefact of the reader's, across every conversation — "My artefacts".
 *
 * The reason for a page of its own is `/protocols`' reason: an artefact outlives the turn, and
 * often the conversation, that produced it. A report draft written on Monday is wanted on Thursday
 * by somebody holding no session id, and the pane only ever shows the conversation on screen.
 *
 * **A row opens its conversation, with the pane on that artefact.** The conversation is identified
 * by its *session*, which is what the service lists — so a row goes through `/open/:sessionId`,
 * the resolver that adopts a session into a local conversation (or finds the one that already has
 * it) and lands on `/c/<local id>`. The pane's focus is set before the navigation, keyed by that
 * session, so it is waiting when the conversation renders; the resolver itself stays exactly what
 * it was, with no query parameter for it to drop on its redirect.
 *
 * `GET /exhibits` lists sessions the reader owns *or* was let into, so a row may be a colleague's
 * conversation. The resolver handles that case already (a shared session opens as one to join).
 */

import { Shapes } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext.tsx';
import { useApiQuery } from '../../api/queryClient.ts';
import { myExhibitsQuery } from '../../api/queries.ts';
import { relativeTime } from '../../lib/format.ts';
import { useChatStore } from '../../state/chatStore.ts';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Loading } from '@/components/chem/Feedback';
import { KindIcon, editedBy, kindLabel } from './kind.tsx';

function when(value: string): string {
  if (!value) return '';
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? '' : relativeTime(at);
}

export function MyExhibits(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const navigate = useNavigate();
  const viewer = useChatStore((s) => s.viewer);
  const {
    data: exhibits,
    error,
    isPending,
  } = useApiQuery({
    ...myExhibitsQuery(auth),
    enabled: ready,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div>
          <h2 className="mb-1 text-lg font-semibold tracking-tight">My artefacts</h2>
          <p className="text-sm text-ink-muted">
            The reports, tables, structure panels and charts the agent wrote beside your
            conversations, and the results you pinned — newest activity first. Opening one opens its
            conversation with the artefact beside it.
          </p>
        </div>

        {isPending && !error && <Loading>Reading your artefacts…</Loading>}
        {error && (
          <EmptyState title="Your artefacts could not be listed">{error.message}</EmptyState>
        )}
        {exhibits && exhibits.length === 0 && (
          <EmptyState icon={<Shapes />} title="No artefacts yet">
            When the agent writes a report draft, a table or a figure in a conversation, it is
            listed here.
          </EmptyState>
        )}
        {exhibits && exhibits.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {exhibits.map((x) => {
              const edited = editedBy(x.head_author_kind, x.head_author, viewer);
              return (
                <li key={x.exhibit_id}>
                  <button
                    type="button"
                    onClick={() => {
                      useExhibitPane.getState().show(x.session_id, x.exhibit_id);
                      void navigate(`/open/${encodeURIComponent(x.session_id)}`);
                    }}
                    className="flex w-full items-center gap-3 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-left hover:bg-surface-sunken focus-ring"
                  >
                    <KindIcon kind={x.kind} className="size-4 shrink-0 text-ink-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {x.title || 'Untitled artefact'}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                        <span>{kindLabel(x.kind)}</span>
                        <span aria-hidden>·</span>
                        <span>rev {x.head_revision}</span>
                        {when(x.updated_at) && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{when(x.updated_at)}</span>
                          </>
                        )}
                        {edited && <Badge tone="brand">{edited}</Badge>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
