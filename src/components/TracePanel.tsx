/**
 * The "show your work" panel.
 *
 * An honesty constraint used to drive the wording here: the backend emitted tool *invocations*
 * only, so the panel said what the agent called and never implied it was showing what came back.
 * `tool_result` (backend D-159) is what lifts that, and the caveat goes with it — a panel that
 * disclaims showing results while showing them is worse than either version.
 *
 * A call is also announced when it is *issued* now, so an entry with no result yet is a call still
 * running rather than one whose result was withheld. Four states per row: running, returned,
 * failed, and — reachable only from a reloaded transcript — outcome-not-recorded.
 *
 * `arguments` and `result` are raw strings the backend truncates, so both are
 * displayed as-is rather than parsed as JSON. No width is quoted here: the live stream truncates
 * at `agent_audit_max_arg_chars` (200) and the stored transcript at its own, wider bound (400), so
 * a reloaded row is legitimately longer than the same row was live. The truncation is no longer
 * the end of it either: a row
 * whose result was stored carries a ref, and `ResultSheet` fetches and renders the whole thing.
 * The preview stays in place regardless — it is what makes the row scannable — and the control
 * below it is what makes the row's numbers checkable.
 *
 * Each call also carries the structures it was made on, drawn from its `arguments` document, and
 * the method behind it — GFN2-xTB, CREST, a cited table, a surrogate — and, one disclosure in, the
 * caveat its own manifest attaches to it. A chemist should never have to ask
 * which of those produced a number, and that text is written by the people who wrote the method and
 * currently reaches nobody.
 *
 * The disclosure is a Radix Collapsible so the trigger actually reports `aria-expanded` and
 * `aria-controls`; the hand-rolled toggle it replaces announced nothing about what it controlled.
 * The trigger stays the ONLY button in the collapsed state — the panel's tests select it by role,
 * and a second collapsed control would make that selection ambiguous.
 */

import { memo, useState } from 'react';
import { ChevronRight, CircleX, ShieldAlert, Table2, Unplug } from 'lucide-react';
import type { TraceEntry } from '../state/types.ts';
import { cn } from '../lib/cn.ts';
import { toolLabel } from '../lib/format.ts';
import { JobFailureCard, JobResultCard } from './JobResultCard.tsx';
import { PlanItems } from './PlanItems.tsx';
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
 * using a pointer. It went unnoticed for as long as the previews here were short enough not to
 * overflow; a real 200-character tool result is not.
 */
function Pre({
  children,
  label,
}: {
  children: React.ReactNode;
  /** Names the region for a screen reader, which a focusable role="region" requires. */
  label: string;
}): React.JSX.Element {
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
 * no state in which this button leads nowhere.
 *
 * It needs the session id, which is why `TracePanel` takes one: the fetch route is session-scoped
 * so that the ownership check the turn already passed covers the result too.
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
 * The badge is always visible once the panel is open, because "which method" is the question a
 * chemist should never have to ask of a computed value; the caveat is one disclosure further in,
 * because these are two to four lines each and five of them stacked is the annotation clutter that
 * trains people to stop reading.
 *
 * Every caveat is the backend's own wording (see `src/chem/provenance.ts`). A tool this frontend
 * has no sourced method for renders nothing at all — a confidently wrong method label would be
 * worse than the silence it replaces.
 */
function MethodBadge({ tool }: { tool: string }): React.JSX.Element | null {
  const method = methodFor(tool);
  if (!method) return null;
  return (
    <div className="mt-1.5">
      <Badge>{method.method}</Badge>
      {method.caveat && (
        <details className="group/caveat mt-1">
          <summary className="tap-target inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
            <ChevronRight
              aria-hidden
              className="size-3 transition-transform group-open/caveat:rotate-90"
            />
            what it does not say
          </summary>
          <p className="mt-1 border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">
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
 * arbitrary byte and this list is not, which is the entire reason the service sends both. It is
 * also what the figure marks in the answer above were checked against, so a reader who distrusts a
 * mark can see the evidence rather than take it on faith.
 */
function ReturnedNumbers({ numbers }: { numbers: number[] }): React.JSX.Element | null {
  if (numbers.length === 0) return null;
  return (
    <details className="group/values mt-1">
      <summary className="tap-target inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform group-open/values:rotate-90"
        />
        {numbers.length} value{numbers.length === 1 ? '' : 's'} returned (untruncated)
      </summary>
      <Pre label="Values returned, untruncated">{numbers.join(', ')}</Pre>
    </details>
  );
}

/**
 * The structures a call was actually made on.
 *
 * `smilesFromArguments` has been written, tested and proven safe on this exact source since the
 * entity store was built — and the entity store was its only caller, while this panel rendered the
 * same argument document as raw text behind a disclosure. So "did it compute the pKa of the
 * compound I meant" was answered by reading a SMILES string, which is the question US-1 asks and
 * the one a drawing answers at a glance.
 *
 * **Only from `arguments`, and only when it parses as whole JSON.** That is the exact boundary the
 * service announces a call on, so a complete document is the normal case and a truncated one is
 * visibly not JSON. The preview beside it is cut at an arbitrary byte and is off limits: a SMILES
 * cut short very often stays valid as a smaller, different molecule, and nothing downstream can
 * catch that.
 *
 * Drawn unconditionally rather than behind `drawStructures`. That preference governs answer prose,
 * where a chemist is reading; this panel is only open because someone came to check the work, and
 * the check is the picture.
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

function Row({
  entry,
  sessionId,
}: {
  entry: TraceEntry;
  sessionId: string | null;
}): React.JSX.Element | null {
  switch (entry.kind) {
    case 'plan':
      return (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-muted">Plan revised</p>
          <PlanItems todos={entry.plan?.todos ?? []} />
        </div>
      );

    case 'tool_call': {
      const running =
        entry.toolCall?.result === undefined &&
        !entry.toolCall?.failed &&
        !entry.toolCall?.unresolved;
      return (
        <div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <ToolIcon tool={entry.toolCall?.tool} className="size-3.5 shrink-0 text-ink-subtle" />
            <span className="font-medium">{toolLabel(entry.toolCall?.tool ?? 'tool')}</span>
            <span className="font-mono text-2xs text-ink-subtle">{entry.toolCall?.tool}</span>
          </p>
          {entry.toolCall?.tool && <MethodBadge tool={entry.toolCall.tool} />}
          {entry.toolCall?.arguments && <CalledOn argumentsJson={entry.toolCall.arguments} />}
          {entry.toolCall?.arguments && (
            <details className="group mt-1">
              <summary className="tap-target inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
                <ChevronRight
                  aria-hidden
                  className="size-3 transition-transform group-open:rotate-90"
                />
                arguments
              </summary>
              {/* Raw, truncated server-side — never parsed as JSON. */}
              <Pre label={`Arguments to ${entry.toolCall.tool}`}>{entry.toolCall.arguments}</Pre>
            </details>
          )}
          {entry.toolCall?.result !== undefined && (
            <div className="mt-1.5">
              {/* Exactly the word, on its own node: the panel's header sentence also contains it,
                  and the test that proves results render matches this exactly. */}
              <p className="text-2xs text-ink-muted">returned</p>
              <Pre label={`Result preview from ${entry.toolCall.tool}`}>
                {entry.toolCall.result}
              </Pre>
              <ReturnedNumbers numbers={entry.toolCall.numbers ?? []} />
              {entry.toolCall.resultRef && (
                <FullResult
                  sessionId={sessionId}
                  tool={entry.toolCall.tool}
                  resultRef={entry.toolCall.resultRef}
                />
              )}
            </div>
          )}
          {/* Still open: not "we are hiding the result" but "the call has not come back". The
              row that follows says which of the two endings arrived. */}
          {running && (
            <p className="mt-1 flex items-center gap-1.5 text-2xs text-ink-muted">
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-brand" />
              running…
            </p>
          )}
          {/* Reached only by a reloaded transcript, and it says the one true thing rather than
              picking whichever of running / returned / failed would look tidiest. */}
          {entry.toolCall?.unresolved && (
            <p className="mt-1 text-2xs text-ink-muted">outcome not recorded</p>
          )}
        </div>
      );
    }

    case 'tool_failed': {
      // A gate refusal is not a fault, and rendering it in the failure red says it is. The service
      // classifies it for exactly this reason: a correctly-gated turn read as a broken one is the
      // mistake its own live evaluation made before the field existed.
      const gated = entry.toolFailure?.reason === 'plan_gate';
      return (
        <div
          className={
            gated
              ? 'rounded-md border border-warn/40 bg-warn-soft px-3 py-2'
              : 'rounded-md border border-danger/40 bg-danger-soft px-3 py-2'
          }
        >
          <p
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${
              gated ? 'text-warn-ink' : 'text-danger-ink'
            }`}
          >
            {gated ? (
              <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <CircleX aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="font-medium">{toolLabel(entry.toolFailure?.tool ?? 'tool')}</span>
            <span className="font-mono text-2xs">{entry.toolFailure?.tool}</span>
            <span className="text-2xs">{gated ? 'needs plan approval' : 'failed'}</span>
          </p>
          {entry.toolFailure?.message && (
            <p className={`mt-1 text-2xs ${gated ? 'text-warn-ink' : 'text-danger-ink'}`}>
              {entry.toolFailure.message}
            </p>
          )}
        </div>
      );
    }

    case 'evidence_source':
      return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Unplug aria-hidden className="size-3.5 shrink-0 text-warn-ink" />
          <span>
            Evidence source <span className="font-medium">{entry.evidenceSource?.source}</span>{' '}
            failed
          </span>
          {/* The distinction the event exists for: a source that was asked and had nothing is not
              in this panel at all, so a row here always means the retriever raised. Said in words
              rather than left to the icon, because "no results" and "no answer" are the two
              readings a chemist has to be able to tell apart. */}
          <span className="text-2xs text-ink-muted">
            it contributed nothing, and that is a fault rather than an empty corpus
          </span>
        </p>
      );

    case 'job_started':
      return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>
            Started <span className="font-medium">{entry.job?.kind ?? 'job'}</span>
          </span>
          <span className="font-mono text-2xs text-ink-subtle">{entry.job?.jobId}</span>
          {/* Dropped once an ending arrived. The badge is a claim about the present tense, and a
              job that finished — either way — is not still running. The row below says which. */}
          {!entry.job?.settled && <Badge tone="brand">runs asynchronously</Badge>}
        </p>
      );

    case 'job_completed':
      return (
        <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
          <JobResultCard jobId={entry.job?.jobId ?? ''} summary={entry.job?.summary} />
        </div>
      );

    case 'job_failed':
      return (
        <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
          <JobFailureCard
            jobId={entry.jobFailure?.jobId ?? ''}
            reason={entry.jobFailure?.reason ?? ''}
          />
        </div>
      );

    case 'note_proposed':
      return (
        <p className="text-sm">
          Proposed note <span className="font-mono text-2xs">{entry.note?.noteId}</span> for review
          {entry.note?.reference && (
            <span className="ml-1 font-mono text-2xs text-ink-subtle">
              ({entry.note.reference})
            </span>
          )}
        </p>
      );

    case 'handoff':
      // Both halves are rendered. Showing only the entry would leave the trace reading as though
      // the turn never came back, which is the misattribution the `agent` stamp exists to prevent.
      return entry.handoff?.to ? (
        <p className="text-sm">
          Handed to <span className="font-medium">{entry.handoff.to}</span>
          {entry.handoff.reason && (
            <span className="ml-1 text-2xs text-ink-subtle">— {entry.handoff.reason}</span>
          )}
        </p>
      ) : (
        <p className="text-2xs text-ink-subtle">Back to the main agent</p>
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
 * Memoised on `trace` identity, which is the point: `appendTokens` spreads the message but leaves
 * the trace array alone, so during a stream this subtree would otherwise re-render once per
 * animation frame to produce exactly the same output. The finished bubbles above are already
 * covered by `memo(Bubble)`; this is what covers the one that is still streaming.
 */
export const TracePanel = memo(function TracePanel({
  trace,
  /** Null for a transcript read back from the server, which has calls but nothing to fetch
   *  against — the rows still render, without the full-result control. */
  sessionId = null,
}: {
  trace: TraceEntry[];
  sessionId?: string | null;
}): React.JSX.Element | null {
  const shown = trace.filter((e) => e.kind !== 'question' && e.kind !== 'approval_request');
  if (shown.length === 0) return null;

  return (
    <Collapsible className="group/trace mt-3">
      <CollapsibleTrigger asChild>
        <Button variant="link" size="xs" className="-ml-2 px-2 no-underline hover:underline">
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-data-[state=open]/trace:rotate-90"
          />
          Show the agent’s work ({shown.length} step
          {shown.length === 1 ? '' : 's'})
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          'overflow-hidden',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      >
        <div className="mt-2 rounded-lg border border-border-subtle bg-surface-sunken p-3">
          <p className="text-2xs text-ink-muted">
            Tool calls the agent made, each with what it returned. Previews are truncated by the
            service; where the full result was stored, you can open it.
          </p>
          {/* A left rail turns a list of events into a sequence you can follow down. */}
          <ol className="mt-3 space-y-3 border-l border-border-subtle pl-4">
            {shown.map((entry) => (
              <li key={entry.id} className="relative">
                <span
                  aria-hidden
                  className="absolute top-1.5 -left-[1.3125rem] size-1.5 rounded-full bg-border-strong ring-3 ring-surface-sunken"
                />
                <Row entry={entry} sessionId={sessionId} />
              </li>
            ))}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
