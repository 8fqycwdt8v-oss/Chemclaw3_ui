/**
 * The full text of a tool result the assistant was shown only part of.
 *
 * When a tool returns more than fits the model's context, the service cuts it head-and-tail before
 * the model reads it and keeps the full text for the chemist (`ToolResultEvent.result_cut`, core
 * decision `D-2026-09-27-a-cut-result-is-kept-for-the-chemist-not-the-model`). `result_ref` then
 * opens the full text through `GET /sessions/{id}/tool-results/{ref}`, and this is where it is read.
 *
 * Three rules, each a property rather than a style choice:
 *
 *  - **Text, never markup.** A tool result is untrusted output — a web page a connector fetched, a
 *    document's body, a log. It goes into a `<pre>` as a React text child, which the DOM escapes;
 *    it is not parsed as JSON into a renderer either, because the point of this view is to show
 *    exactly what the tool said, not this client's reading of it. `ResultSheet` is the typed view.
 *  - **Bounded on screen, whole on the way out.** The service keeps up to 1 MiB of full text.
 *    Laying out a megabyte of wrapped monospace in one `<pre>` costs seconds of main thread on a
 *    lab laptop, and a virtualised list would need fixed line heights that wrapped text does not
 *    have — plus a dependency — to show something a reader scrolls, not reads. So the first
 *    `SHOWN_CHARS` are drawn, the count of what is not is said out loud, and copy and download
 *    always carry the **whole** text. Find-in-page works on what is drawn, and the download is one
 *    click for the rest.
 *  - **A missing result says why it is missing.** A 404 is the route's one answer for unknown,
 *    swept by retention or not yours, and the only one of those a chemist can meet from a link this
 *    UI drew is the second — so that is what the copy says.
 */

import { useState } from 'react';
import { ClipboardCopy, Download, FileText } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { toolResultQuery } from '../api/queries.ts';
import { ApiError } from '../api/errors.ts';
import { toolLabel } from '../lib/format.ts';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/chem/Feedback';

/** How much of the text is drawn: 64 KiB of characters, a few thousand lines. See the header. */
export const SHOWN_CHARS = 64 * 1024;

/** The first `limit` characters, without splitting a surrogate pair at the edge. */
export function shownPart(text: string, limit = SHOWN_CHARS): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  // A high surrogate as the last kept unit would render as a replacement character.
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadText(text: string, name: string): void {
  // The same object-URL dance as `DownloadCsv`: attached, clicked, revoked a tick later.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function CopyText({ text }: { text: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = (): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setState('failed');
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        setState('copied');
        window.setTimeout(() => setState('idle'), 2_000);
      },
      () => setState('failed'),
    );
  };
  return (
    <>
      <Button variant="outline" size="xs" onClick={copy}>
        <ClipboardCopy aria-hidden className="size-3.5" />
        {state === 'copied' ? 'Copied' : 'Copy full text'}
      </Button>
      <span role="status" className="text-2xs text-ink-muted">
        {state === 'failed' ? 'This browser would not take it — download it instead.' : ''}
      </span>
    </>
  );
}

function FullTextBody({
  sessionId,
  resultRef,
  tool,
}: {
  sessionId: string;
  resultRef: string;
  tool: string;
}): React.JSX.Element {
  const { auth } = useAuth();
  // The same key `ResultBlock` and `ResultSheet` read, so a result already fetched costs nothing.
  const { data, error, isPending, refetch } = useApiQuery(
    toolResultQuery(sessionId, resultRef, auth),
  );

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <div role="alert" className="rounded-lg border border-border-subtle p-4 text-sm">
        {gone ? (
          <>
            <p className="font-medium">This full result is no longer available.</p>
            <p className="mt-1 text-ink-muted">
              Retention may have removed it. The shortened version the assistant read is still in
              the step’s preview.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium">The full result could not be read.</p>
            <p className="mt-1 text-ink-muted">{error.message}</p>
            <Button variant="outline" size="xs" className="mt-2" onClick={() => void refetch()}>
              Try again
            </Button>
          </>
        )}
      </div>
    );
  }

  if (isPending || !data) return <Loading>Reading the full result…</Loading>;

  const shown = shownPart(data.text);
  const hidden = data.text.length - shown.length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <CopyText text={data.text} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => downloadText(data.text, `${tool || 'tool'}-result.txt`)}
        >
          <Download aria-hidden className="size-3.5" />
          Download full text
        </Button>
        <span className="ml-auto text-2xs text-ink-subtle" data-testid="full-result-size">
          {formatBytes(data.byte_size)}
        </span>
      </div>
      {hidden > 0 && (
        <p className="text-2xs text-ink-muted">
          {`Showing the first ${shown.length.toLocaleString()} of ${data.text.length.toLocaleString()} characters. Copy or download for the whole text.`}
        </p>
      )}
      <pre
        tabIndex={0}
        role="region"
        aria-label={`Full text returned by ${tool}`}
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap focus-ring"
      >
        {shown}
      </pre>
      <p className="text-2xs text-ink-subtle">
        correlation <span className="font-mono">{data.correlation_id || 'not recorded'}</span>
      </p>
    </>
  );
}

/**
 * The notice and control on a step whose result the assistant read only part of.
 *
 * Rendered only with a session to fetch against and a ref to fetch: a cut with nothing stored has
 * nothing to open, and saying so on every such row would be a control that leads nowhere.
 */
export function CutResultNotice({
  sessionId,
  resultRef,
  tool,
  className,
}: {
  sessionId: string | null;
  resultRef: string | undefined;
  tool: string;
  className?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!sessionId || !resultRef) return null;
  return (
    <div className={className}>
      <Button
        variant="link"
        size="xs"
        className="-ml-2 h-auto px-2 py-0.5 text-left whitespace-normal no-underline hover:underline"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <FileText aria-hidden className="size-3.5 shrink-0" />
        Result was shortened for the assistant — open full result
      </Button>
      {open && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="right"
            title={`${toolLabel(tool)} — full text`}
            className="w-[min(56rem,95vw)]"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
              <div>
                <h2 className="font-medium">{toolLabel(tool)} — full text</h2>
                <p className="text-2xs text-ink-muted">
                  The assistant was shown a shortened version of this result. This is what the tool
                  returned, as plain text.
                </p>
              </div>
              <FullTextBody sessionId={sessionId} resultRef={resultRef} tool={tool} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
