/**
 * The "show your work" panel.
 *
 * An honesty constraint used to drive the wording here: the backend emitted tool *invocations*
 * only, so the panel said what the agent called and never implied it was showing what came back.
 * `tool_result` (backend D-159) is what lifts that, and the caveat goes with it — a panel that
 * disclaims showing results while showing them is worse than either version.
 *
 * A call is also announced when it is *issued* now, so an entry with no result yet is a call still
 * running rather than one whose result was withheld. Three states per row: running, returned,
 * failed.
 *
 * `arguments` and `result` are raw strings the backend truncates to 200 characters, so both are
 * displayed as-is rather than parsed as JSON.
 */

import { useState } from 'react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { toolLabel } from '../lib/format.ts';
import { JobResultCard } from './JobResultCard.tsx';

/**
 * Icon per tool. An unknown tool falls back to a neutral wrench, so a gap here is cosmetic.
 *
 * It had gone stale in the one direction that is not cosmetic, though: it named `submit_qm_job` and
 * `get_qm_job_status`, which the backend replaced with `compute_dft_energy` and
 * `get_durable_job_status` — so the two rows a chemist watching a long QM run stares at were the
 * two guaranteed to miss. Grouped by capability, which is also how the backend's manifests are
 * organised, so a new bundle's tools have an obvious home.
 */
const TOOL_ICON: Record<string, string> = {
  // chem — bench chemistry
  resolve_compound: '🔤',
  stoichiometry_table: '⚖️',
  green_metrics: '♻️',
  render_structure: '🖼️',
  // calc — fast calculators
  compute_xtb_energy: '⚛️',
  compute_electronic_properties: '🔬',
  predict_site_reactivity: '🎯',
  optimize_geometry: '📐',
  compute_thermochemistry: '🌡️',
  predict_pka: '📈',
  predict_solubility: '💧',
  predict_logd: '🧫',
  predict_developability_profile: '💊',
  calculator_trust: '🎚️',
  calculator_outliers: '📉',
  find_calculations: '🗄️',
  list_artifacts: '📎',
  fetch_artifact: '📥',
  report_measurement: '🧾',
  // calc — durable
  compute_reaction_energy: '🔥',
  compare_solvents: '🧴',
  scan_coordinate: '〰️',
  sample_conformers: '🌀',
  compute_interaction_energy: '🧲',
  // qm
  compute_dft_energy: '🖥️',
  // bo — experiment design
  suggest_next_experiment: '🧪',
  resume_campaign: '▶️',
  generate_screening_design: '🗓️',
  campaign_progress: '📊',
  predict_outcome: '🔮',
  start_optimization_campaign: '🚀',
  // safety
  screen_hazards: '⚠️',
  screen_genotoxic_alerts: '☣️',
  ich_impurity_limit: '📋',
  // fingerprints
  similar_molecules: '🧬',
  substructure_matches: '🔎',
  similar_reactions: '🔗',
  // in-process
  gather_evidence: '🔍',
  find_notes: '🗂️',
  expand_note: '📄',
  find_knowledge_gaps: '🕳️',
  propose_knowledge_note: '📝',
  record_failure: '🚫',
  record_confirmed_answer: '✅',
  recall_observations: '💭',
  request_development_report: '📑',
  get_durable_job_status: '⏱️',
  find_past_jobs: '🕰️',
  ask_clarifying_question: '❓',
  list_attachments: '📁',
  read_attachment: '📖',
};

function JobCard({ entry }: { entry: TraceEntry }): React.JSX.Element {
  const failed = entry.kind === 'job_failed';
  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised p-3">
      {failed ? (
        <JobResultCard jobId={entry.job?.jobId ?? ''} reason={entry.job?.reason ?? ''} />
      ) : (
        <JobResultCard jobId={entry.job?.jobId ?? ''} summary={entry.job?.summary} />
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
          {entry.toolCall?.result !== undefined && (
            <div className="mt-1">
              <p className="text-xs text-ink-muted">returned</p>
              {/* Same truncation discipline as the arguments above; also never parsed. */}
              <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
                {entry.toolCall.result}
              </pre>
            </div>
          )}
          {/* Still open: not "we are hiding the result" but "the call has not come back". The
              row that follows says which of the two endings arrived. */}
          {entry.toolCall?.result === undefined &&
            !entry.toolCall?.failed &&
            !entry.toolCall?.unresolved && <p className="mt-1 text-xs text-ink-muted">running…</p>}
          {/* Read back from storage with no result. The turn is over, so "running…" would be a
              lie — and so would "returned" with nothing beside it. */}
          {entry.toolCall?.unresolved && (
            <p className="mt-1 text-xs text-ink-muted">outcome not recorded</p>
          )}
        </div>
      );

    case 'tool_failed':
      return (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
          <p className="flex items-center gap-1.5 text-sm text-danger">
            <span aria-hidden>✖</span>
            <span className="font-medium">{toolLabel(entry.toolFailure?.tool ?? 'tool')}</span>
            <span className="font-mono text-xs">{entry.toolFailure?.tool}</span>
            <span className="text-xs">failed</span>
          </p>
          {entry.toolFailure?.message && (
            <p className="mt-1 text-xs text-danger">{entry.toolFailure.message}</p>
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
    case 'job_failed':
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
            Tool calls the agent made, each with what it returned. Previews are truncated by the
            service, so a long result is shown in part.
          </p>
          {shown.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
