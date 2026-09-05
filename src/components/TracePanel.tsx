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
import { refusalCopy } from '../lib/refusals.ts';
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
 * What the method its authors say it does NOT establish.
 *
 * The method's *name* is on the row itself — a chemist should never have to open anything to learn
 * whether a number came from a cited table or a semiempirical estimate. The caveat is two to four
 * lines and stays in here, because five of them stacked on the rail is the annotation clutter that
 * trains a reader to stop reading annotations.
 *
 * Every word is the backend's own (`src/chem/provenance.ts`). A tool this frontend has no sourced
 * method for renders nothing at all — a confidently wrong caveat would be worse than the silence.
 */
function MethodCaveat({ tool }: { tool: string }): React.JSX.Element | null {
  const caveat = methodFor(tool)?.caveat;
  if (!caveat) return null;
  return <p className="mt-1.5 border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">{caveat}</p>;
}

/**
 * The numbers this call returned, in full.
 *
 * From `tool_result.numbers`, never from the preview beside it — the preview is cut at an
 * arbitrary byte and this list is not, which is the entire reason the service sends both. It is
 * also what the figure marks in the answer above were checked against, so a reader who distrusts a
 * mark can see the evidence rather than take it on faith.
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
  // Named where the service could name them, bare where it could not. The bare form is not a
  // degradation to hide: a result that was not JSON has no names, and printing a guessed one would
  // be the invention both fields exist on opposite sides of.
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
  open,
}: {
  tone: DotTone;
  children: React.ReactNode;
  /** What opens under the line. Omit for a step with nothing more to show. */
  detail?: React.ReactNode;
  detailLabel?: string;
  /**
   * Whether the disclosure starts open — what "expand all" sets.
   *
   * A *default*, not a controlled value: the panel re-keys its rows when the control is used, so
   * this is applied at mount and the reader's own toggling afterwards is left alone. Holding every
   * row's open state in the parent would mean a click on one row re-rendering all of them, and a
   * reader who opened two rows losing both the next time anything above changed.
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
          {/* What the call was made ON and what method answers it, on the line rather than one
              disclosure in: "did it compute the pKa of the compound I meant" and "was that a
              cited table or an estimate" are the two questions a reader opens this panel with,
              and both were behind a caret. The drawings stay inside, where there is room. */}
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
      // A gate refusal is not a fault, and rendering it in the failure red says it is. The service
      // classifies it for exactly this reason: a correctly-gated turn read as a broken one is the
      // mistake its own live evaluation made before the field existed.
      //
      // Five kinds, not one. This asked `reason === 'plan_gate'` while the other four gates — a
      // dry run the reader themselves switched on, a role denial, a tool this agent never had, a
      // repeat the guard stopped — all fell through to the failure red, which told a chemist their
      // own dry run was a broken pod. `refusalCopy` is the one table; `null` from it still means
      // an ordinary failure.
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
          {/* The service's own sentence explains what the gate did; the remedy says what the
              reader does about it. Both, because neither is the other: "record_knowledge_note
              changes stored data and the plan has not been approved" does not tell a chemist to go
              and approve it, and a remedy alone would hide which call was refused. */}
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
      // One row for the whole sweep. `gather_evidence` asks every source at once and reports each
      // separately, so five sources arrive as five events — and the question a reader has is not
      // "did lexical answer" but "who was asked, and what did each contribute", which is one line.
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
                    {/* "failed" and "0" are different answers and the whole reason the event
                        carries a flag: a dark source is a question about the corpus, a broken one
                        is a page for whoever owns the index. */}
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
              // The step's position, when the plan still holds it: "for step 3 · Estimate the pKa"
              // is a reader's own index into the checklist above, where the bare text is a string
              // they have to go and find. The service stamps the text, not the number, because a
              // plan can be revised between the launch and the render — so a step that has since
              // been dropped says its text and no number rather than a number that has moved.
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

    // The wire name is `note_proposed` and the event is not a proposal: nothing reviews a note
    // since Chemclaw3's `D-2026-09-05-the-gate-follows-behaviour-not-knowledge`. It is readable by
    // everyone the moment it is written, so telling a chemist it is "for review" promises them a
    // reviewer who does not exist. The literal stays because it is the SSE contract; the label a
    // person reads is the half that was making the false claim.
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
 * Pair each row with the plan as the revision before it left it.
 *
 * A plain function outside the component rather than a fold inside the render: a plan row states
 * its *delta*, so it needs the revision before it, and carrying that in a variable through a
 * `.map()` during render is the mutation-after-render pattern the React compiler refuses — for
 * good reason, since it is only correct if the map runs once, in order, exactly as written.
 *
 * There is no sweep fold here. The store does it as the events arrive (`foldIntoSweep`), because a
 * row per source spends the trace's bounded budget on retrieval; by the time the rail sees a sweep
 * it is already one entry carrying every source's report.
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
  const { steps, toolCalls, jobs, problems, sourcesDown, held } = summarizeTurn(trace);
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? '' : 's'}`);
  if (durationMs !== null && durationMs > 0) parts.push(formatDuration(durationMs));
  // WHAT kind of trouble is named in the panel's own header, where there is room for the three
  // different next moves it implies. A count of it rides on the collapsed trigger anyway, because
  // a panel that has to be opened before a broken retriever is visible is exactly the depth
  // problem this surface exists to fix.
  const trouble = problems + sourcesDown + held;
  if (trouble > 0) parts.push(`${trouble} to look at`);
  return parts.join(' · ');
}

/**
 * What went differently, named rather than totalled.
 *
 * Three kinds, and they are three because the reader's next move differs for each: a refusal wants
 * an approval, a dead source wants whoever owns the index, a failure wants somebody to look at the
 * turn. Rolling them into "3 problems" reports a correctly-gated turn as a broken one.
 */
export function troubleLabel(trace: readonly TraceEntry[]): string {
  const { problems, sourcesDown, held } = summarizeTurn(trace);
  const parts: string[] = [];
  if (problems > 0) parts.push(`${problems} failure${problems === 1 ? '' : 's'}`);
  if (held > 0) parts.push(`${held} refusal${held === 1 ? '' : 's'}`);
  if (sourcesDown > 0) parts.push(`${sourcesDown} source${sourcesDown === 1 ? '' : 's'} down`);
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
  // A turn where tools failed used to read exactly like one where they did not, and the fix for
  // that was a `, N failed` suffix on the step count. `troubleLabel` is that same argument carried
  // further: a refusal wants an approval, a dead source wants whoever owns the index, and a
  // failure wants somebody to look at the turn, so the three are named rather than totalled.
  const trouble = troubleLabel(shown);

  const rows = withPreviousPlan(shown);

  return (
    <Collapsible className="group/trace mt-3">
      <CollapsibleTrigger asChild>
        <Button
          variant="link"
          size="xs"
          // Tinted on a *failure* only, not on any trouble: a plan-gate refusal is the gate doing
          // its job and a dark source is a question about the corpus, and colouring the control red
          // for either teaches a reader that the red means nothing.
          className={cn(
            '-ml-2 px-2 no-underline hover:underline',
            problems > 0 && 'text-danger-ink',
          )}
        >
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-data-[state=open]/trace:rotate-90"
          />
          {/* The visible label is the summary — what the work WAS, rather than how much of it
              there is to read. The name is prefixed for anyone who meets this button without the
              answer above it: "6 steps · 2 tools" alone says nothing about what it opens. */}
          <span className="sr-only-live">The agent’s work: </span>
          {/* The same dot the live row carried, in its settled colour: the trigger is where that
              row ends up, and a turn that went cleanly should be readable as such without the
              sentence being parsed. */}
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
            {/* The answer itself is a step of the turn and the only one the service does not
                announce: without it the rail stops at the last tool call, and the reader cannot see
                that most of the wait was the model writing. Words, never tokens — nothing here
                knows how the service tokenised anything. */}
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

          {/* The reference a support conversation is built on, where the reader can select it.
              Every line the service logged for this turn carries the same string, so this is what
              turns "it went wrong at 14:32" into one query — including on a turn that SUCCEEDED,
              which is the case that had no reference of any kind. */}
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
