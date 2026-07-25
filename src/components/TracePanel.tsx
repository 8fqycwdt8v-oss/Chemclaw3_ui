/**
 * The "show your work" panel.
 *
 * An honesty constraint drives the wording here: the backend emits tool *invocations* only —
 * there is no tool-result event in the contract. So this panel says what the agent called, and
 * never implies it is showing what came back. `arguments` is a raw string the backend truncates
 * to 200 characters, so it is displayed as-is rather than parsed as JSON.
 */

import { useState } from 'react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { formatEnergy, toolLabel } from '../lib/format.ts';
import { Molecule } from './Molecule.tsx';

const TOOL_ICON: Record<string, string> = {
  gather_evidence: '🔍',
  expand_note: '📄',
  find_notes: '🗂️',
  compute_xtb_energy: '⚛️',
  predict_pka: '📈',
  predict_solubility: '💧',
  submit_qm_job: '🖥️',
  get_qm_job_status: '⏱️',
  suggest_next_experiment: '🧪',
  screen_hazards: '⚠️',
  propose_knowledge_note: '📝',
  record_confirmed_answer: '✅',
  similar_reactions: '🔗',
  similar_molecules: '🧬',
  substructure_matches: '🔎',
};

function JobCard({ entry }: { entry: TraceEntry }): React.JSX.Element {
  const summary = entry.job?.summary ?? {};
  const smiles = typeof summary.molecule_smiles === 'string' ? summary.molecule_smiles : null;
  const energy =
    typeof summary.total_energy_hartree === 'number' ? summary.total_energy_hartree : null;
  const converged = summary.converged;

  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-ink-muted">{entry.job?.jobId}</span>
        {converged === true && (
          <span className="rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok">converged</span>
        )}
        {converged === false && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs text-warn">
            not converged
          </span>
        )}
      </div>
      {smiles && <Molecule smiles={smiles} width={280} height={190} />}
      {energy !== null && (
        <p className="mt-2 font-mono text-xs text-ink-muted">{formatEnergy(energy)}</p>
      )}
    </div>
  );
}

function Row({ entry }: { entry: TraceEntry }): React.JSX.Element | null {
  switch (entry.kind) {
    case 'plan':
      return (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Plan revised</p>
          <ul className="space-y-0.5">
            {entry.plan?.todos.map((todo, i) => (
              <li key={i} className="flex gap-1.5 text-sm">
                <span className="text-ink-muted">▢</span>
                <span>{todo}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'tool_call':
      return (
        <div>
          <p className="flex items-center gap-1.5 text-sm">
            <span aria-hidden>{TOOL_ICON[entry.toolCall?.tool ?? ''] ?? '🔧'}</span>
            <span className="font-medium">{toolLabel(entry.toolCall?.tool ?? 'tool')}</span>
            <span className="font-mono text-xs text-ink-muted">{entry.toolCall?.tool}</span>
          </p>
          {entry.toolCall?.arguments && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-ink-muted">arguments</summary>
              {/* Raw, truncated to 200 chars server-side — never parsed as JSON. */}
              <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
                {entry.toolCall.arguments}
              </pre>
            </details>
          )}
        </div>
      );

    case 'job_started':
      return (
        <p className="text-sm">
          Started <span className="font-medium">{entry.job?.kind ?? 'job'}</span>{' '}
          <span className="font-mono text-xs text-ink-muted">{entry.job?.jobId}</span>
          <span className="ml-1 text-xs text-ink-muted">— runs asynchronously</span>
        </p>
      );

    case 'job_completed':
      return <JobCard entry={entry} />;

    case 'note_proposed':
      return (
        <p className="text-sm">
          Proposed note <span className="font-mono text-xs">{entry.note?.noteId}</span> for review
          {entry.note?.reference && (
            <span className="ml-1 font-mono text-xs text-ink-muted">
              ({entry.note.reference})
            </span>
          )}
        </p>
      );

    case 'question':
    case 'approval_request':
      // Rendered as interactive cards in the message body, not as inert trace lines.
      return null;

    default:
      return null;
  }
}

export function TracePanel({ trace }: { trace: TraceEntry[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const shown = trace.filter((e) => e.kind !== 'question' && e.kind !== 'approval_request');
  if (shown.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
      >
        {open ? 'Hide' : 'Show'} the agent’s work ({shown.length} step
        {shown.length === 1 ? '' : 's'})
      </button>
      {open && (
        <div
          className={cn(
            'mt-2 space-y-3 rounded-md border border-border-subtle',
            'bg-surface-sunken p-3',
          )}
        >
          <p className="text-xs text-ink-muted">
            Tool calls the agent made. The service streams invocations only, so this shows what was
            called — not what each call returned.
          </p>
          {shown.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
