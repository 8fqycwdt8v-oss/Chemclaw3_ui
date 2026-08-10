/**
 * A citation reference rendered inline in an answer.
 *
 * The backend gives us no way to resolve one of these ids — there is no knowledge-graph read
 * endpoint on the HTTP surface, only the agent's own `expand_note`/`find_notes` and
 * `get_durable_job_status` tools. So clicking a chip does the honest thing: it drops a follow-up
 * question into the composer asking the agent about it. That is genuinely the only path to the
 * content, and it is one the agent handles well.
 *
 * The question differs by kind because the tools behind it do: `expand_note` cannot answer for a
 * durable run, and a chip that asked it to would spend a turn finding that out.
 */

import { cn } from '../lib/cn.ts';
import type { CitationKind } from '../lib/citations.ts';

/**
 * A tone per kind, over the closed set `kindOf` actually emits.
 *
 * It used to key on `reaction`/`note`/`qm`, which is the vocabulary from before ids were
 * recognised off the corpus: `reaction` and `qm` had no producer left, and `job` — which does —
 * had no row, so it fell through to the note tone and a durable run looked exactly like a
 * knowledge note. They are different things to click on, and the difference is worth a colour.
 *
 * `accent` for a job: the neutral "this is a thing, not a problem" tone the rest of the UI uses,
 * and the same one `/jobs` marks a running row with.
 */
const PALETTE: Record<CitationKind, string> = {
  note: 'border-border-subtle bg-surface-sunken text-ink-muted',
  job: 'border-accent/40 bg-accent-soft text-accent',
};

export function CitationChip({ kind, id }: { kind: CitationKind; id: string }): React.JSX.Element {
  const prefill =
    kind === 'job'
      ? `What happened in ${id} — its status, its result, and what it was started for?`
      : `Expand ${id} — what are the conditions, outcomes, and caveats?`;
  return (
    <button
      type="button"
      title={kind === 'job' ? `Ask the agent about run ${id}` : `Ask the agent to expand ${id}`}
      onClick={() => {
        window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail: prefill }));
      }}
      className={cn(
        'mx-0.5 inline-flex items-center rounded border px-1.5 py-px align-baseline',
        'font-mono text-[0.8em] leading-normal transition-colors hover:brightness-95',
        PALETTE[kind],
      )}
    >
      {id}
    </button>
  );
}
