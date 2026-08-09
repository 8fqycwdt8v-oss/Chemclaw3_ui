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
 * `arguments` is a raw string the backend truncates to 200 characters, so it is displayed as-is
 * rather than parsed as JSON. The result used to be the same and no longer has to be: a returned
 * row carries a `result_ref`, and expanding it fetches the full typed payload and renders a card
 * (`./results/ResultCard.tsx`). The preview remains the fallback for every row that has no ref,
 * whose fetch fails, or whose shape nothing cards — which is most of them, and is fine.
 */

import { useState } from 'react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { toolLabel } from '../lib/format.ts';
import { methodFor } from '../chem/provenance.ts';
import { JobResultCard } from './JobResultCard.tsx';
import { ResultCard } from './results/ResultCard.tsx';

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

/**
 * What method produced this row's numbers, and what its authors say it does not establish.
 *
 * The badge is always visible once the panel is open, because "which method" is the question US-8
 * says a chemist should never have to ask; the caveat is one click further in, because these are
 * two to four lines each and five of them stacked is the annotation clutter that trains people to
 * stop reading.
 *
 * Every caveat is the backend's own wording (see `src/chem/provenance.ts`). A tool this frontend
 * has no sourced method for renders nothing at all — a confidently wrong method label would be
 * worse than the silence it replaced.
 */
function MethodBadge({ tool }: { tool: string }): React.JSX.Element | null {
  const method = methodFor(tool);
  if (!method) return null;
  return (
    <div className="mt-1">
      <span className="inline-flex items-center rounded border border-border-subtle bg-surface px-1.5 py-px text-[0.7rem] text-ink-muted">
        {method.method}
      </span>
      {method.caveat && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-ink-muted">what it does not say</summary>
          <p className="mt-1 border-l-2 border-warn/40 pl-2 text-xs text-ink-muted">
            {method.caveat}
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * The numbers this call returned, in full.
 *
 * From `tool_result.numbers`, never from the preview beside it — the preview is cut at an
 * arbitrary byte and this list is not, which is the entire reason the backend sends both. It is
 * also what the figure marks in the answer above were checked against, so a reader who distrusts a
 * mark can see the evidence rather than take it on faith.
 */
function ReturnedNumbers({ numbers }: { numbers: number[] }): React.JSX.Element | null {
  if (numbers.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-ink-muted">
        {numbers.length} value{numbers.length === 1 ? '' : 's'} returned (untruncated)
      </summary>
      <p className="mt-1 break-words rounded bg-surface-sunken p-2 font-mono text-xs">
        {numbers.join(', ')}
      </p>
    </details>
  );
}

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
          <MethodBadge tool={entry.toolCall?.tool ?? ''} />
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
              <ResultCard
                tool={entry.toolCall.tool}
                preview={entry.toolCall.result}
                resultRef={entry.toolCall.resultRef}
              />
              <ReturnedNumbers numbers={entry.toolCall.numbers ?? []} />
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
            Tool calls the agent made, each with what it returned. What the service streams is a
            truncated preview; a returned row can fetch its full result and render it.
          </p>
          {shown.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
