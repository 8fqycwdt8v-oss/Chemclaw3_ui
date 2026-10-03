/**
 * An `html` artefact (wave 3): agent-written HTML, shown only in the sandbox origin's frame — and,
 * unless a person asks, with **no script running at all** (the wave-3 amendment).
 *
 * Lazy (`ExhibitPane` imports it with `React.lazy`), because almost no conversation holds one.
 *
 * ## The walls, and what they do not hold
 *
 * The outer frame is `sandbox="allow-scripts"` and nothing else — no `allow-same-origin`, so its
 * document has an opaque origin and cannot read this app's cookies, storage or DOM; no
 * `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`. It is loaded from a
 * **different origin** (`config.sandboxOrigin`, the BFF's second listener) whose shell page's CSP has
 * `connect-src 'none'`. The script it allows is the shell's own: the shell puts the artefact in a
 * nested `srcdoc` frame with `sandbox=""`, so by default the artefact's own script never runs.
 *
 * **"No network" is not a claim this view makes.** CSP does not govern WebRTC: measured under this
 * exact shell, a scripted page sent UDP to an arbitrary host through a STUN candidate, carrying
 * data it read from the page, and Chromium ignores `webrtc 'block'`. A scripted page can also write
 * the clipboard after one click. So scripts are off by default, and **Run scripts** — per view,
 * never persisted, reset by a new revision or a remount — says those risks before it is pressed.
 * A scripted render gets a prelude that removes the WebRTC constructors from the page's realm; that
 * is defence in depth and bypassable (a nested `srcdoc` realm is untouched). What holds for a
 * deployment is the browser policy `WebRtcIPHandling=disable_non_proxied_udp` (README).
 *
 * **Navigation is bounded, by `frame-src`.** The outer frame may only be navigated to an origin the
 * app's own CSP lists in `frame-src` — the sandbox origin, plus the Entra authority in MSAL mode —
 * so a page cannot carry data off by navigating its frame to another site (measured: self-navigation,
 * meta refresh, anchor clicks and `data:`/`blob:` URLs are all refused). The nested content frame is
 * bounded by the shell's `default-src 'none'`, which lists no frame source at all.
 *
 * When this deployment has no sandbox origin, or names the app's own, the artefact is shown as
 * **escaped source** with a notice — never inline.
 *
 * ## The handshake
 *
 * The HTML is posted once, on the frame's first `load` — by then the shell's inline script has run
 * and is listening, so no "ready" message is needed and the frame posts back nothing but heights
 * (the contract's "only `{type: "height", px}`"). Target `'*'`, because an opaque origin has no
 * name to target; the post happens on the first load only. Heights are accepted only from this
 * frame's window with the opaque origin, through `heightMessage`, which reads nothing else and
 * clamps.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Play, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import type { ExhibitView, HtmlSpec } from '../../../../shared/exhibits.ts';
import {
  SANDBOX_FRAME_PATH,
  clampHeight,
  heightMessage,
  usableSandboxOrigin,
} from '../../../../shared/sandbox.ts';
import { config } from '../../../env.ts';
import { Button } from '@/components/ui/button';

/** The notice shown in place of a preview — the contract's sentence, then what to do about it. */
export const NO_SANDBOX_NOTICE = 'HTML preview needs a separate sandbox origin';

/** What pressing "Run scripts" risks, said before it is pressed — the amendment's three residuals. */
export const RUN_SCRIPTS_WARNING =
  'Scripts written into this page will run. The sandbox keeps them away from this app and your ' +
  'sign-in, but not everything: they can send data over the network through WebRTC, which no ' +
  'content policy blocks; they can write to your clipboard after a click; and they can navigate ' +
  'their own frame, bounded only by this app’s frame policy. Run them only if you trust this page.';

/** The frame, and the two messages it is allowed to exchange with this page. */
function SandboxFrame({
  origin,
  html,
  scripts,
  initialHeight,
  title,
}: {
  origin: string;
  html: string;
  /** Whether the shell may give the content `allow-scripts`. A change is a new frame (`key`). */
  scripts: boolean;
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
        frame.current?.contentWindow?.postMessage(
          { type: 'html', html, scripts, height: initialHeight, title: `${title} — content` },
          '*',
        );
      }}
    />
  );
}

export function HtmlView({ view, spec }: { view: ExhibitView; spec: HtmlSpec }): React.JSX.Element {
  const origin = usableSandboxOrigin(config.sandboxOrigin, window.location.origin);
  const name = view.title || 'HTML artefact';
  // Which revision a person chose to run, here, in this mount — never stored anywhere, so a new
  // revision, another artefact or a reload is back to scripts off.
  const shown = `${view.exhibit_id}:${view.revision}`;
  const [ranFor, setRanFor] = useState<string | null>(null);
  const scripts = ranFor === shown;
  const warningId = useId();

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
        // A new revision, or a change of mode, is a new frame: the shell takes one document per load.
        key={`${shown}:${scripts ? 'scripts' : 'static'}`}
        origin={origin}
        html={spec.html}
        scripts={scripts}
        initialHeight={clampHeight(spec.height) ?? 480}
        title={`${name} — sandboxed HTML preview`}
      />
      <p className="flex items-center gap-1.5 text-2xs text-ink-muted">
        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
        Written by {view.author_kind === 'agent' ? 'the agent' : view.author || 'a person'}. Shown
        in an isolated frame with no access to this app or your sign-in
        {scripts ? '; its scripts are running.' : ', with its scripts turned off.'}
      </p>
      {scripts ? (
        <Button variant="outline" size="xs" className="self-start" onClick={() => setRanFor(null)}>
          <Square aria-hidden className="size-3.5" />
          Stop scripts
        </Button>
      ) : (
        <div className="flex flex-col gap-1">
          <p id={warningId} className="text-2xs text-ink-muted">
            {RUN_SCRIPTS_WARNING}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            aria-describedby={warningId}
            onClick={() => setRanFor(shown)}
          >
            <Play aria-hidden className="size-3.5" />
            Run scripts
          </Button>
        </div>
      )}
    </div>
  );
}
