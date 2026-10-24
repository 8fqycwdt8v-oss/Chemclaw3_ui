/**
 * The chemist's standing queries — what the agent was asked to watch for — and a way to stop each.
 * A watch is saved only by a turn (`watch_for`); this screen is where a person sees and cancels
 * one without asking the agent. When the deployment evaluates none (`digests_enabled` false), it
 * says so, since a listed watch would otherwise read as a promise of news.
 */

import { useState } from 'react';
import { Eye, Trash2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { keys, queryClient, useApiQuery } from '../api/queryClient.ts';
import { api } from '../api/client.ts';
import { relativeTime } from '../lib/format.ts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/** A service timestamp as "3 hours ago", or the raw value when it is not one. */
function when(value: string): string {
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? value : relativeTime(at);
}

export function WatchesPanel(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.watches,
    queryFn: () => api.listWatches(auth),
    enabled: ready,
  });
  const [failed, setFailed] = useState('');

  async function stop(id: number, query: string): Promise<void> {
    setFailed('');
    try {
      await api.stopWatch(auth, id);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : `Could not stop watching for ${query}.`);
    }
    void queryClient.invalidateQueries({ queryKey: keys.watches });
  }

  let body: React.ReactNode;
  if (isPending) {
    body = <Loading>Loading your watches…</Loading>;
  } else if (error) {
    body = (
      <EmptyState icon={<Eye className="size-5" />} title="Could not load">
        {error instanceof Error ? error.message : 'The service did not answer.'}
      </EmptyState>
    );
  } else if ((data?.watches ?? []).length === 0) {
    body = (
      <EmptyState icon={<Eye className="size-5" />} title="You watch for nothing">
        Ask in a conversation to be told when new knowledge about something lands, and the watch
        appears here.
      </EmptyState>
    );
  } else {
    body = (
      <ul className="space-y-3">
        {(data?.watches ?? []).map((watch) => (
          <li key={watch.id} className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium break-words">{watch.query}</h3>
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <Trash2 className="size-4" /> Stop watching
                  </Button>
                }
                title={`Stop watching for “${watch.query}”?`}
                description="Nothing more will be reported for it. Ask again in a conversation to watch for it anew."
                confirmLabel="Stop watching"
                variant="destructive"
                onConfirm={() => void stop(watch.id, watch.query)}
              />
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              {watch.note_type ? `Only ${watch.note_type} notes. ` : ''}
              {watch.last_seen_at
                ? `Checked up to ${when(watch.last_seen_at)}.`
                : 'Not checked yet.'}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Eye className="size-6" /> Watches
      </h1>
      <p className="mb-6 text-sm text-ink-muted">
        Standing queries: new knowledge that matches one is reported to you.
      </p>
      {data && !data.digests_enabled && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn-ink"
        >
          This deployment does not evaluate watches at the moment, so none of these will report
          anything until an operator turns digests on.
        </p>
      )}
      {failed && <p className="mb-2 text-sm text-danger">{failed}</p>}
      {body}
    </div>
  );
}
