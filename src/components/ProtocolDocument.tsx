/**
 * One experiment design, laid out as a document — request, conditions, charge, procedure, factors,
 * run sheet, plate, analytics, hazards, expectation, evidence, history — because a chemist checks
 * it line by line before charging a vessel.
 *
 * Each request field shows its basis: `stated` (with the chemist's quote), `inferred` (warn-toned)
 * or `absent`, so an agent's guess is never presented as an instruction.
 *
 * It never composes a tool call from a click: "Ask Claude to revise" fills the composer and a human
 * presses Send (`state/composerEvents.ts`).
 */

import { useCallback, useState } from 'react';
import { FileDiff, FlaskConical, History, MessageSquarePlus, Pencil, Printer } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { protocolQuery } from '../api/queries.ts';
import { useChatStore } from '../state/chatStore.ts';
import { prefill } from '../state/composerEvents.ts';
import { relativeTime } from '../lib/format.ts';
import { CHECK_TONE, DownloadCsv } from '../results/renderers.tsx';
import type {
  DesignDiff,
  DesignStatus,
  EvidenceRef,
  ExperimentDesign,
  ProtocolCheck,
  RequestField,
} from '../../shared/protocols.ts';
import type { Json } from '../results/shape.ts';
import { legalStatusMoves, setpointsFor, sharedSetpoints } from '../../shared/protocols.ts';
import { Molecule } from './Molecule.tsx';
import { PlateMap } from './PlateMap.tsx';
import { RevisionDiff } from './RevisionDiff.tsx';
import { ProtocolEditor } from './ProtocolEditor.tsx';
import { STATUS_TONE } from './ProtocolsPanel.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** A service timestamp as "3 hours ago", or nothing when there is none to turn. */
function when(value: string): string {
  if (!value) return '';
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? '' : relativeTime(at);
}

/** A number for display, or an em dash. `null` is unset, which is never zero. */
const numeric = (value: number | null): string => (value === null ? '—' : String(value));

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A scrolling table that never lets the page scroll sideways. */
function Grid({
  label,
  headers,
  children,
}: {
  label: string;
  headers: string[];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
    >
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-sunken text-2xs tracking-wide text-ink-subtle uppercase">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="px-2.5 py-2 font-medium whitespace-nowrap">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">{children}</tbody>
      </table>
    </div>
  );
}

/**
 * One request field with its basis. A `stated` quote is in a tooltip on a focusable trigger, so
 * keyboard users can check it.
 */
function RequestValue({ label, field }: { label: string; field: RequestField }): React.JSX.Element {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-ink-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
        {field.basis === 'absent' ? (
          <span className="text-ink-muted">not stated</span>
        ) : (
          <span>{field.value}</span>
        )}
        {field.basis === 'stated' && field.quote ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${label} was stated — show the words it was read from`}
                className="rounded-sm focus-ring"
              >
                <Badge tone="ok">stated</Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent>“{field.quote}”</TooltipContent>
          </Tooltip>
        ) : field.basis === 'stated' ? (
          <Badge tone="ok">stated</Badge>
        ) : field.basis === 'inferred' ? (
          // Warn-toned and spelled out, never a quiet grey chip: this value is the agent's, and a
          // reader who skims past it is agreeing to something nobody asked for.
          <Badge tone="warn">inferred — nobody stated this</Badge>
        ) : (
          <Badge tone="neutral">absent</Badge>
        )}
      </dd>
    </div>
  );
}

function ChecksStrip({
  checks,
  kind,
}: {
  checks: ProtocolCheck[];
  kind: 'request' | 'protocol';
}): React.JSX.Element {
  const failing = checks.filter((check) => !check.passed);
  const blockers = failing.filter((check) => check.severity === 'blocker');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {blockers.length > 0 ? (
          <Badge tone="danger">
            {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
          </Badge>
        ) : failing.length > 0 ? (
          <Badge tone="warn">
            {failing.length} check{failing.length === 1 ? '' : 's'} failed
          </Badge>
        ) : checks.length === 0 ? (
          // Not "passed": zero checks is the absence of a finding, not a clean one. Same three-way
          // rule the campaign renderer applies to a plateau verdict the service declined to give.
          <Badge tone="neutral">no checks recorded</Badge>
        ) : kind === 'request' ? (
          // At the request stage, unrun checks are reported as passing notes, so they are not shown
          // as passes.
          <Badge tone="neutral">the ask only — the procedure has not been checked</Badge>
        ) : (
          <Badge tone="ok">
            {checks.length} check{checks.length === 1 ? '' : 's'} passed
          </Badge>
        )}
        <span className="text-2xs text-ink-subtle">
          structural checks — they read the document, not the chemistry
        </span>
      </div>

      {failing.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {failing.map((check) => (
            <li
              key={check.check_id}
              className="flex flex-wrap items-baseline gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm"
            >
              <Badge tone={CHECK_TONE[check.severity] ?? 'neutral'}>{check.severity}</Badge>
              <span className="font-mono text-2xs text-ink-subtle">{check.check_id}</span>
              <span className="min-w-0 flex-1">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The conditions every arm shares (`sharedSetpoints`), not the body's own setpoints. Fields the
 * arms disagree on show `—`; the run sheet carries them per row.
 */
function Conditions({ design }: { design: ExperimentDesign }): React.JSX.Element {
  const setpoints = sharedSetpoints(design);
  const entries: [string, string][] = [
    ['Temperature', setpoints.temperature_c === null ? '—' : `${setpoints.temperature_c} °C`],
    ['Time', setpoints.time_h === null ? '—' : `${setpoints.time_h} h`],
    ['Pressure', setpoints.pressure_bar === null ? '—' : `${setpoints.pressure_bar} bar`],
    [
      'Concentration',
      setpoints.concentration_molar === null ? '—' : `${setpoints.concentration_molar} M`,
    ],
    ['pH', numeric(setpoints.ph)],
    ['Solvent', setpoints.solvent || '—'],
    ['Atmosphere', setpoints.atmosphere || '—'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {entries.map(([label, value]) => (
        <div
          key={label}
          className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2"
        >
          <dt className="text-2xs tracking-wide text-ink-subtle uppercase">{label}</dt>
          <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Run-sheet columns shown only when the arms disagree (the service's
 * `render._RUN_SHEET_WHEN_VARYING`, same order). `Conditions` states the shared values.
 */
const WHEN_VARYING = ['c /M', 'Atmosphere', 'p /bar', 'pH'] as const;

/** One run-sheet row per arm, resolved against the base — what a bench actually works from. */
function runSheetRecords(design: ExperimentDesign): Json[] {
  const wells = new Map(design.layout?.wells.map((well) => [well.arm_id, well]) ?? []);
  const factorNames = design.factors.map((factor) => factor.name);
  const records = design.arms.map((arm) => {
    const well = wells.get(arm.arm_id);
    const levels: Json = {};
    for (const name of factorNames) levels[name] = arm.levels[name] ?? '';
    // Field by field, not `arm.setpoints ?? base` — see `setpointsFor`.
    const setpoints = setpointsFor(design.base.setpoints, arm);
    // Fixed columns are display labels (capitals, spaces, slashes), so no factor name
    // (`^[a-z][a-z0-9_]*$`, e.g. `solvent`) can collide with one.
    return {
      Arm: arm.arm_id,
      Well: well?.label ?? '',
      Run: well?.run_order ?? '',
      ...levels,
      // Temperature, time and solvent always; then `WHEN_VARYING` in the service's order.
      'T /°C': setpoints.temperature_c ?? '',
      't /h': setpoints.time_h ?? '',
      Solvent: setpoints.solvent,
      'c /M': setpoints.concentration_molar ?? '',
      Atmosphere: setpoints.atmosphere,
      'p /bar': setpoints.pressure_bar ?? '',
      pH: setpoints.ph ?? '',
      Control: arm.control,
      'Replicate of': arm.replicate_of,
      Note: arm.note,
    };
  });
  // Drop the `WHEN_VARYING` columns all arms agree on; `Conditions` shows those.
  const constant = new Set<string>(
    WHEN_VARYING.filter((key) => new Set(records.map((row) => String(row[key]))).size <= 1),
  );
  const trimmed = records.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !constant.has(key))),
  );
  // Sorted by run order (as the service's `run_sheet_rows`), since a randomised design runs in an
  // order the plate does not show.
  return wells.size > 0
    ? [...trimmed].sort((a, b) => {
        const left = typeof a.Run === 'number' ? a.Run : Number.POSITIVE_INFINITY;
        const right = typeof b.Run === 'number' ? b.Run : Number.POSITIVE_INFINITY;
        return left - right;
      })
    : trimmed;
}

function Evidence({ evidence }: { evidence: EvidenceRef[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((item, index) => (
        <li
          key={`${item.ref}-${index}`}
          className="rounded-lg border border-border-subtle bg-surface-raised p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{item.kind}</Badge>
            <span className="font-mono text-2xs break-all">{item.ref || 'no reference'}</span>
            {item.tool && <span className="text-2xs text-ink-subtle">{item.tool}</span>}
          </div>
          {item.summary && <p className="mt-1 text-sm">{item.summary}</p>}
          {/* Which numbers each piece of evidence supports. */}
          {item.supports.length > 0 && (
            <p className="mt-1 font-mono text-2xs text-ink-subtle">
              supports {item.supports.join(', ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Why a sign-off was not recorded: `status` and `revision` are the service's two 409 codes, each
 * with its own remedy; `other` is anything else (e.g. a 422 meaning this repo's transition table
 * drifted). `from` and `at` capture what the page showed when pressed, since both conflicts re-read
 * the design.
 */
type Refusal = { reference: string } & (
  | { kind: 'status'; from: DesignStatus }
  | { kind: 'revision'; at: number }
  | { kind: 'other'; reason: string }
);

export function ProtocolDocument(): React.JSX.Element {
  const { designId = '' } = useParams();
  const { auth, ready } = useAuth();
  const navigate = useNavigate();

  /**
   * The revision on screen lives in the URL (`?revision=`; absent is the head), so a link or reload
   * lands on it. Updated with `replace` so stepping through history does not fill Back.
   */
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('revision') ?? '');
  const at = Number.isInteger(requested) && requested > 0 ? requested : undefined;
  const setAt = useCallback(
    (revision: number | undefined): void => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (revision === undefined) next.delete('revision');
          else next.set('revision', String(revision));
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const [editing, setEditing] = useState(false);
  const [diff, setDiff] = useState<DesignDiff | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A refused sign-off, kept apart from `notice` (a neutral success banner): rendered as an alert
   * with a reload action.
   */
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  /**
   * The design at the revision the URL names, keyed by `(designId, at)`. `refetch` re-reads without
   * clearing what is on screen.
   */
  const {
    data: view = null,
    error,
    refetch,
  } = useApiQuery({
    ...protocolQuery(designId, at, auth),
    enabled: ready && Boolean(designId),
  });
  const failed = error ? error.message : null;
  const reload = useCallback(() => void refetch(), [refetch]);

  const showDiff = async (from: number, to: number): Promise<void> => {
    try {
      setDiff(await api.getProtocolDiff(designId, from, to, auth));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not read that comparison.');
    }
  };

  /**
   * Record a sign-off against the revision on screen; the service refuses anything but the head, so
   * a colleague's intervening save gives a 409, not a misattributed approval.
   */
  const moveStatus = async (
    status: DesignStatus,
    atRevision: number,
    fromStatus: DesignStatus,
  ): Promise<void> => {
    setRefusal(null);
    try {
      await api.setProtocolStatus(
        designId,
        status,
        atRevision,
        fromStatus,
        statusReason.trim(),
        auth,
      );
      setStatusReason('');
      setNotice(`Status recorded as ${status}.`);
      reload();
    } catch (err) {
      // Failures never go to `notice`. Each 409 code gets its own sentence; anything else keeps the
      // service's words in the alert.
      setNotice(null);
      // The service's id for the failed request, for support.
      const reference = err instanceof ApiError ? err.correlationId : '';
      // Both conflicts mean this page is stale, so re-read the design: commonly the chemist's own
      // first click landed and its response was lost, and the re-read shows the move already
      // recorded. A 422 or unreachable service is not reloaded.
      if (err instanceof ApiError && err.kind === 'status_conflict') {
        setRefusal({ kind: 'status', from: fromStatus, reference });
        reload();
        return;
      }
      if (err instanceof ApiError && err.kind === 'revision_conflict') {
        setRefusal({ kind: 'revision', at: atRevision, reference });
        reload();
        return;
      }
      setRefusal({
        kind: 'other',
        reason: err instanceof Error && err.message ? err.message : 'The service did not say why.',
        reference,
      });
    }
  };

  /**
   * Hand the revision back to the agent as an unsent sentence in the composer. This screen has no
   * composer, so navigate to the conversation first and dispatch after its listener is installed.
   * `prefill`, never send.
   */
  const askToRevise = async (revision: number): Promise<void> => {
    const store = useChatStore.getState();
    const target =
      store.activeId && store.conversations[store.activeId]
        ? store.activeId
        : store.createConversation();
    await navigate(`/c/${target}`);
    window.setTimeout(
      () =>
        prefill(
          `Revise experiment protocol ${designId} at revision ${revision}: ` +
            `read it first, then propose the change and say what it would affect. `,
        ),
      0,
    );
  };

  if (!designId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <EmptyState icon={<FlaskConical className="size-5" />} title="No design named">
          This link does not name a design.
        </EmptyState>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-4xl">
          <p role="alert" className="text-sm text-danger-ink">
            {failed}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigate('/protocols')}>
              Back to the list
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Loading>Reading the design…</Loading>
      </div>
    );
  }

  // Flat, as the service sends it: `revision` is a number beside the revision's fields.
  const { design, history, summary, status_history: signOffs } = view;
  const head = history.reduce((best, row) => Math.max(best, row.revision), view.revision);
  const stale = view.revision !== head;
  const records = runSheetRecords(design);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  /**
   * Sign-off buttons for the design's legal moves only (`legalStatusMoves`), so no button can only
   * be refused.
   */
  const moves = summary ? legalStatusMoves(summary.status, view.kind) : [];

  return (
    // `data-print="document"` is what the print stylesheet keys on: it takes everything that is not
    // inside this element off the page. See `@media print` in `src/index.css`.
    <div data-print="document" className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-7">
        <header className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {design.request.title || 'Untitled design'}
            </h2>
            {design.request.goal && (
              <p className="mt-1 text-sm text-ink-muted">{design.request.goal}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{design.request.mode}</Badge>
            {summary && (
              <Badge tone={STATUS_TONE[summary.status] ?? 'neutral'}>{summary.status}</Badge>
            )}
            <Badge tone="neutral">{view.kind}</Badge>
            <span className="text-2xs text-ink-subtle">
              revision {view.revision} of {head} · {view.author_kind} {view.author} ·{' '}
              {when(view.created_at)}
            </span>
          </div>

          {view.change_note && <p className="text-sm text-ink-muted">“{view.change_note}”</p>}

          {/* An old revision is labelled as such, with a link to the current one. */}
          {stale && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
            >
              You are reading revision {view.revision}. Revision {head} is the current one.
              <Button size="xs" variant="outline" onClick={() => setAt(undefined)}>
                Open the current revision
              </Button>
            </p>
          )}

          {notice && (
            <p
              role="status"
              className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
            >
              {notice}
            </p>
          )}

          {/* Three refusals, three sentences. The two conflicts have already re-read the design; Reload is for the third. */}
          {refusal && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
            >
              {refusal.kind === 'status' ? (
                /*
                 * Worded to be true whether someone else moved it or the chemist's own earlier
                 * click landed unseen; points at the sign-off list that settles which.
                 */
                <p>
                  <strong>This design has already moved.</strong> It was {refusal.from} when you
                  pressed the button and is not any more, so nothing was recorded now. The sign-off
                  list below has been re-read: it says who moved it, when and why — and that may be
                  an earlier attempt of your own that landed after its answer was lost.
                </p>
              ) : refusal.kind === 'revision' ? (
                <p>
                  <strong>The document moved under this sign-off.</strong> Revision {refusal.at} was
                  no longer the latest, so recording it would have attributed your name to a
                  document that has since changed. Nothing was recorded — the design has been
                  re-read, so read the current revision before deciding again.
                </p>
              ) : (
                <p>
                  <strong>The service refused this move.</strong> {refusal.reason} Nothing was
                  recorded.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={reload}>
                  Reload the design
                </Button>
                {refusal.reference && <span>Reference {refusal.reference}</span>}
              </div>
            </div>
          )}

          <div data-print="hide" className="flex flex-wrap gap-2">
            {/* Print: the document is checked at the bench. A print stylesheet hides the app chrome. */}
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer aria-hidden className="size-3.5" />
              Print
            </Button>
            <Button size="sm" variant="outline" disabled={stale} onClick={() => setEditing(true)}>
              <Pencil aria-hidden className="size-3.5" />
              Edit this protocol
            </Button>
            <Button size="sm" variant="outline" onClick={() => void askToRevise(view.revision)}>
              <MessageSquarePlus aria-hidden className="size-3.5" />
              Ask Claude to revise
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigate('/protocols')}>
              All protocols
            </Button>
          </div>
          {/* Editing an old revision would silently fork the document — the save would be refused
              as a conflict, which is the right answer but a confusing way to learn it. */}
          {stale && (
            <p className="text-2xs text-ink-subtle">
              Editing is offered on the current revision only.
            </p>
          )}

          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-raised p-3">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="font-medium">
                Reason <span className="font-normal text-ink-subtle">(recorded with the move)</span>
              </span>
              <textarea
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                rows={2}
                placeholder="Why this design is moving state"
                className="resize-y rounded-lg border border-border-subtle bg-surface px-2.5 py-2 outline-none focus-ring"
              />
            </label>
            {/* Buttons only when the header loaded: a move sends the status it was made from, and guessing it would defeat the compare-and-set. */}
            {summary ? (
              <div className="flex flex-wrap gap-2">
                {moves.map((status) => (
                  <ConfirmDialog
                    key={status}
                    trigger={
                      <Button
                        size="xs"
                        variant={status === 'abandoned' ? 'outline-destructive' : 'outline'}
                        disabled={!statusReason.trim()}
                      >
                        Mark {status}
                      </Button>
                    }
                    title={`Move this design to ${status}?`}
                    description="The move is recorded against you with the reason you wrote. It does not change the document; earlier revisions stay readable."
                    confirmLabel={`Mark ${status}`}
                    variant={status === 'abandoned' ? 'destructive' : 'default'}
                    onConfirm={() => void moveStatus(status, view.revision, summary.status)}
                  />
                ))}
                {moves.length === 0 && (
                  <p className="text-2xs text-ink-subtle">
                    There is nothing this design can be moved to from {summary.status}.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-2xs text-ink-subtle">
                This design’s header did not load, so its current status is unknown — a sign-off
                made from an unknown status could silently overwrite somebody else’s. Reload before
                deciding.
              </p>
            )}

            {/* Sign-offs per revision: a new revision demotes an approved design to draft, so this is the only record of what was approved. */}
            {signOffs.length > 0 && (
              <ul className="flex flex-col gap-1 border-t border-border-subtle pt-2 text-2xs text-ink-subtle">
                {signOffs.map((event) => (
                  <li key={`${event.status}-${event.created_at}`}>
                    <span className="font-medium text-ink-muted">{event.status}</span> at revision{' '}
                    {event.revision} · {event.actor || 'unknown'} · {when(event.created_at)}
                    {event.reason && <span> — “{event.reason}”</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </header>

        <Section title="Checks">
          <ChecksStrip checks={view.checks} kind={view.kind} />
        </Section>

        <Section title="What was asked for">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <RequestValue label="Scale" field={design.request.scale} />
            <RequestValue label="Plate format" field={design.request.plate_format} />
            <RequestValue label="Max runs" field={design.request.max_runs} />
            <RequestValue label="Deadline" field={design.request.deadline} />
          </dl>

          {design.request.objectives.length > 0 && (
            <p className="text-sm">
              <span className="text-ink-subtle">Objectives: </span>
              {design.request.objectives.join(', ')}
            </p>
          )}
          {design.request.forbidden.length > 0 && (
            <p className="text-sm">
              <span className="text-ink-subtle">Ruled out: </span>
              {design.request.forbidden.join(', ')}
            </p>
          )}
          {design.request.prior_work && (
            <p className="text-sm text-ink-muted">{design.request.prior_work}</p>
          )}

          {design.request.components.length > 0 && (
            <Grid
              label="The species as the chemist named them"
              headers={['As written', 'Structure', 'Role', 'Resolved by']}
            >
              {design.request.components.map((component, index) => (
                <tr key={`${component.name_as_written}-${index}`}>
                  <td className="px-2.5 py-1.5">{component.name_as_written}</td>
                  <td className="px-2.5 py-1.5">
                    {component.smiles ? (
                      <Molecule smiles={component.smiles} maxWidth={132} />
                    ) : (
                      // Never blank: a species that did not resolve is a species the design is
                      // silently missing, and an empty cell reads as "no structure needed".
                      <span className="text-2xs text-danger-ink">not resolved to a structure</span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5">{component.role}</td>
                  <td className="px-2.5 py-1.5 text-2xs text-ink-muted">{component.resolution}</td>
                </tr>
              ))}
            </Grid>
          )}
        </Section>

        <Section title="Conditions">
          <Conditions design={design} />
          {design.arms.some(
            (arm) =>
              JSON.stringify(setpointsFor(design.base.setpoints, arm)) !==
              JSON.stringify(sharedSetpoints(design)),
          ) && (
            <p className="mt-2 text-2xs text-ink-subtle">
              The conditions every arm shares; the run sheet carries what varies.
            </p>
          )}
        </Section>

        {design.base.charge.length > 0 && (
          <Section title="Charge">
            <Grid
              label="The charge table"
              headers={[
                'Species',
                'Structure',
                'Role',
                'Equiv',
                'mmol',
                'Mass (mg)',
                'Volume (mL)',
                'Note',
              ]}
            >
              {design.base.charge.map((line, index) => (
                <tr key={`${line.component}-${index}`}>
                  <td className="px-2.5 py-1.5">
                    {line.component}
                    {line.limiting && (
                      <span className="ml-1.5 text-2xs text-brand-ink">limiting</span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5">
                    {line.smiles ? <Molecule smiles={line.smiles} maxWidth={120} /> : '—'}
                  </td>
                  <td className="px-2.5 py-1.5">{line.role}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                    {numeric(line.equivalents)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                    {numeric(line.amount_mmol)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                    {numeric(line.mass_mg)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                    {numeric(line.volume_ml)}
                  </td>
                  <td className="px-2.5 py-1.5 text-2xs text-ink-muted">{line.note}</td>
                </tr>
              ))}
            </Grid>
          </Section>
        )}

        {design.base.steps.length > 0 && (
          <Section title="Procedure">
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              {design.base.steps.map((step, index) => (
                <li key={`${step.index}-${index}`} className="text-sm">
                  <span className="mr-1.5 text-2xs text-ink-subtle uppercase">{step.kind}</span>
                  {step.text}
                  {(step.temperature_c !== null || step.duration_h !== null) && (
                    <span className="ml-1.5 font-mono text-2xs text-ink-subtle tabular-nums">
                      {step.temperature_c !== null && `${step.temperature_c} °C`}
                      {step.temperature_c !== null && step.duration_h !== null && ' · '}
                      {step.duration_h !== null && `${step.duration_h} h`}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        )}

        {design.factors.length > 0 && (
          <Section title="Factors">
            <Grid label="The factors this design varies" headers={['Factor', 'Kind', 'Levels']}>
              {design.factors.map((factor) => (
                <tr key={factor.name}>
                  <td className="px-2.5 py-1.5">{factor.name}</td>
                  <td className="px-2.5 py-1.5">
                    {factor.kind}
                    {factor.unit && ` (${factor.unit})`}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {factor.levels.map((level, index) => (
                        <Badge key={`${level.label}-${index}`} tone="neutral">
                          {level.label}
                          {level.value !== null && (
                            <span className="font-mono tabular-nums">
                              {level.value}
                              {level.unit || factor.unit}
                            </span>
                          )}
                        </Badge>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </Grid>
          </Section>
        )}

        {records.length > 0 && (
          <Section
            title="Run sheet"
            action={
              // The one table on this page that leaves the screen and goes to a bench. A run sheet
              // retyped into Excel is where the transcription error enters a campaign.
              <DownloadCsv headers={headers} records={records} name={`${designId}-run-sheet`} />
            }
          >
            <Grid label="Every arm, in run order" headers={headers}>
              {records.map((record, index) => (
                <tr key={index}>
                  {headers.map((header) => (
                    <td
                      key={header}
                      className={
                        typeof record[header] === 'number'
                          ? 'px-2.5 py-1.5 text-right font-mono tabular-nums'
                          : 'px-2.5 py-1.5'
                      }
                    >
                      {String(record[header] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </Grid>
          </Section>
        )}

        {design.layout && (
          <Section title="Plate">
            <PlateMap layout={design.layout} arms={design.arms} />
          </Section>
        )}

        {design.base.analytics.length > 0 && (
          <Section title="Analytics">
            <Grid
              label="How each arm is measured"
              headers={['Analytic', 'Timing', 'Method', 'Measures']}
            >
              {design.base.analytics.map((analytic, index) => (
                <tr key={`${analytic.name}-${index}`}>
                  <td className="px-2.5 py-1.5">{analytic.name}</td>
                  <td className="px-2.5 py-1.5">{analytic.timing}</td>
                  <td className="px-2.5 py-1.5">{analytic.method}</td>
                  <td className="px-2.5 py-1.5">{analytic.measures.join(', ')}</td>
                </tr>
              ))}
            </Grid>
          </Section>
        )}

        {design.base.in_process_controls.length > 0 && (
          <Section title="In-process controls">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {design.base.in_process_controls.map((control, index) => (
                <li key={index}>{control}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Hazards and waste">
          {design.base.hazards.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {design.base.hazards.map((hazard, index) => (
                <li
                  key={index}
                  className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
                >
                  {hazard}
                </li>
              ))}
            </ul>
          ) : (
            // The dangerous reading of an empty list, said out loud — the same rule the hazard
            // screen's caveat exists for. A protocol that lists no hazard has not been screened.
            <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink">
              No hazard is recorded on this design. That is <strong>not</strong> a screen returning
              nothing — it means nobody has written one here.
            </p>
          )}
          {design.base.waste && <p className="text-sm">Waste: {design.base.waste}</p>}
        </Section>

        <Section title="Expected outcome">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono tabular-nums">
              {design.base.expected.yield_percent === null
                ? '—'
                : `${design.base.expected.yield_percent}%`}
            </span>
            {/* The basis matters: a precedent yield and an assumed one look identical as a percentage. */}
            <Badge tone={design.base.expected.basis === 'precedent' ? 'ok' : 'warn'}>
              {design.base.expected.basis}
            </Badge>
            {design.base.expected.selectivity && <span>{design.base.expected.selectivity}</span>}
          </p>
          {design.base.expected.detail && (
            <p className="text-sm text-ink-muted">{design.base.expected.detail}</p>
          )}
        </Section>

        {design.evidence.length > 0 && (
          <Section title="What this rests on">
            <Evidence evidence={design.evidence} />
          </Section>
        )}

        <Section title="Revisions">
          <ul className="flex flex-col gap-2">
            {history.map((row) => (
              <li
                key={row.revision}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2"
              >
                <History aria-hidden className="size-3.5 text-ink-subtle" />
                <span className="text-sm font-medium">r{row.revision}</span>
                <Badge tone="neutral">{row.kind}</Badge>
                <Badge tone={row.author_kind === 'human' ? 'brand' : 'neutral'}>
                  {row.author_kind}
                </Badge>
                {row.blockers > 0 && (
                  <Badge tone="danger">
                    {row.blockers} blocker{row.blockers === 1 ? '' : 's'}
                  </Badge>
                )}
                <span className="min-w-0 flex-1 text-xs text-ink-muted">
                  {row.change_note || 'no change note'}
                </span>
                <span className="text-2xs text-ink-subtle">
                  {row.author} {when(row.created_at)}
                </span>
                <span className="flex gap-1.5">
                  {row.revision !== view.revision && (
                    <>
                      <Button size="xs" variant="ghost" onClick={() => setAt(row.revision)}>
                        Open
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void showDiff(row.revision, view.revision)}
                      >
                        <FileDiff aria-hidden className="size-3" />
                        Compare
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {diff && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex justify-end">
                <Button size="xs" variant="ghost" onClick={() => setDiff(null)}>
                  Close comparison
                </Button>
              </div>
              <RevisionDiff diff={diff} />
            </div>
          )}
        </Section>
      </div>

      {editing && (
        <ProtocolEditor
          // Keyed on the revision being edited, so a reload after a conflict remounts the form on
          // the new head rather than merging the new document into a stale draft.
          key={view.revision}
          designId={designId}
          revision={view}
          open={editing}
          onOpenChange={setEditing}
          onSaved={(written) => {
            setNotice(`Saved as revision ${written}.`);
            setAt(undefined);
            reload();
          }}
          onReload={() => {
            setEditing(false);
            setAt(undefined);
            reload();
          }}
        />
      )}
    </div>
  );
}
