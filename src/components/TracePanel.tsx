/**
 * The agent's work, as a rail rather than a list.
 *
 * The panel this replaces was an honest flat `<ol>`: five kinds of event at one visual weight,
 * every payload expanded in place, and no duration anywhere. Opening it to answer "what did it
 * actually do" meant reading all of it, and the two rows that most deserved to be found — a gate
 * refusal and a broken retriever — looked exactly like the three that did not.
 *
 * So each step is one line: a dot carrying its state, a label, its tool, an outcome, and how long
 * it took. What a step *returned* is one disclosure in, where the reader who came to check a
 * number will go and the reader who came to see the shape of the turn will not.
 *
 * ## Four states per tool row, and none of them may be guessed
 *
 * running, returned, failed, and — reachable only from a reloaded transcript — outcome not
 * recorded. The last exists because the service's stored transcript pairs calls with results by
 * `call_id` and returns `result: null` for a turn that died mid-call *or a result row that was
 * pruned*; rendering that as "running" inside a transcript that finished days ago would be false,
 * and rendering it as "failed" would name an outcome nobody reported.
 *
 * ## Durations are ours, and the rail says so by omission
 *
 * Nothing on the wire carries a tool duration, so `TraceEntry.at` and the `endedAt` the store
 * stamps when the ending arrives are the only clock available. That makes a *reloaded* transcript
 * durationless, which the rail renders as nothing at all rather than as zero.
 *
 * The disclosure is a Radix Collapsible so the trigger reports `aria-expanded` and `aria-controls`;
 * the trigger stays the ONLY button in the collapsed state, because the panel's tests select it by
 * role and a second collapsed control would make that selection ambiguous.
 */

import { memo, useState } from 'react';
import { ChevronRight, CircleX, ShieldAlert, Table2, Unplug } from 'lucide-react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { toolLabel } from '../lib/format.ts';
import { formatDuration, summarizeTurn } from '../state/turnActivity.ts';
import { JobFailureCard, JobResultCard } from './JobResultCard.tsx';
import { parsePlanItem } from './PlanItems.tsx';
import { ResultSheet } from './ResultSheet.tsx';
import { methodFor } from '../chem/provenance.ts';
import { smilesFromArguments } from '../chem/recognise.ts';
import { Molecule } from './Molecule.tsx';
import { ToolIcon } from '@/components/chem/toolIcons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc';

/**
 * `tabIndex={0}` is load-bearing, not decoration.
 *
 * The block scrolls horizontally, and a scrollable region that nothing inside it can focus is
 * unreachable by keyboard — the content past the right edge simply does not exist for anyone not
 * using a pointer.
 */
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
 * The control that lifts the 200-character ceiling on one row.
 *
 * Rendered only when the service stored the result — an empty `resultRef` means "not stored", and
 * the service guarantees that is its only meaning, so there is exactly one condition to check and
 * no state in which this button leads nowhere. It needs the session id, which is why the panel
 * takes one: the fetch route is session-scoped so the ownership check the turn already passed
 * covers the result too.
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
 * What method produced this row's numbers, and what its authors say it does not establish.
 *
 * Every caveat is the backend's own wording (`src/chem/provenance.ts`). A tool this frontend has
 * no sourced method for renders nothing at all — a confidently wrong method label would be worse
 * than the silence it replaces.
 */
function MethodBadge({ tool }: { tool: string }): React.JSX.Element | null {
  const method = methodFor(tool);
  if (!method) return null;
  return (
    <div className="mt-1.5">
      <Badge>{method.method}</Badge>
      {method.caveat && (
        <p className="mt-1 border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">
          {method.caveat}
        </p>
      )}
    </div>
  );
}

/**
 * The numbers this call returned, in full.
 *
 * From `tool_result.numbers`, never from the preview beside it — the preview is cut at an
 * arbitrary byte and this list is not, which is the entire reason the service sends both. It is
 * also what the figure marks in the answer above were checked against, so a reader who distrusts a
 * mark can see the evidence rather than take it on faith.
 */
function ReturnedNumbers({ numbers }: { numbers: number[] }): React.JSX.Element | null {
  if (numbers.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-2xs text-ink-subtle">
        {numbers.length} value{numbers.length === 1 ? '' : 's'} returned, untruncated
      </p>
      <Pre label="Values returned, untruncated">{numbers.join(', ')}</Pre>
    </div>
  );
}

/**
 * The structures a call was actually made on.
 *
 * **Only from `arguments`, and only when it parses as whole JSON.** That is the exact boundary the
 * service announces a call on, so a complete document is the normal case and a truncated one is
 * visibly not JSON. The preview beside it is cut at an arbitrary byte and is off limits: a SMILES
 * cut short very often stays valid as a smaller, different molecule, and nothing downstream can
 * catch that.
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

/**
 * One step: a dot in the gutter, a line, and optionally something to open.
 *
 * The gutter draws its own connector rather than the list drawing a border, so a row can sit at
 * any height and the line still joins the dots either side of it.
 */
function Step({
  tone,
  children,
  detail,
  detailLabel = 'details',
}: {
  tone: DotTone;
  children: React.ReactNode;
  /** What opens under the line. Omit for a step with nothing more to show. */
  detail?: React.ReactNode;
  detailLabel?: string;
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
          <details className="group/step mt-0.5">
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
 * What changed in this plan revision, rather than the plan again.
 *
 * The strip above the answer already renders the current plan; repeating all of it here on every
 * revision is what made the old panel's first rows pure duplication. What a reader wants from a
 * revision row is the delta, so that is what it says — and when there is no previous revision to
 * compare against, it says how many steps the plan opened with.
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
}: {
  entry: TraceEntry;
  /** The plan as the previous revision left it, so this row can state the delta. */
  previousPlan: string[] | null;
  sessionId: string | null;
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
      return (
        <Step
          tone={tone}
          detailLabel={call.result !== undefined ? 'what it returned' : 'what it was asked'}
          detail={
            <>
              <MethodBadge tool={call.tool} />
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
                  <ReturnedNumbers numbers={call.numbers ?? []} />
                  {call.resultRef && (
                    <FullResult sessionId={sessionId} tool={call.tool} resultRef={call.resultRef} />
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
              running ? (
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
        </Step>
      );
    }

    case 'tool_failed': {
      // A gate refusal is not a fault, and rendering it in the failure red says it is. The service
      // classifies it for exactly this reason: a correctly-gated turn read as a broken one is the
      // mistake its own live evaluation made before the field existed.
      const gated = entry.toolFailure?.reason === 'plan_gate';
      return (
        <Step tone={gated ? 'warn' : 'danger'}>
          <Line
            className={gated ? 'text-warn-ink' : 'text-danger-ink'}
            icon={
              gated ? (
                <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <CircleX aria-hidden className="size-3.5 shrink-0" />
              )
            }
            label={toolLabel(entry.toolFailure?.tool ?? 'tool')}
            mono={entry.toolFailure?.tool}
            badge={
              <Badge tone={gated ? 'warn' : 'danger'}>
                {gated ? 'needs plan approval' : 'failed'}
              </Badge>
            }
          />
          {entry.toolFailure?.message && (
            <p className={cn('mt-0.5 text-2xs', gated ? 'text-warn-ink' : 'text-danger-ink')}>
              {entry.toolFailure.message}
            </p>
          )}
        </Step>
      );
    }

    case 'evidence_source':
      return (
        <Step tone="danger">
          <Line
            icon={<Unplug aria-hidden className="size-3.5 shrink-0 text-danger-ink" />}
            label={
              <>
                Evidence source <span className="font-medium">{entry.evidenceSource?.source}</span>{' '}
                failed
              </>
            }
          />
          {/* The distinction the event exists for: a source that was asked and had nothing is not
              in this panel at all, so a row here always means the retriever raised. */}
          <p className="mt-0.5 text-2xs text-ink-muted">
            it contributed nothing, and that is a fault rather than an empty corpus
          </p>
        </Step>
      );

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
          {entry.job?.planStep && (
            <p className="mt-0.5 truncate text-2xs text-ink-muted">for “{entry.job.planStep}”</p>
          )}
        </Step>
      );

    case 'job_completed':
      return (
        <Step tone="ok">
          <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
            <JobResultCard jobId={entry.job?.jobId ?? ''} summary={entry.job?.summary} />
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

    case 'note_proposed':
      return (
        <Step tone="idle">
          <Line
            label="Proposed note for review"
            mono={entry.note?.noteId}
            badge={
              entry.note?.reference ? (
                <span className="font-mono text-2xs text-ink-subtle">({entry.note.reference})</span>
              ) : undefined
            }
          />
        </Step>
      );

    case 'handoff':
      // Both halves are rendered. Showing only the entry would leave the trace reading as though
      // the turn never came back, which is the misattribution the `agent` stamp exists to prevent.
      return entry.handoff?.to ? (
        <Step tone="idle">
          <Line
            label={
              <>
                Handed to <span className="font-medium">{entry.handoff.to}</span>
              </>
            }
            badge={
              entry.handoff.reason ? (
                <span className="text-2xs text-ink-subtle">— {entry.handoff.reason}</span>
              ) : undefined
            }
          />
        </Step>
      ) : (
        <Step tone="idle">
          <p className="text-2xs text-ink-subtle">Back to the main agent</p>
        </Step>
      );

    case 'question':
    case 'approval_request':
      // Rendered as interactive cards in the message body, not as inert trace lines.
      return null;

    default:
      return null;
  }
}

/**
 * Pair each step with the plan as the previous revision left it.
 *
 * A plain function outside the component rather than a fold inside the render: a plan row states
 * its *delta*, so it needs the revision before it, and carrying that in a variable through a
 * `.map()` during render is the mutation-after-render pattern the React compiler refuses — for
 * good reason, since it is only correct if the map runs once, in order, exactly as written.
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

/**
 * The summary the disclosure is labelled with.
 *
 * "Show the agent's work (6 steps)" said how much there was to read and nothing about whether it
 * was worth reading. This says what the work *was*, and — because a problem is the one thing a
 * reader would open the panel for — whether anything in it went wrong.
 */
export function summaryLabel(trace: readonly TraceEntry[], durationMs: number | null): string {
  const { steps, toolCalls, jobs, problems, held } = summarizeTurn(trace);
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? '' : 's'}`);
  if (problems > 0) parts.push(`${problems} problem${problems === 1 ? '' : 's'}`);
  // Named for what it is rather than folded into the failures: a call the plan gate refused is a
  // decision somebody made, and the reader's next move on it is approval, not debugging.
  if (held > 0) parts.push(`${held} held for approval`);
  if (durationMs !== null && durationMs > 0) parts.push(formatDuration(durationMs));
  return parts.join(' · ');
}

/**
 * Memoised on `trace` identity, which is the point: `appendTokens` spreads the message but leaves
 * the trace array alone, so during a stream this subtree would otherwise re-render once per
 * animation frame to produce exactly the same output.
 */
export const TracePanel = memo(function TracePanel({
  trace,
  /** Null for a transcript read back from the server, which has calls but nothing to fetch
   *  against — the rows still render, without the full-result control. */
  sessionId = null,
  /** How long the whole turn took, by our clock. Null for a rehydrated turn, which has none. */
  durationMs = null,
}: {
  trace: TraceEntry[];
  sessionId?: string | null;
  durationMs?: number | null;
}): React.JSX.Element | null {
  const shown = trace.filter((e) => e.kind !== 'question' && e.kind !== 'approval_request');
  if (shown.length === 0) return null;

  const rows = withPreviousPlan(shown);

  return (
    <Collapsible className="group/trace mt-3">
      <CollapsibleTrigger asChild>
        <Button variant="link" size="xs" className="-ml-2 px-2 no-underline hover:underline">
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-data-[state=open]/trace:rotate-90"
          />
          {/* The visible label is the summary — what the work WAS, rather than how much of it
              there is to read. The name is prefixed for anyone who meets this button without the
              answer above it: "6 steps · 2 tools" alone says nothing about what it opens. */}
          <span className="sr-only-live">The agent’s work: </span>
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
          <p className="text-2xs text-ink-muted">
            Every step the agent took, in order. Previews are truncated by the service; where the
            full result was stored, you can open it.
          </p>
          <ol className="mt-3 flex flex-col gap-2.5">
            {rows.map(({ entry, previousPlan }) => (
              <Row key={entry.id} entry={entry} previousPlan={previousPlan} sessionId={sessionId} />
            ))}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
