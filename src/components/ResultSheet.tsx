/**
 * One tool result, in full.
 *
 * `ToolResultEvent.preview` is 200 characters and the service says it will stay that way — "never
 * a whole evidence sweep streamed to a browser". So the event carries a content-addressed
 * reference and this panel pulls the one result a reader asked for, through
 * `GET /sessions/{id}/tool-results/{ref}`.
 *
 * What it no longer owns is the *rendering*. The renderers moved to `src/results/`, where the
 * result blocks in the answer read the same registry — so the card a chemist sees under the answer
 * and the panel they open from it are one component in two sizes, and cannot come to disagree
 * about what a payload says.
 *
 * This is now the second look rather than the only one: the whole result, the raw text underneath
 * it, the byte size, and the correlation id that joins it to the audit trail.
 */

import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { toolResultQuery } from '../api/queries.ts';
import type { StoredToolResult } from '../api/client.ts';
import { toolLabel } from '../lib/format.ts';
import { rendererFor, RawText, Verdict } from '../results/renderers.tsx';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { EmptyState, Loading } from '@/components/chem/Feedback';

function Body({
  result,
  onUsed,
}: {
  result: StoredToolResult;
  /** Called when a structure in here was put into the message — the sheet closes, because the
   *  message being edited is behind it. */
  onUsed: () => void;
}): React.JSX.Element {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    // Not JSON, and that is a shape the service explicitly allows. The text itself is the result.
    return <RawText text={result.text} compact={false} />;
  }

  const picked = rendererFor(result.tool, parsed);
  if (!picked) return <RawText text={result.text} compact={false} />;

  const { renderer, data } = picked;
  return (
    <>
      {/* Above the data it qualifies, always: an empty table reads as "nothing found" unless the
          service's own sentence says which of the three empties this is. */}
      <Verdict data={data} />
      <renderer.View data={data} tool={result.tool} compact={false} onUsed={onUsed} />
      {/* Only under a generic renderer, which drew what it recognised and may have left the rest
          behind. A typed one has already rendered every field it models, and putting the whole
          payload beside it gives the reader two copies of one result to reconcile. */}
      {renderer.generic && (
        <details className="group">
          <summary className="tap-target cursor-pointer list-none rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
            Everything the tool returned
          </summary>
          <div className="mt-1.5">
            <RawText text={result.text} compact={false} />
          </div>
        </details>
      )}
    </>
  );
}

export function ResultSheet({
  sessionId,
  resultRef,
  tool,
  open,
  onOpenChange,
}: {
  sessionId: string;
  resultRef: string;
  tool: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  // The same key `ResultBlock` reads, which is the point: a reader who opens the panel over a
  // block that has already fetched pays nothing, and one who opens it over a block that has not
  // gets the fetch the block would have made. That join used to be a `Map<string, Promise>` in
  // `client.ts` that held nothing once the answer arrived, so opening the panel refetched.
  //
  // Fetched only while the panel is open: this component stays mounted behind a closed sheet, and
  // reading every result of every turn is exactly what the ref/payload split exists to avoid.
  const {
    data: result,
    error,
    isPending,
  } = useApiQuery({ ...toolResultQuery(sessionId, resultRef, auth), enabled: open });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title={`${toolLabel(tool)} — full result`}
        className="w-[min(48rem,95vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <h2 className="font-medium">{toolLabel(tool)}</h2>
            <p className="font-mono text-2xs text-ink-subtle">{tool}</p>
          </div>

          {isPending && !error && <Loading>Reading the full result…</Loading>}

          {error && (
            <EmptyState title="That result could not be read">
              {error.message} Stored results are retained for a limited time, so an old turn’s
              result may no longer be there.
            </EmptyState>
          )}

          {result && (
            <>
              <Body result={result} onUsed={() => onOpenChange(false)} />
              {/* The join a GxP reviewer asks for, and the one a reference alone cannot make. */}
              <p className="border-t border-border-subtle pt-3 text-2xs text-ink-subtle">
                {result.byte_size.toLocaleString()} bytes · correlation{' '}
                <span className="font-mono">{result.correlation_id || 'not recorded'}</span>
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
