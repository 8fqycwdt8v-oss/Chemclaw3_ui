/**
 * The agent's work as a rail: one line per step — a state dot, label, tool, outcome and duration —
 * with what it returned one disclosure in.
 *
 * Tool rows have four states, none guessed: running, returned, failed, and (reloaded transcripts
 * only) outcome not recorded. Durations come from our own clock, so a reloaded transcript shows
 * none rather than zero.
 *
 * The disclosure is a Radix Collapsible; its trigger is the only button while collapsed (tests
 * select it by role).
 */

import { memo, useState } from 'react';
import { ChevronRight, CircleX, ShieldAlert, Table2, Unplug } from 'lucide-react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { toolLabel } from '../lib/format.ts';
import { formatDuration, summarizeTurn } from '../state/turnActivity.ts';
import { refusalCopy } from '../lib/refusals.ts';
import { JobFailureCard, JobResultCard } from './JobResultCard.tsx';
import { parsePlanItem } from './PlanItems.tsx';
import { ResultSheet } from './ResultSheet.tsx';
import { CutResultNotice } from './FullResultText.tsx';
import { methodFor } from '../chem/provenance.ts';
import { smilesFromArguments } from '../chem/recognise.ts';
import { Molecule } from './Molecule.tsx';
import { ToolIcon } from '@/components/chem/toolIcons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc';

/** `tabIndex={0}` makes the horizontally scrolling block reachable by keyboard. */
function Pre({ children, label }: { children: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={label}
      className="mt-1 overflow-x-auto rounded-md border border-border-subtle bg-surface-sunken p-2 font-mono text-2xs leading-relaxed focus-ring"
    >
      {children}
    </pre>
  );
}

/**
 * Lifts the 200-character preview on one row. Rendered only when the service stored the result
 * (non-empty `resultRef`); the fetch is session-scoped.
 */
function FullResult({
  sessionId,
  tool,
  resultRef,
}: {
  sessionId: string | null;
  tool: string;
  resultRef: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  // A rehydrated transcript has calls but no session to fetch against. Offering the control there
  // would be offering a 404.
  if (!sessionId) return null;
  return (
    <>
      <Button
        variant="link"
        size="xs"
        className="mt-1 -ml-2 px-2 no-underline hover:underline"
        onClick={() => setOpen(true)}
      >
        <Table2 aria-hidden className="size-3.5" />
        See the full result
      </Button>
      {open && (
        <ResultSheet
          sessionId={sessionId}
          resultRef={resultRef}
          tool={tool}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

/**
 * What the method's authors say it does not establish (wording from `src/chem/provenance.ts`). The
 * method name is on the row; this caveat stays in the disclosure. Unknown tools render nothing.
 */
function MethodCaveat({ tool }: { tool: string }): React.JSX.Element | null {
  const caveat = methodFor(tool)?.caveat;
  if (!caveat) return null;
  return <p className="mt-1.5 border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">{caveat}</p>;
}

/**
 * The numbers this call returned, in full (`tool_result.numbers`, never the truncated preview) —
 * the evidence the answer's figure marks were checked against.
 */
function ReturnedNumbers({
  numbers,
  values,
}: {
  numbers: number[];
  /** The same figures under the tool's own keys, when the result was structured. */
  values?: { label: string; value: number; unit: string }[];
}): React.JSX.Element | null {
  if (numbers.length === 0 && !values?.length) return null;
  // Named where the service named them, bare otherwise; never a guessed name.
  const named = values ?? [];
  const count = named.length || numbers.length;
  return (
    <div className="mt-1.5">
      <p className="text-2xs text-ink-subtle">
        {count} value{count === 1 ? '' : 's'} returned, untruncated
      </p>
      <Pre label="Values returned, untruncated">
        {named.length > 0
          ? named.map((v) => `${v.label} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join('\n')
          : numbers.join(', ')}
      </Pre>
    </div>
  );
}

/**
 * The structures a call was made on, only from `arguments` parsed as whole JSON. Never from the
 * preview: a truncated SMILES can still be a valid, different molecule.
 */
function CalledOn({ argumentsJson }: { argumentsJson: string }): React.JSX.Element | null {
  const structures = smilesFromArguments(argumentsJson);
  if (structures.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap items-start gap-2">
      {structures.map((smiles) => (
        <li
          key={smiles}
          className="rounded-md border border-border-subtle bg-surface-raised p-1"
          // The string is on the element as well as in the drawing: a reader checking a structure
          // wants to be able to copy the thing they are checking.
          title={smiles}
        >
          <Molecule smiles={smiles} maxWidth={150} />
        </li>
      ))}
    </ul>
  );
}

type DotTone = 'idle' | 'ok' | 'warn' | 'danger' | 'running';

const DOT_CLASS: Record<DotTone, string> = {
  idle: 'bg-border-strong',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  running: 'bg-brand animate-pulse',
};

/** One step: a gutter dot that draws its own connector, a line, and optionally a disclosure. */
function Step({
  tone,
  children,
  detail,
  detailLabel = 'details',
  open,
}: {
  tone: DotTone;
  children: React.ReactNode;
  /** What opens under the line. Omit for a step with nothing more to show. */
  detail?: React.ReactNode;
  detailLabel?: string;
  /**
   * Whether the disclosure starts open (set by "expand all"). A default, not controlled: rows are
   * re-keyed when expand-all is used, so the reader's own toggles survive other updates.
   */
  open?: boolean;
}): React.JSX.Element {
  return (
    <li className="grid grid-cols-[0.75rem_1fr] gap-x-3">
      <span aria-hidden className="relative flex justify-center">
        <span className="absolute -top-2 -bottom-2 w-px bg-border-subtle" />
        <span
          className={cn(
            'relative mt-1.5 size-2 rounded-full ring-3 ring-surface-sunken',
            DOT_CLASS[tone],
          )}
        />
      </span>
      <div className="min-w-0">
        {children}
        {detail && (
          <details className="group/step mt-0.5" open={open}>
            <summary className="tap-target inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
              <ChevronRight
                aria-hidden
                className="size-3 transition-transform group-open/step:rotate-90"
              />
              {detailLabel}
            </summary>
            <div className="mt-1">{detail}</div>
          </details>
        )}
      </div>
    </li>
  );
}

/** The one-line head of a step: label, identifier, outcome, and how long it took. */
function Line({
  icon,
  label,
  mono,
  badge,
  duration,
  className,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  mono?: string;
  badge?: React.ReactNode;
  duration?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm', className)}>
      {icon}
      <span className="font-medium">{label}</span>
      {mono && <span className="font-mono text-2xs text-ink-subtle">{mono}</span>}
      {badge}
      {duration && (
        <span className="ml-auto font-mono text-2xs tabular-nums text-ink-subtle">{duration}</span>
      )}
    </p>
  );
}

/** How long a step took, or nothing at all when we never saw it end. */
const durationOf = (at: number, endedAt: number | undefined): string | undefined =>
  typeof endedAt === 'number' && endedAt >= at ? formatDuration(endedAt - at) : undefined;

/**
 * What changed in this plan revision (the strip above shows the whole plan), or how many steps it
 * opened with.
 */
function planDelta(todos: string[], previous: string[] | null): string {
  const bare = (lines: string[]): string[] => lines.map((l) => parsePlanItem(l).text);
  const now = bare(todos);
  if (!previous) return `${now.length} step${now.length === 1 ? '' : 's'}`;
  const before = new Set(bare(previous));
  const after = new Set(now);
  const added = now.filter((t) => !before.has(t)).length;
  const removed = bare(previous).filter((t) => !after.has(t)).length;
  const doneNow = todos.filter((l) => parsePlanItem(l).status === 'done').length;
  const doneBefore = previous.filter((l) => parsePlanItem(l).status === 'done').length;
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} dropped`);
  if (doneNow > doneBefore) parts.push(`${doneNow - doneBefore} ticked off`);
  return parts.length > 0 ? parts.join(' · ') : 'no change to the steps';
}

function Row({
  entry,
  previousPlan,
  sessionId,
  plan,
  open,
}: {
  entry: TraceEntry;
  /** The plan as the previous revision left it, so this row can state the delta. */
  previousPlan: string[] | null;
  sessionId: string | null;
  /** The turn's current plan, so a job row can say WHICH step it was launched for. */
  plan: string[] | null;
  /** Whether this row's disclosure starts open — see `Step`. */
  open: boolean;
}): React.JSX.Element | null {
  switch (entry.kind) {
    case 'plan':
      return (
        <Step tone="idle">
          <Line
            label="Plan revised"
            badge={
              <span className="text-2xs text-ink-muted">
                {planDelta(entry.plan?.todos ?? [], previousPlan)}
              </span>
            }
          />
        </Step>
      );

    case 'tool_call': {
      const call = entry.toolCall;
      if (!call) return null;
      const running = call.result === undefined && !call.failed && !call.unresolved;
      const tone: DotTone = call.failed
        ? 'danger'
        : running
          ? 'running'
          : call.unresolved
            ? 'idle'
            : 'ok';
      const method = methodFor(call.tool);
      const structures = call.arguments ? smilesFromArguments(call.arguments) : [];
      return (
        <Step
          tone={tone}
          open={open}
          detailLabel={call.result !== undefined ? 'what it returned' : 'what it was asked'}
          detail={
            <>
              <MethodCaveat tool={call.tool} />
              {call.arguments && <CalledOn argumentsJson={call.arguments} />}
              {call.arguments && (
                <>
                  <p className="mt-1.5 text-2xs text-ink-subtle">arguments</p>
                  {/* Raw, truncated server-side — never parsed as JSON. */}
                  <Pre label={`Arguments to ${call.tool}`}>{call.arguments}</Pre>
                </>
              )}
              {call.result !== undefined && (
                <>
                  {/* Exactly the word, on its own node: the panel's tests match it. */}
                  <p className="mt-1.5 text-2xs text-ink-subtle">returned</p>
                  <Pre label={`Result preview from ${call.tool}`}>{call.result}</Pre>
                  <ReturnedNumbers numbers={call.numbers ?? []} values={call.values} />
                  {/* A cut result gets its own control, opening what the tool actually returned; only one control is offered. */}
                  {call.resultCut ? (
                    <CutResultNotice
                      className="mt-1"
                      sessionId={sessionId}
                      tool={call.tool}
                      resultRef={call.resultRef}
                    />
                  ) : (
                    call.resultRef && (
                      <FullResult
                        sessionId={sessionId}
                        tool={call.tool}
                        resultRef={call.resultRef}
                      />
                    )
                  )}
                </>
              )}
            </>
          }
        >
          <Line
            icon={<ToolIcon tool={call.tool} className="size-3.5 shrink-0 text-ink-subtle" />}
            label={toolLabel(call.tool)}
            mono={call.tool}
            badge={
              running && call.queue?.state === 'queued' ? (
                // Waiting for a compute slot (not running). The count is the broker's approximate
                // backlog, so "in queue", never a position; 0 shows no count.
                <span className="text-2xs text-ink-muted">
                  {call.queue.waiting === null || call.queue.waiting <= 0
                    ? 'queued…'
                    : `queued · ${call.queue.waiting} in queue`}
                </span>
              ) : running ? (
                // Not "we are hiding the result" but "the call has not come back".
                <span className="text-2xs text-ink-muted">running…</span>
              ) : call.unresolved ? (
                // Reached only by a reloaded transcript, and it says the one true thing rather
                // than picking whichever of running / returned / failed would look tidiest.
                <span className="text-2xs text-ink-muted">outcome not recorded</span>
              ) : undefined
            }
            duration={durationOf(entry.at, call.endedAt)}
          />
          {/* What the call was made on and which method answers it, on the line itself: the two questions a reader opens the panel with. */}
          {(structures.length > 0 || method) && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-muted">
              {structures.length > 0 && (
                <span className="truncate font-mono" title={structures.join(' · ')}>
                  {structures.join(' · ')}
                </span>
              )}
              {structures.length > 0 && method && <span aria-hidden>·</span>}
              {method && <span>{method.method}</span>}
            </p>
          )}
        </Step>
      );
    }

    case 'tool_failed': {
      // A deliberate refusal is not a fault: `refusalCopy` maps each of the five refusal kinds to
      // copy; `null` means an ordinary failure (red).
      const refusal = refusalCopy(entry.toolFailure?.reason);
      return (
        <Step tone={refusal ? 'warn' : 'danger'}>
          <Line
            className={refusal ? 'text-warn-ink' : 'text-danger-ink'}
            icon={
              refusal ? (
                <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <CircleX aria-hidden className="size-3.5 shrink-0" />
              )
            }
            label={toolLabel(entry.toolFailure?.tool ?? 'tool')}
            mono={entry.toolFailure?.tool}
            badge={
              <Badge tone={refusal ? 'warn' : 'danger'}>{refusal ? refusal.badge : 'failed'}</Badge>
            }
          />
          {/* Both the service's sentence (what was refused) and the remedy (what to do). */}
          {entry.toolFailure?.message && (
            <p className={cn('mt-0.5 text-2xs', refusal ? 'text-warn-ink' : 'text-danger-ink')}>
              {entry.toolFailure.message}
            </p>
          )}
          {refusal && <p className="mt-0.5 text-2xs text-ink-muted">{refusal.remedy}</p>}
        </Step>
      );
    }

    case 'evidence_source': {
      // One row for the whole evidence sweep: who was asked and what each contributed.
      const sources = entry.evidenceSweep ?? (entry.evidenceSource ? [entry.evidenceSource] : []);
      const down = sources.filter((s) => s.failed);
      return (
        <Step tone={down.length > 0 ? 'danger' : 'ok'}>
          <Line
            icon={
              down.length > 0 ? (
                <Unplug aria-hidden className="size-3.5 shrink-0 text-danger-ink" />
              ) : undefined
            }
            label="Evidence sweep"
            badge={
              <span className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-muted">
                {sources.map((source) => (
                  <span key={source.source} className={source.failed ? 'text-danger-ink' : ''}>
                    <span className="font-medium">{source.source}</span>{' '}
                    {/* "failed" and "0" differ: a broken source vs a source with nothing. */}
                    {source.failed ? 'failed' : source.chunks}
                  </span>
                ))}
              </span>
            }
            duration={durationOf(entry.at, entry.evidenceSweepEndedAt)}
          />
          {down.length > 0 && (
            <p className="mt-0.5 text-2xs text-ink-muted">
              {down.length === 1 ? 'That source' : 'Those sources'} contributed nothing, and that is
              a fault rather than an empty corpus.
            </p>
          )}
        </Step>
      );
    }

    case 'job_started':
      return (
        <Step tone={entry.job?.settled ? 'idle' : 'running'}>
          <Line
            label={
              <>
                Started <span className="font-medium">{entry.job?.kind ?? 'job'}</span>
              </>
            }
            mono={entry.job?.jobId}
            // Dropped once an ending arrived. The badge is a claim about the present tense, and a
            // job that finished — either way — is not still running. The row below says which.
            badge={
              !entry.job?.settled ? <Badge tone="brand">runs asynchronously</Badge> : undefined
            }
            duration={durationOf(entry.at, entry.job?.endedAt)}
          />
          {entry.job?.planStep &&
            (() => {
              // The step number when the current plan still holds the step's text; otherwise the
              // text alone (the plan may have been revised).
              const index = (plan ?? []).findIndex(
                (line) => parsePlanItem(line).text === entry.job?.planStep,
              );
              return (
                <p className="mt-0.5 truncate text-2xs text-ink-muted">
                  {index >= 0 ? `for step ${index + 1} · ` : 'for '}
                  {entry.job.planStep}
                </p>
              );
            })()}
        </Step>
      );

    case 'job_completed':
      return (
        <Step tone="ok">
          <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
            <JobResultCard
              jobId={entry.job?.jobId ?? ''}
              summary={entry.job?.summary}
              sessionId={sessionId}
            />
          </div>
        </Step>
      );

    case 'job_failed':
      return (
        <Step tone="danger">
          <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
            <JobFailureCard
              jobId={entry.jobFailure?.jobId ?? ''}
              reason={entry.jobFailure?.reason ?? ''}
            />
          </div>
        </Step>
      );

    case 'handoff':
      // A handoff boundary: the prose after it comes from another agent; `reason` is the handing
      // model's own account.
      return (
        <Step tone="idle">
          <Line
            label={
              <>
                <span className="font-medium">{entry.handoff?.from || 'the agent'}</span> handed to{' '}
                <span className="font-medium">{entry.handoff?.to || 'another agent'}</span>
              </>
            }
            badge={
              entry.handoff?.reason ? (
                <span className="text-2xs text-ink-subtle">— {entry.handoff.reason}</span>
              ) : undefined
            }
          />
        </Step>
      );

    // The wire name is `note_proposed`, but nothing reviews notes: label it as recorded, not "for
    // review".
    case 'note_proposed':
      return (
        <Step tone="idle">
          <Line
            label="Recorded note"
            mono={entry.note?.noteId}
            badge={
              entry.note?.reference ? (
                <span className="font-mono text-2xs text-ink-subtle">({entry.note.reference})</span>
              ) : undefined
            }
          />
        </Step>
      );

    // An artefact is a card in the answer, under the result blocks — and the `create_exhibit` call
    // that produced it is already a row above this one, so a second row would say it twice.
    case 'question':
    case 'approval_request':
    case 'exhibit':
      // Rendered as interactive cards in the message body, not as inert trace lines.
      return null;

    default:
      return null;
  }
}

/**
 * Pair each row with the plan as it stood before it (plan rows show a delta), computed outside
 * render. Sweeps are already folded by the store.
 */
function withPreviousPlan(
  entries: readonly TraceEntry[],
): { entry: TraceEntry; previousPlan: string[] | null }[] {
  let seen: string[] | null = null;
  const out: { entry: TraceEntry; previousPlan: string[] | null }[] = [];
  for (const entry of entries) {
    out.push({ entry, previousPlan: seen });
    if (entry.kind === 'plan') seen = entry.plan?.todos ?? null;
  }
  return out;
}

/** The disclosure's label: what the work was, and whether anything went wrong. */
export function summaryLabel(trace: readonly TraceEntry[], durationMs: number | null): string {
  const { steps, toolCalls, jobs, problems, sourcesDown, held } = summarizeTurn(trace);
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? '' : 's'}`);
  if (durationMs !== null && durationMs > 0) parts.push(formatDuration(durationMs));
  // The panel header names the kind of trouble; the collapsed trigger carries the count so problems
  // are visible without opening.
  const trouble = problems + sourcesDown + held;
  if (trouble > 0) parts.push(`${trouble} to look at`);
  return parts.join(' · ');
}

/**
 * What went differently, named rather than totalled: a refusal wants an approval, a dead source the
 * index owner, a failure someone to look.
 */
export function troubleLabel(trace: readonly TraceEntry[]): string {
  const { problems, sourcesDown, held } = summarizeTurn(trace);
  const parts: string[] = [];
  if (problems > 0) parts.push(`${problems} failure${problems === 1 ? '' : 's'}`);
  if (held > 0) parts.push(`${held} refusal${held === 1 ? '' : 's'}`);
  if (sourcesDown > 0) parts.push(`${sourcesDown} source${sourcesDown === 1 ? '' : 's'} down`);
  return parts.join(' · ');
}

/** Memoised on `trace` identity: token appends leave the trace array unchanged. */
export const TracePanel = memo(function TracePanel({
  trace,
  /** Null for a transcript read back from the server, which has calls but nothing to fetch
   *  against — the rows still render, without the full-result control. */
  sessionId = null,
  /** The service's id for the turn this trace belongs to, rendered in the footer. Absent on a
   *  message from before the field existed, and on a service that sends none. */
  correlationId = '',
  /** How long the whole turn took, by our clock. Null for a rehydrated turn, which has none. */
  durationMs = null,
  /** The turn's plan, so a job row can name the step it was launched for by its number. */
  plan = null,
  /** The answer the turn produced, for the closing row. Absent when it produced none. */
  answer = null,
}: {
  trace: TraceEntry[];
  sessionId?: string | null;
  correlationId?: string;
  durationMs?: number | null;
  plan?: string[] | null;
  answer?: { words: number; duration?: string } | null;
}): React.JSX.Element | null {
  // One nonce per press of "expand all": the rows are re-keyed by it, so each re-mounts with the
  // new default and the reader's own toggling afterwards is left alone.
  const [expanded, setExpanded] = useState<{ all: boolean; nonce: number }>({
    all: false,
    nonce: 0,
  });
  const shown = trace.filter((e) => e.kind !== 'question' && e.kind !== 'approval_request');
  if (shown.length === 0) return null;

  const { steps, problems } = summarizeTurn(shown);
  // Trouble is named, not totalled (see `troubleLabel`).
  const trouble = troubleLabel(shown);

  const rows = withPreviousPlan(shown);

  return (
    <Collapsible className="group/trace mt-3">
      <CollapsibleTrigger asChild>
        <Button
          variant="link"
          size="xs"
          // Red only for a failure; a refusal or a dark source is not.
          className={cn(
            '-ml-2 px-2 no-underline hover:underline',
            problems > 0 && 'text-danger-ink',
          )}
        >
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-data-[state=open]/trace:rotate-90"
          />
          {/* The summary as the visible label, prefixed for readers who meet the button without the answer above it. */}
          <span className="sr-only-live">The agent’s work: </span>
          {/* The settled dot, so a clean turn reads as such at a glance. */}
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full', trouble ? 'bg-warn' : 'bg-ok')}
          />
          {summaryLabel(shown, durationMs)}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          'overflow-hidden',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      >
        <div className="mt-2 rounded-xl border border-border-subtle bg-surface-sunken p-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle pb-2">
            <span className="text-xs font-medium">
              {steps} step{steps === 1 ? '' : 's'}
            </span>
            {durationMs !== null && durationMs > 0 && (
              <span className="font-mono text-2xs tabular-nums text-ink-subtle">
                {formatDuration(durationMs)}
              </span>
            )}
            {trouble && <span className="text-2xs text-warn-ink">{trouble}</span>}
            <Button
              variant="link"
              size="xs"
              className="ml-auto px-0 no-underline hover:underline"
              onClick={() => setExpanded((e) => ({ all: !e.all, nonce: e.nonce + 1 }))}
            >
              {expanded.all ? 'Collapse all' : 'Expand all'}
            </Button>
          </div>
          <ol className="mt-2.5 flex flex-col gap-2.5">
            {rows.map(({ entry, previousPlan }) => (
              // Re-keyed by the nonce so "expand all" re-mounts each row with its new default and
              // then leaves the reader's own toggling alone — see `Step`.
              <Row
                key={`${entry.id}-${expanded.nonce}`}
                entry={entry}
                previousPlan={previousPlan}
                sessionId={sessionId}
                plan={plan}
                open={expanded.all}
              />
            ))}
            {/* The answer as the final step (the service does not announce it), in words. */}
            {answer && (
              <Step tone="ok">
                <Line
                  label="Answer written"
                  badge={
                    <span className="text-2xs text-ink-muted">
                      {answer.words} word{answer.words === 1 ? '' : 's'}
                    </span>
                  }
                  duration={answer.duration}
                />
              </Step>
            )}
          </ol>

          {/* The turn's reference, selectable, for joining to the service's logs — shown on successful turns too. */}
          {correlationId && (
            <p className="mt-3 border-t border-border-subtle pt-2 font-mono text-2xs text-ink-subtle">
              Reference {correlationId}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
