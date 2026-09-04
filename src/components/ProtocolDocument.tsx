/**
 * One experiment design, as the document it is.
 *
 * ## What this screen is for
 *
 * A protocol is the one artefact in this system that a chemist has to be able to *check line by
 * line* before anything is charged into a vessel, and the one they will then correct. So this is
 * laid out as a document — request, conditions, charge, procedure, factors, run sheet, plate,
 * analytics, hazards, expectation, evidence, history — rather than as a summary with disclosures.
 * A field that is one click away is a field nobody reads before ordering reagents.
 *
 * ## The basis chips are the whole honesty story
 *
 * `ExperimentRequest` carries, per field, whether the chemist **stated** it (with the words they
 * used), whether the agent **inferred** it, or whether it is **absent**. Those three render very
 * differently on purpose. A scale nobody stated is a vessel charge nobody agreed to, and an
 * inferred `plate_format` decides how many reactions get run; rendering an inference the same as an
 * instruction is how a guess becomes an order with nobody having decided anything. So `inferred` is
 * a warn-toned chip that says the word, `stated` carries the quote it was read from, and `absent`
 * says it is not stated rather than showing a blank.
 *
 * ## What it does not do
 *
 * It never composes a tool call from a click. "Ask Claude to revise" fills the composer with a
 * sentence naming this design and this revision, and a human presses Send — the line
 * `docs/chemistry-aware-frontend.md` §9 and `state/composerEvents.ts` both draw, and the reason a
 * one-tap "regenerate this protocol" button is not here.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileDiff, FlaskConical, History, MessageSquarePlus, Pencil } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { api, type ProtocolView } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
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
import { setpointsFor, sharedSetpoints } from '../../shared/protocols.ts';
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

const STATUSES: DesignStatus[] = ['requested', 'draft', 'approved', 'executed', 'abandoned'];

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
 * One request field, with where its value came from.
 *
 * `stated` puts the chemist's own words in a tooltip on a focusable trigger — a tooltip on a
 * `<span>` is unreachable from a keyboard, which for the one control that lets a reader *check* a
 * transcription would be the wrong half of the audience to lose.
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
          // **Most of these did not run.** At the request stage the service reports every
          // protocol-only check as a passing `note` reading "not checked yet — this design holds
          // only the ask", precisely so a UI would not look like it had skipped them. Rendering
          // that as "14 checks passed" turned the opposite claim into a green badge, on a design
          // with no charge table, no procedure and no evidence.
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
 * The conditions this design is run at — **what the arms agree on**, not what the body holds.
 *
 * This read `design.base.setpoints`, which is only what anybody runs while no arm overrides it. The
 * run sheet is the other half and carries a column only where the arms *disagree*, so a field every
 * arm overrode to the same value fell through both: three arms all set to `N2` over a body reading
 * `air` gave a page stating "Atmosphere: air", no atmosphere column, and the atmosphere the design
 * is actually run under stated nowhere. A field the arms disagree about comes back at its default
 * and shows as `—` here, because the run sheet is where it belongs.
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
 * The run-sheet columns that appear only when the arms disagree about them.
 *
 * The names, the membership and the order are the service's `render._RUN_SHEET_WHEN_VARYING`, and
 * this list existing at all is the point: all four used to ship on every sheet, which buries the
 * one column that varies among three constant ones on a 96-row plate. A column dropped here is not
 * a value lost — `Conditions` states what every arm shares.
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
    // **The fixed columns are display labels, and that is load-bearing rather than cosmetic.**
    // A factor name matches `^[a-z][a-z0-9_]*$`, so a solvent screen — the canonical HTE case —
    // declares a factor literally named `solvent`; with the fixed keys spelled the same way, the
    // later literal silently won the object and the level never reached the page or the CSV. Every
    // label here carries a capital, a space or a slash, so no factor name can collide with one.
    return {
      Arm: arm.arm_id,
      Well: well?.label ?? '',
      Run: well?.run_order ?? '',
      ...levels,
      // Temperature, time and solvent whether or not they vary — a chemist setting up a run reads
      // those three off the row in front of them. Then the four in `WHEN_VARYING`, in the service's
      // own order, dropped below if the arms agree about them.
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
  // **The four that appear only when the arms disagree about them**, which is the service's rule
  // and was not this one's: all four shipped on every sheet, so a 96-row plate buried the one
  // column that varies among three constant ones. What a constant column would have said is on the
  // page already — `Conditions` states what every arm shares — so the two are complements here as
  // they are there, and dropping one loses nothing.
  const constant = new Set<string>(
    WHEN_VARYING.filter((key) => new Set(records.map((row) => String(row[key]))).size <= 1),
  );
  const trimmed = records.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !constant.has(key))),
  );
  // A randomised design's whole point is that it is *run* in an order the plate does not show, so
  // the sheet is sorted by that order — as the service's own `run_sheet_rows` does, and as this
  // table's heading and aria-label both already claimed.
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
          {/* What this evidence is behind. Without it a reader can see that the design cites six
              things and not which numbers any of them stands behind, which is the question a
              reviewer is asking. */}
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

export function ProtocolDocument(): React.JSX.Element {
  const { designId = '' } = useParams();
  const { auth, ready } = useAuth();
  const navigate = useNavigate();

  /**
   * The read, carrying the request it answers.
   *
   * "Loading" is derived from that key rather than set on the way into the effect — the shape
   * `JobsPanel` uses, and here it is what stops a stale document being shown under a revision the
   * reader has just switched to. Clearing state in the effect body would be a second render and a
   * cascading-render lint error besides.
   */
  const [loaded, setLoaded] = useState<{
    key: string;
    view: ProtocolView | null;
    error: string | null;
  } | null>(null);
  /** The revision being read. `undefined` is the head, which is what a fresh open wants. */
  const [at, setAt] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [diff, setDiff] = useState<DesignDiff | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A refused sign-off, held apart from `notice` because the two are not the same kind of thing.
   *
   * `notice` is a `role="status"` neutral banner — "Status recorded as approved." — and a conflict
   * was being written into it, in the same tone, two lines after a success message. A chemist whose
   * decision was *not* recorded got the same visual as one whose was. This renders as
   * `ProtocolEditor`'s conflict block does: `role="alert"`, warn tone, and a reload action, because
   * the only safe next step is to read what the other person did.
   */
  const [conflict, setConflict] = useState<'revision' | 'status' | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const key = `${designId}|${at ?? 'head'}|${nonce}`;
  const current = loaded?.key === key ? loaded : null;
  const view = current?.view ?? null;
  const failed = current?.error ?? null;

  useEffect(() => {
    if (!ready || !designId) return;
    let cancelled = false;
    const asked = `${designId}|${at ?? 'head'}|${nonce}`;
    void api
      .getProtocol(designId, auth, at)
      .then((next) => !cancelled && setLoaded({ key: asked, view: next, error: null }))
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({
          key: asked,
          view: null,
          error: err instanceof Error ? err.message : 'Could not read that design.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [auth, ready, designId, at, nonce]);

  const showDiff = async (from: number, to: number): Promise<void> => {
    try {
      setDiff(await api.getProtocolDiff(designId, from, to, auth));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not read that comparison.');
    }
  };

  /**
   * Record a sign-off against the revision on screen — never against "whatever the head is".
   *
   * `atRevision` is passed in rather than read from a state variable because the service refuses a
   * move that names anything but the head, and the revision this reader is looking at is the only
   * honest answer: a colleague's save between opening the page and pressing the button now gives a
   * 409 and a banner, instead of the chemist's name on a document they never read.
   */
  const moveStatus = async (
    status: DesignStatus,
    atRevision: number,
    fromStatus: DesignStatus,
  ): Promise<void> => {
    setConflict(null);
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
      if (err instanceof ApiError && err.kind === 'status_conflict') {
        setNotice(null);
        setConflict('status');
        return;
      }
      if (err instanceof ApiError && err.kind === 'revision_conflict') {
        setNotice(null);
        setConflict('revision');
        return;
      }
      setNotice(err instanceof Error ? err.message : 'The status was not recorded.');
    }
  };

  /**
   * Hand the revision back to the agent as a sentence, in the composer, unsent.
   *
   * The navigation is not decoration: this screen has no composer — `AppShell` renders one only for
   * a conversation — so `prefill` dispatched from here would reach nobody. The conversation has to
   * exist and be mounted first, and the dispatch waits a task past the settled navigation because
   * the composer's listener is installed in the effect pass after the commit that `navigate`'s
   * promise resolves on. `prefill`, never `prefillAndSend`: turning a design into a request is the
   * chemist's sentence to finish and their Send to press.
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

  // Flat, because that is what the service sends: `revision` is a NUMBER and the revision's own
  // fields sit beside it. This used to destructure a `revision` object the service has never
  // returned, so `design` was `undefined` and the first field below threw — green in every stub in
  // this repository, because every stub emitted the invented shape too.
  const { design, history, summary, status_history: signOffs } = view;
  const head = history.reduce((best, row) => Math.max(best, row.revision), view.revision);
  const stale = view.revision !== head;
  const records = runSheetRecords(design);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
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

          {/* A reader looking at an old revision has to be told, or every number on this page is
              being read as current. The link out is what makes the notice actionable rather than
              merely true. */}
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

          {/* Two refusals, two sentences, because the remedy differs. A `revision` conflict means
              the document moved and the diff is worth reading; a `status` conflict means somebody
              already decided and the question is whether to override them. Both reload, because in
              both cases what is on this screen is out of date. */}
          {conflict && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
            >
              {conflict === 'status' ? (
                <p>
                  <strong>Somebody else already decided this.</strong> The design is no longer{' '}
                  {summary ? summary.status : 'the status shown here'}, so your move was not
                  recorded — recording it now would overwrite their decision without either of you
                  seeing the other. Reload to read what they did and why.
                </p>
              ) : (
                <p>
                  <strong>Somebody else edited this.</strong> Revision {view.revision} is no longer
                  the latest, so a sign-off made now would be attributed to a document that has
                  since moved. Nothing was recorded — reload and read the current revision first.
                </p>
              )}
              <div>
                <Button size="sm" variant="outline" onClick={reload}>
                  Reload the design
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
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
            {/* **The buttons are gated on the header, not given an optional status.** A move now
                states the status it was made from, and the only honest source for that is the badge
                this reader is looking at — `summary.status`. `DesignOut.summary` is nullable, so
                there is a real state in which this screen cannot say what it saw, and sending a
                guess would defeat the compare-and-set by making it always agree. Withholding the
                buttons says the true thing: the decision cannot be made from what loaded. */}
            {summary ? (
              <div className="flex flex-wrap gap-2">
                {STATUSES.map((status) => (
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
              </div>
            ) : (
              <p className="text-2xs text-ink-subtle">
                This design’s header did not load, so its current status is unknown — a sign-off
                made from an unknown status could silently overwrite somebody else’s. Reload before
                deciding.
              </p>
            )}

            {/* What the panel above promises. A move is recorded against the revision it was made
                on, and the badge cannot show that: a revision landing on an approved design
                demotes it back to `draft`, so the only place "the chemist approved revision 3"
                survives is here. Rendering it is also the only thing that makes the reason worth
                storing — a record nobody can read answers no question. */}
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
            {/* The basis is the load-bearing half: a precedent yield is a number from a record and
                an assumed one is somebody's expectation, and they read identically as a
                percentage. */}
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
