/**
 * An `html` artefact (wave 3): agent-written HTML, run only in the sandbox origin's frame.
 *
 * Lazy (`ExhibitPane` imports it with `React.lazy`), because almost no conversation holds one.
 *
 * ## Two walls, and the fallback when there is only one
 *
 * The frame is `sandbox="allow-scripts"` and nothing else — no `allow-same-origin`, so its document
 * has an opaque origin and cannot read this app's cookies, storage or DOM; no `allow-popups`,
 * `allow-top-navigation`, `allow-forms` or `allow-modals`. And it is loaded from a **different
 * origin** (`config.sandboxOrigin`, the BFF's second listener), whose shell page's CSP has
 * `connect-src 'none'`. Either wall alone would stop the obvious attack; both are there so that
 * losing one in some later edit is not the end of it. When this deployment has no sandbox origin,
 * or names the app's own, the artefact is shown as **escaped source** with a notice — never inline.
 *
 * ## The handshake
 *
 * The HTML is posted once, on the frame's first `load` — by then the shell's inline script has run
 * and is listening, so no "ready" message is needed and the frame posts back nothing but heights
 * (the contract's "only `{type: "height", px}`"). Target `'*'`, because an opaque origin has no
 * name to target: what that leaves is a frame that navigated *itself* elsewhere before loading,
 * and it is why the post happens on the first load only — a later load is the frame's own
 * navigation, and it is not handed the HTML again. Heights are accepted only from this frame's
 * window with the opaque origin, through `heightMessage`, which reads nothing else and clamps.
 *
 * What the sandbox does **not** stop is a page navigating its own frame to another site with data
 * in the URL; CSP has no directive that bounds a frame's own navigation in the browsers this app
 * supports. The data such a page could carry is the artefact's own HTML — which it already is.
 */

import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ExhibitView, HtmlSpec } from '../../../../shared/exhibits.ts';
import {
  SANDBOX_FRAME_PATH,
  clampHeight,
  heightMessage,
  usableSandboxOrigin,
} from '../../../../shared/sandbox.ts';
import { config } from '../../../env.ts';

/** The notice shown in place of a preview — the contract's sentence, then what to do about it. */
export const NO_SANDBOX_NOTICE = 'HTML preview needs a separate sandbox origin';

/** The frame, and the two messages it is allowed to exchange with this page. */
function SandboxFrame({
  origin,
  html,
  initialHeight,
  title,
}: {
  origin: string;
  html: string;
  initialHeight: number;
  title: string;
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const posted = useRef(false);
  const [height, setHeight] = useState(initialHeight);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // This frame's window, posting from the opaque origin a sandboxed document has — and only a
      // height. Anything else (another frame, this page, an extension, a forged origin) is ignored.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      if (event.origin !== 'null') return;
      const px = heightMessage(event.data);
      if (px !== null) setHeight(px);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={frame}
      src={`${origin}${SANDBOX_FRAME_PATH}`}
      // The whole grant. See the module header for each token that is deliberately absent.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={title}
      style={{ height }}
      className="w-full rounded-lg border border-border-subtle bg-surface-raised"
      onLoad={() => {
        if (posted.current) return;
        posted.current = true;
        frame.current?.contentWindow?.postMessage({ type: 'html', html }, '*');
      }}
    />
  );
}

export function HtmlView({ view, spec }: { view: ExhibitView; spec: HtmlSpec }): React.JSX.Element {
  const origin = usableSandboxOrigin(config.sandboxOrigin, window.location.origin);
  const name = view.title || 'HTML artefact';

  if (!origin) {
    return (
      <div className="flex flex-col gap-2">
        <p
          role="note"
          className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {NO_SANDBOX_NOTICE}, and this deployment has none (<code>SANDBOX_ORIGIN</code> is unset,
            or is this app&rsquo;s own origin) — so the page is shown as its source rather than run
            here.
          </span>
        </p>
        <pre
          tabIndex={0}
          role="region"
          aria-label={`${name} — HTML source`}
          className="max-h-[60vh] overflow-auto rounded-lg border border-border-subtle bg-surface-raised p-2 font-mono text-2xs whitespace-pre-wrap focus-ring"
        >
          {spec.html}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SandboxFrame
        // A new revision is a new frame: the shell takes one document per load, by design.
        key={`${view.exhibit_id}:${view.revision}`}
        origin={origin}
        html={spec.html}
        initialHeight={clampHeight(spec.height) ?? 480}
        title={`${name} — sandboxed HTML preview`}
      />
      <p className="flex items-center gap-1.5 text-2xs text-ink-muted">
        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
        Written by {view.author_kind === 'agent' ? 'the agent' : view.author || 'a person'}. Runs in
        an isolated frame with no network access and no access to this app or your sign-in.
      </p>
    </div>
  );
}
