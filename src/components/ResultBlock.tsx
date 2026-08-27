/**
 * A tool result, in the answer, as data.
 *
 * The service's strongest single capability was reaching the chemist through its narrowest
 * channel: `screen_hazards` returns a severity-sorted table of cited rules, and the browser showed
 * 200 characters of it behind two disclosures while the rest arrived as sentences the model wrote
 * *about* the table. For a hazard screen, an ICH limit or a Pareto front, the difference between
 * the data and a paraphrase of the data is the difference between a record and a recollection.
 *
 * So a result with something structured to show gets a block in the answer flow, at the same depth
 * as the sentence that refers to it. The sheet stays exactly where it was — it is the second look
 * now rather than the only one.
 *
 * ## What it costs, and why that is affordable
 *
 * The stream carries a 200-character preview and a content address, never the table, so a block is
 * one `GET /sessions/{id}/tool-results/{ref}`. Three things keep that honest:
 *
 *  - it is **lazy**: the fetch starts when the block scrolls into view, so a long transcript the
 *    reader never scrolls back through costs nothing;
 *  - it is **capped** by the caller, at a small number of blocks per turn;
 *  - the URL is **content-addressed** and immutable, so the browser and any cache in front of it
 *    can hold it forever.
 *
 * ## It renders only when there is something to render
 *
 * No renderer matched, or the payload is not JSON, and this draws nothing at all. A block exists to
 * put a *table* under the answer; a 4 KB blob of raw text there is noise, and the trace row below
 * already offers it to whoever wants it.
 */

import { useEffect, useRef, useState } from 'react';
import { Table2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { api, type StoredToolResult } from '../api/client.ts';
import { rendererFor, Verdict } from '../results/renderers.tsx';
import { methodFor } from '../chem/provenance.ts';
import { Badge } from '@/components/ui/badge';
import { ResultSheet } from './ResultSheet.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: StoredToolResult }
  | { status: 'failed' };

/**
 * Has this block been scrolled to?
 *
 * `true` immediately where `IntersectionObserver` is absent — an environment without one is a test
 * or a very old browser, and in both the honest failure is to fetch rather than to show nothing
 * for ever.
 */
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
  className,
}: {
  sessionId: string;
  tool: string;
  resultRef: string;
  className?: string;
}): React.JSX.Element | null {
  const { auth } = useAuth();
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = useVisible(ref);
  const [state, setState] = useState<State>({ status: 'idle' });
  const [sheet, setSheet] = useState(false);
  /** Which ref we have already asked for, so a re-render cannot ask twice. */
  const requested = useRef<string | null>(null);
  /** Whether this component is still mounted. See below for why it is not a cleanup flag. */
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  // The guard is a ref and the cancellation is mount-scoped, and both of those are the fix for the
  // same bug: written the obvious way — `state.status` in the dependency list, `cancelled` set in
  // the cleanup — the `setState({status:'loading'})` re-runs the effect, whose cleanup then
  // cancels the fetch its own previous run had just started. The request completes, the 200 comes
  // back, and the block renders nothing for ever.
  useEffect(() => {
    if (!visible || requested.current === resultRef) return;
    requested.current = resultRef;
    setState({ status: 'loading' });
    api
      .getToolResult(sessionId, resultRef, auth)
      .then((result) => {
        if (mounted.current) setState({ status: 'ready', result });
      })
      .catch(() => {
        // Quiet on purpose. Nothing asked for this fetch, so a banner over a speculative read
        // would report a failure the reader did not cause and cannot act on; the trace row below
        // still offers the same result, and says so properly when it cannot be read either.
        if (mounted.current) setState({ status: 'failed' });
      });
  }, [visible, sessionId, resultRef, auth]);

  // The anchor has to exist before the fetch, or nothing can become visible.
  if (state.status !== 'ready') {
    return <div ref={ref} aria-hidden className="h-px" />;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(state.result.text);
  } catch {
    return null;
  }
  const picked = rendererFor(tool, parsed);
  if (!picked) return null;

  const { renderer, data } = picked;
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
        {/* The method, at the altitude the number is read at. It used to be four disclosures down
            while the value it qualifies sat at depth zero; a chemist should never have to ask
            whether 4.76 came from a cited table or a semiempirical estimate. Nothing renders for a
            tool this repo has no sourced method for — a confidently wrong label is worse. */}
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
        {/* What the method does NOT establish, and only under a GENERIC renderer.
            A typed one pins the service's own qualifying sentence out of the payload — "nothing
            matching is not a clearance", "the index holds no searchable record" — which is both
            more specific than the manifest's caveat and, for the hazard screen, the same warning
            in different words. Two warnings saying one thing is how a reader learns to skip
            both. The caveat is below the data rather than above it for the same reason it is not
            in the header: these run to four lines. */}
        {renderer.generic && method?.caveat && (
          <p className="border-l-2 border-warn/40 pl-2 text-2xs text-ink-muted">{method.caveat}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle px-3 py-1.5">
        <Button
          variant="link"
          size="xs"
          className="-ml-2 px-2 no-underline hover:underline"
          onClick={() => setSheet(true)}
        >
          <Table2 aria-hidden className="size-3.5" />
          Open full result
        </Button>
        {/* The join a reviewer asks for, and the one a card without it cannot make. */}
        <span className="ml-auto font-mono text-2xs text-ink-subtle">
          {state.result.byte_size.toLocaleString()} B
        </span>
      </div>

      {sheet && (
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
