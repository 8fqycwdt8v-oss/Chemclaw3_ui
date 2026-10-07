/**
 * A tool result in the answer, as data, at the same depth as the sentence that refers to it (the
 * sheet is the second look).
 *
 * Costs one `GET /sessions/{id}/tool-results/{ref}` per block unless the result came inline; kept
 * affordable by fetching lazily on scroll, by the caller's per-turn cap, and by content-addressed
 * caching shared across readers (`contentAddressed` in `src/api/client.ts`). Renders nothing when
 * no renderer matches or the payload is not JSON.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Table2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { toolResultQuery } from '../api/queries.ts';
import { rendererFor, Verdict } from '../results/renderers.tsx';
import { methodFor } from '../chem/provenance.ts';
import { Badge } from '@/components/ui/badge';
import { ResultSheet } from './ResultSheet.tsx';
import { LazyPinResult as PinResult } from './exhibits/lazy.tsx';
import { CutResultNotice } from './FullResultText.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Whether this block has been scrolled to; `true` immediately without `IntersectionObserver`. */
function useVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      // A screen's worth of margin: the fetch starts just before the reader gets there, so the
      // table is drawn rather than appearing under them.
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

export function ResultBlock({
  sessionId,
  tool,
  resultRef,
  inline,
  cut = false,
  className,
}: {
  sessionId: string;
  tool: string;
  resultRef: string;
  /**
   * The result sent inline with the event, when small enough; then no fetch. Absent does not mean
   * no result.
   */
  inline?: string;
  /** The assistant read a cut of this result; the block (fetched by ref) is the full text. */
  cut?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = useVisible(ref);
  // Memoised because the effect below depends on it: rebuilt every render, its identity would
  // change every render, and the effect that skips the fetch would re-run for nothing.
  const preloaded = useMemo(
    () =>
      inline
        ? {
            // A `StoredToolResult` built from the inline text; its byte size is measured, the same
            // claim either way.
            tool,
            text: inline,
            byte_size: new TextEncoder().encode(inline).length,
            correlation_id: '',
          }
        : null,
    [inline, tool],
  );
  const [sheet, setSheet] = useState(false);

  /**
   * The stored result, fetched once visible, keyed so the trace panel citing the same ref shares
   * the read. Quiet on failure: nothing asked for this fetch, and the trace row still offers the
   * result.
   */
  const { data: fetched } = useApiQuery({
    ...toolResultQuery(sessionId, resultRef, auth),
    // Nothing to fetch when the service sent the result with the event, and nothing to fetch
    // before it is on screen — which is the whole design of the ref/payload split.
    enabled: !preloaded && visible,
  });

  const result = preloaded ?? fetched ?? null;

  /**
   * Parse and dispatch once per payload rather than on every trace mutation
   * (`tests/resultBlockParse.test.tsx`).
   */
  const picked = useMemo(() => {
    if (!result) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // Not JSON, which the service explicitly allows. A block exists to draw a table; the trace
      // row below already offers the raw text to whoever wants it.
      return null;
    }
    return rendererFor(tool, parsed);
  }, [result, tool]);

  // The anchor has to exist before the fetch, or nothing can become visible.
  if (!result) {
    return <div ref={ref} aria-hidden className="h-px" />;
  }

  const { renderer, data } = picked ?? {};
  if (!renderer || !data) return null;
  const method = methodFor(tool);
  const summary = renderer.summary?.(data) ?? null;

  return (
    <div
      ref={ref}
      // The renderer that drew it, so a test can assert the dispatch without matching markup.
      data-result-block={renderer.id}
      className={cn(
        'my-3 overflow-hidden rounded-xl border border-border-subtle bg-surface-raised',
        // A table or a grid of structures takes the card's full width; anything that reads like
        // prose stays on the prose measure, so the answer above and the block below line up.
        !renderer.wide && 'max-w-prose',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border-subtle bg-surface-sunken px-3 py-2">
        <h3 className="text-sm font-semibold">{renderer.title(tool)}</h3>
        <span className="font-mono text-2xs text-ink-subtle">{tool}</span>
        {/* The method beside the data; nothing for a tool without a sourced method. */}
        {method && <Badge>{method.method}</Badge>}
        {summary && (
          <Badge tone={summary.tone} className="ml-auto">
            {summary.text}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-2.5 p-3">
        <Verdict data={data} />
        <renderer.View data={data} tool={tool} compact onUsed={() => {}} />
        {/* The method's caveat, only under a generic renderer: typed renderers already show the service's own qualifying sentence. */}
        {renderer.generic && method?.caveat && (
          <p className="border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">{method.caveat}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle px-3 py-1.5">
        {/* Only with a stored ref; a result can arrive inline with none. */}
        {resultRef && (
          <Button
            variant="link"
            size="xs"
            className="-ml-2 px-2 no-underline hover:underline"
            onClick={() => setSheet(true)}
          >
            <Table2 aria-hidden className="size-3.5" />
            Open full result
          </Button>
        )}
        {/* Pin as an artefact; `PinResult` checks for a stored ref and artefacts being enabled. */}
        <PinResult sessionId={sessionId} resultRef={resultRef} tool={tool} />
        {/* The table above is what the tool returned; the assistant worked from less. Said on the
            card, because a figure here the answer never mentions is otherwise a puzzle. */}
        {cut && <CutResultNotice sessionId={sessionId} resultRef={resultRef} tool={tool} />}
        {/* The join a reviewer asks for, and the one a card without it cannot make. */}
        <span className="ml-auto font-mono text-2xs text-ink-subtle">
          {result.byte_size.toLocaleString()} B
        </span>
      </div>

      {sheet && resultRef && (
        <ResultSheet
          sessionId={sessionId}
          resultRef={resultRef}
          tool={tool}
          open={sheet}
          onOpenChange={setSheet}
        />
      )}
    </div>
  );
}
