/**
 * A citation reference rendered inline in an answer.
 *
 * The backend gives us no way to resolve a note id — there is no knowledge-graph read endpoint on
 * the HTTP surface, only the agent's own `expand_note`/`find_notes` tools. So clicking a chip
 * does the honest thing: it drops a follow-up question into the composer asking the agent to
 * expand that note. That is genuinely the only path to the content, and it is one the agent
 * handles well.
 */

import { cn } from '../lib/cn.ts';

const PALETTE: Record<string, string> = {
  reaction: 'border-accent/40 bg-accent-soft text-accent',
  note: 'border-border-subtle bg-surface-sunken text-ink-muted',
  qm: 'border-ok/40 bg-ok-soft text-ok',
};

export function CitationChip({ kind, id }: { kind: string; id: string }): React.JSX.Element {
  const prefill = `Expand ${id} — what are the conditions, outcomes, and caveats?`;
  return (
    <button
      type="button"
      title={`Ask the agent to expand ${id}`}
      onClick={() => {
        window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail: prefill }));
      }}
      className={cn(
        'mx-0.5 inline-flex items-center rounded border px-1.5 py-px align-baseline',
        'font-mono text-[0.8em] leading-normal transition-colors hover:brightness-95',
        PALETTE[kind] ?? PALETTE.note,
      )}
    >
      {id}
    </button>
  );
}
