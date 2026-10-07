/**
 * An `html` artefact: agent-written HTML shown only in the sandbox origin's frame, with its scripts
 * running by default (per-view **Disable scripts**) or, under `HTML_SCRIPTS_DEFAULT=off`, only
 * after **Run scripts**. Lazily loaded.
 *
 * The outer frame is `sandbox="allow-scripts"` only (opaque origin; no popups, top navigation,
 * forms or modals), loaded from `config.sandboxOrigin` under `connect-src 'none'`; the shell nests
 * the artefact in a `srcdoc` frame (`sandbox=""` or `allow-scripts` behind `RTC_PRELUDE`). Scripts
 * can still use WebRTC and the clipboard — an accepted risk the view always states. Navigation is
 * bounded by the app's `frame-src` and the shell's `default-src 'none'`. The script choice is never
 * persisted.
 *
 * Shown as escaped source with a notice when there is no sandbox origin, or the page is not at
 * `APP_ORIGIN`. Handshake: the HTML is posted (target `'*'`, opaque origin) in answer to every
 * `ready` from this frame; `ready` and heights are accepted only from this frame's window with an
 * opaque origin. No `ready` within `SANDBOX_READY_TIMEOUT_MS` shows the source with "The sandbox
 * did not answer".
 */

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Play, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import type { ExhibitView, HtmlSpec } from '../../../../shared/exhibits.ts';
import {
  SANDBOX_FRAME_PATH,
  SANDBOX_READY_TIMEOUT_MS,
  clampHeight,
  heightMessage,
  readyMessage,
  sandboxDocsUrl,
  usableSandboxOrigin,
} from '../../../../shared/sandbox.ts';
import { config } from '../../../env.ts';
import { Button } from '@/components/ui/button';

/** The notice shown in place of a preview — the contract's sentence, then what to do about it. */
export const NO_SANDBOX_NOTICE = 'HTML preview needs a separate sandbox origin';

/**
 * What a running script can still do — told before the reader types anything into it: send it out
 * over WebRTC.
 */
export const SCRIPT_RISKS =
  'They can still send data over the network through WebRTC, which no content policy blocks — ' +
  'including anything you type into this page, so never enter a password or other secret into a ' +
  'form drawn here — and write to your clipboard after a click.';

/** Said in place of a frame whose shell never answered within `SANDBOX_READY_TIMEOUT_MS`. */
export const SANDBOX_SILENT_NOTICE = 'The sandbox did not answer';

/** The frame, and the three messages it is allowed to exchange with this page. */
function SandboxFrame({
  origin,
  html,
  scripts,
  initialHeight,
  title,
  onSilent,
}: {
  origin: string;
  html: string;
  /** Whether the shell may give the content `allow-scripts`. A change is a new frame (`key`). */
  scripts: boolean;
  initialHeight: number;
  title: string;
  /** No `ready` within `SANDBOX_READY_TIMEOUT_MS`: the caller shows the source instead. */
  onSilent: () => void;
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(initialHeight);

  // A layout effect, so the listener exists before the frame can say `ready`.
  useLayoutEffect(() => {
    let answered = false;
    const silent = window.setTimeout(() => {
      if (!answered) onSilent();
    }, SANDBOX_READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      // This frame's window, posting from the opaque origin a sandboxed document has. Anything else
      // (another frame, this page, an extension, a forged origin) is ignored.
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== 'null') return;
      if (readyMessage(event.data)) {
        // Answer every `ready`: a reloaded shell is a fresh document waiting for content.
        answered = true;
        window.clearTimeout(silent);
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
    return () => {
      window.clearTimeout(silent);
      window.removeEventListener('message', onMessage);
    };
  }, [html, scripts, initialHeight, title, onSilent]);

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
  // The frame that did not answer, by revision and mode — so a new revision, or flipping scripts,
  // gets a fresh frame and a fresh wait rather than inheriting a verdict about another one.
  const mode = `${shown}:${scripts ? 'scripts' : 'static'}`;
  const [silentFor, setSilentFor] = useState<string | null>(null);
  const noticeId = useId();
  const docs = sandboxDocsUrl(config.docsBaseUrl, window.location.href);
  // Stable per mode, so the frame's effect is not torn down (and its wait restarted) by a render.
  const onSilent = useCallback(() => setSilentFor(mode), [mode]);

  if (!origin) {
    return (
      <SourceInstead name={name} html={spec.html}>
        {NO_SANDBOX_NOTICE}, and this deployment does not provide one here — so the page is shown as
        its source rather than run. The server&rsquo;s <code>html sandbox off:</code> startup line
        says why.
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

  if (silentFor === mode) {
    return (
      <SourceInstead name={name} html={spec.html}>
        {SANDBOX_SILENT_NOTICE} at <code>{origin}</code> within {SANDBOX_READY_TIMEOUT_MS / 1000}{' '}
        seconds, so the page is shown as its source. The sandbox host may be unreachable from this
        network, or something in front of it changed its response.
      </SourceInstead>
    );
  }

  const author = view.author_kind === 'agent' ? 'the agent' : view.author || 'a person';
  return (
    <div className="flex flex-col gap-2">
      <SandboxFrame
        // A new revision, or a change of mode, is a new frame: the shell takes one document per load.
        key={mode}
        origin={origin}
        html={spec.html}
        scripts={scripts}
        initialHeight={clampHeight(spec.height) ?? 480}
        title={`${name} — sandboxed HTML preview`}
        onSilent={onSilent}
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
            href={docs}
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
