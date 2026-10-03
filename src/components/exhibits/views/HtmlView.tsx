/**
 * An `html` artefact (wave 3): agent-written HTML, shown only in the sandbox origin's frame — with
 * its own script running by default (hardening, owner decision 2026-10-03) and a per-view
 * **Disable scripts**, or, under `HTML_SCRIPTS_DEFAULT=off`, with none until **Run scripts**.
 *
 * Lazy (`ExhibitPane` imports it with `React.lazy`), because almost no conversation holds one.
 *
 * ## The walls, and what they do not hold
 *
 * The outer frame is `sandbox="allow-scripts"` and nothing else — no `allow-same-origin`, so its
 * document has an opaque origin and cannot read this app's cookies, storage or DOM; no
 * `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`. It is loaded from a
 * **different origin** (`config.sandboxOrigin`, the BFF's second listener) whose shell page's CSP has
 * `connect-src 'none'`. The shell puts the artefact in a nested `srcdoc` frame: `sandbox=""` (no
 * script at all) when scripts are off, `sandbox="allow-scripts"` behind a prelude when they are on.
 *
 * **"No network" is not a claim this view makes.** CSP does not govern WebRTC: measured under this
 * exact shell, a scripted page sent UDP to an arbitrary host through a STUN candidate, carrying
 * data it read from the page, and Chromium ignores `webrtc 'block'`. A scripted page can also write
 * the clipboard after one click. The prelude removes the WebRTC constructors from the page's realm;
 * that is defence in depth and bypassable (a nested `srcdoc` realm is untouched). Running scripts by
 * default is an **owner-accepted residual risk** (docs/production-readiness.md), narrowed for a
 * deployment by browser policy and removed by `HTML_SCRIPTS_DEFAULT=off`. So the view says, always
 * and briefly, that scripts run isolated and what they can still do, with a link to the README.
 *
 * The per-view choice is never persisted: it is held against one revision of one artefact in this
 * mount, so a new revision, another artefact or a reload is back to the deployment's default.
 *
 * **Navigation is bounded, by `frame-src`.** The outer frame may only be navigated to an origin the
 * app's own CSP lists in `frame-src` — the sandbox origin, plus the Entra authority in MSAL mode —
 * so a page cannot carry data off by navigating its frame to another site (measured: self-navigation,
 * meta refresh, anchor clicks and `data:`/`blob:` URLs are all refused). The nested content frame is
 * bounded by the shell's `default-src 'none'`, which lists no frame source at all.
 *
 * ## When it is shown as source instead
 *
 * Never inline. Escaped source, with a notice, when this deployment has no sandbox origin (or names
 * the app's own), and when the page is open at an address other than `APP_ORIGIN` — the shell takes
 * content only from that origin, so the frame would stay blank; the notice names both.
 *
 * ## The handshake
 *
 * The shell posts `{type: "ready"}` once its listener is armed, and the HTML is posted in answer to
 * the first one, never before — a post on `load` relied on the shell's inline script having run by
 * then, and a message sent a moment early was lost with nothing to say so. Target `'*'`, because an
 * opaque origin has no name to target. `ready` and heights are accepted only from this frame's
 * window with the opaque origin; `heightMessage` reads nothing else and clamps.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Play, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import type { ExhibitView, HtmlSpec } from '../../../../shared/exhibits.ts';
import {
  SANDBOX_FRAME_PATH,
  clampHeight,
  heightMessage,
  readyMessage,
  usableSandboxOrigin,
} from '../../../../shared/sandbox.ts';
import { config } from '../../../env.ts';
import { Button } from '@/components/ui/button';

/** The notice shown in place of a preview — the contract's sentence, then what to do about it. */
export const NO_SANDBOX_NOTICE = 'HTML preview needs a separate sandbox origin';

/** What a running script can still do from inside the sandbox — the contract's residual risks. */
export const SCRIPT_RISKS =
  'They can still send data over the network through WebRTC, which no content policy blocks, ' +
  'write to your clipboard after a click, and navigate their own frame within this app’s frame ' +
  'policy.';

/** Where the sandbox, its residual risks and the deployment's controls over them are written down. */
export const SANDBOX_DOCS_URL =
  'https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/blob/main/README.md#html-sandbox-artefacts';

/** The frame, and the three messages it is allowed to exchange with this page. */
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
      // This frame's window, posting from the opaque origin a sandboxed document has. Anything else
      // (another frame, this page, an extension, a forged origin) is ignored.
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== 'null') return;
      if (readyMessage(event.data)) {
        // Once: a second `ready` is the frame having navigated itself, and is not handed the HTML.
        if (posted.current) return;
        posted.current = true;
        target.postMessage(
          { type: 'html', html, scripts, height: initialHeight, title: `${title} — content` },
          '*',
        );
        return;
      }
      const px = heightMessage(event.data);
      if (px !== null) setHeight(px);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html, scripts, initialHeight, title]);

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
    />
  );
}

/** The artefact as escaped text, under a notice saying why it is not previewed. */
function SourceInstead({
  name,
  html,
  children,
}: {
  name: string;
  html: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p
        role="note"
        className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>{children}</span>
      </p>
      <pre
        tabIndex={0}
        role="region"
        aria-label={`${name} — HTML source`}
        className="max-h-[60vh] overflow-auto rounded-lg border border-border-subtle bg-surface-raised p-2 font-mono text-2xs whitespace-pre-wrap focus-ring"
      >
        {html}
      </pre>
    </div>
  );
}

export function HtmlView({ view, spec }: { view: ExhibitView; spec: HtmlSpec }): React.JSX.Element {
  const here = window.location.origin;
  const origin = usableSandboxOrigin(config.sandboxOrigin, here);
  const name = view.title || 'HTML artefact';
  // The revision a person flipped away from the deployment's default, here, in this mount — never
  // stored anywhere, so a new revision, another artefact or a reload is back to the default.
  const shown = `${view.exhibit_id}:${view.revision}`;
  const [flippedFor, setFlippedFor] = useState<string | null>(null);
  const scripts = config.htmlScriptsDefault !== (flippedFor === shown);
  const noticeId = useId();

  if (!origin) {
    return (
      <SourceInstead name={name} html={spec.html}>
        {NO_SANDBOX_NOTICE}, and this deployment has none (<code>SANDBOX_ORIGIN</code> is unset, or
        is this app&rsquo;s own origin) — so the page is shown as its source rather than run here.
      </SourceInstead>
    );
  }
  if (config.appOrigin && config.appOrigin !== here) {
    return (
      <SourceInstead name={name} html={spec.html}>
        This app is open at <code>{here}</code>, but the sandbox takes pages only from{' '}
        <code>{config.appOrigin}</code> (<code>APP_ORIGIN</code>) — so the page is shown as its
        source. Open the app at <code>{config.appOrigin}</code> to preview it.
      </SourceInstead>
    );
  }

  const author = view.author_kind === 'agent' ? 'the agent' : view.author || 'a person';
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
      <p id={noticeId} role="note" className="flex items-start gap-1.5 text-2xs text-ink-muted">
        <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          Written by {author}.{' '}
          {scripts
            ? 'Its scripts are running, in an isolated frame with no access to this app or your sign-in.'
            : 'Its scripts are off. Run, they run in an isolated frame with no access to this app or your sign-in.'}{' '}
          {SCRIPT_RISKS}{' '}
          <a
            href={SANDBOX_DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-ink underline underline-offset-2 focus-ring"
          >
            How the sandbox works
          </a>
        </span>
      </p>
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        aria-describedby={scripts ? undefined : noticeId}
        onClick={() => setFlippedFor(flippedFor === shown ? null : shown)}
      >
        {scripts ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Play aria-hidden className="size-3.5" />
        )}
        {scripts ? 'Disable scripts' : 'Run scripts'}
      </Button>
    </div>
  );
}
