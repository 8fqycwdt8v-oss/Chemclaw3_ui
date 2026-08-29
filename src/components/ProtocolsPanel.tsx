/**
 * Every experiment design, and what state each is in.
 *
 * The reason this is a screen of its own rather than something read out of a conversation is the
 * same reason `/jobs` is: a design outlives the turn that drafted it. It is asked for on Monday,
 * corrected on Tuesday by somebody who was not in that conversation, approved on Wednesday and run
 * next week — and a chemist looking for "the amination screen we agreed" holds no session id.
 *
 * Two fields do most of the work in a row and neither is the title. **`status`** is what a reader
 * is scanning for — a `draft` is somebody's problem, an `approved` one is the lab's — and
 * **`blockers`** is the count that says whether the design can be run at all, which is why it is
 * rendered as a danger badge rather than as a number in a column nobody reads.
 */

import { useEffect, useState } from 'react';
import { FlaskConical, Search } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { relativeTime } from '../lib/format.ts';
import type { DesignStatus, DesignSummary } from '../../shared/protocols.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, Loading } from '@/components/chem/Feedback';
import { cn } from '@/lib/utils';

/**
 * Status tone.
 *
 * `abandoned` is the only danger: it is the one state that means the design will not be run, and a
 * reader scanning a list needs to see that before reading the title. `draft` is deliberately
 * neutral rather than a warning — a draft is the normal state of a design nobody has finished, not
 * a problem.
 */
export const STATUS_TONE: Record<DesignStatus, 'neutral' | 'brand' | 'ok' | 'danger'> = {
  requested: 'neutral',
  draft: 'neutral',
  approved: 'ok',
  executed: 'brand',
  abandoned: 'danger',
};

const STATUSES: DesignStatus[] = ['requested', 'draft', 'approved', 'executed', 'abandoned'];

/** Turn a service timestamp into "3 hours ago", or nothing when there is none to turn. */
function when(value: string): string {
  if (!value) return '';
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? '' : relativeTime(at);
}

export function ProtocolsPanel(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<DesignStatus | ''>('');
  const [project, setProject] = useState('');
  const [submittedProject, setSubmittedProject] = useState('');
  // The result carries the query it answers, so "loading" is derived rather than set — the same
  // shape `JobsPanel` uses, and for the same reason: clearing the list on the way into the effect
  // is a second render, and it would show a stale list under a new filter in between.
  const [loaded, setLoaded] = useState<{
    key: string;
    list: DesignSummary[];
  } | null>(null);

  const key = `${status}|${submittedProject}`;
  const designs = loaded?.key === key ? loaded.list : null;
  const filtered = status !== '' || submittedProject !== '';

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listProtocols(auth, {
        ...(status ? { status } : {}),
        ...(submittedProject ? { project: submittedProject } : {}),
      })
      .then((list) => !cancelled && setLoaded({ key: `${status}|${submittedProject}`, list }))
      .catch(() => !cancelled && setLoaded({ key: `${status}|${submittedProject}`, list: [] }));
    return () => {
      cancelled = true;
    };
  }, [auth, ready, status, submittedProject]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div>
          <h2 className="mb-1 text-lg font-semibold tracking-tight">Experiment protocols</h2>
          <p className="text-sm text-ink-muted">
            Every design the agent has drafted and every one a chemist has corrected — with the
            revision history behind each, because a protocol is a document rather than an answer.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span id="status-filter-label" className="text-2xs text-ink-subtle uppercase">
              Status
            </span>
            <div
              role="group"
              aria-labelledby="status-filter-label"
              className="flex flex-wrap gap-1.5"
            >
              <Button
                size="xs"
                variant={status === '' ? 'secondary' : 'ghost'}
                aria-pressed={status === ''}
                onClick={() => setStatus('')}
              >
                All
              </Button>
              {STATUSES.map((option) => (
                <Button
                  key={option}
                  size="xs"
                  variant={status === option ? 'secondary' : 'ghost'}
                  aria-pressed={status === option}
                  onClick={() => setStatus(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedProject(project.trim());
            }}
          >
            <label htmlFor="protocol-project" className="sr-only-live">
              Filter by project
            </label>
            <input
              id="protocol-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="Filter by project"
              className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm outline-none focus-ring"
            />
            <Button type="submit" size="sm">
              <Search aria-hidden className="size-3.5" />
              Filter
            </Button>
          </form>
        </div>

        {!designs && <Loading>Reading the designs…</Loading>}

        {designs?.length === 0 && (
          <EmptyState
            icon={<FlaskConical className="size-5" />}
            title={filtered ? 'No design matches that' : 'No experiment design yet'}
          >
            {filtered
              ? 'Nothing in this project is in that state. Clear the filters to see every design.'
              : 'A design appears here as soon as the agent drafts one, or as soon as a request is structured into one. Ask for an experiment in a conversation to start one.'}
          </EmptyState>
        )}

        {designs && designs.length > 0 && (
          <ul className="flex flex-col gap-2">
            {designs.map((design) => (
              <li key={design.design_id}>
                <button
                  type="button"
                  onClick={() => void navigate(`/protocols/${design.design_id}`)}
                  className={cn(
                    'w-full rounded-lg border border-border-subtle bg-surface-raised p-3 text-left',
                    'transition-colors hover:bg-surface-sunken focus-ring',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{design.title || 'Untitled design'}</span>
                    <Badge tone="neutral">{design.mode}</Badge>
                    <Badge tone={STATUS_TONE[design.status] ?? 'neutral'}>{design.status}</Badge>
                    {/* The count that decides whether this can be run at all, so it is a badge
                        rather than a column: a reader scanning twenty rows sees it, and a design
                        with none gets no badge, which is what makes the badge mean something. */}
                    {design.blockers > 0 && (
                      <Badge tone="danger">
                        {design.blockers} blocker{design.blockers === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {design.arms} arm{design.arms === 1 ? '' : 's'} · revision{' '}
                    {design.head_revision}
                    {design.project && ` · ${design.project}`}
                    {design.opened_by && ` · opened by ${design.opened_by}`}
                    {when(design.updated_at) && ` · updated ${when(design.updated_at)}`}
                  </p>
                  <p className="mt-1 font-mono text-2xs break-all text-ink-subtle">
                    {design.design_id}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
