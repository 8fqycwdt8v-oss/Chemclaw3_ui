/**
 * The HTML sandbox protocol shared by the app and the sandbox shell.
 *
 * An `html` artefact runs in a frame from the BFF's second listener (`SANDBOX_ORIGIN`), embedded
 * with `sandbox="allow-scripts"` only: opaque and cross-origin, `connect-src 'none'`, no access to
 * the app's token, storage or top window. Three messages, all checked by the receiver:
 * - frame → app `{type: "ready"}` once the shell is armed; the app sends nothing before it.
 * - app → frame `{type: "html", html, scripts, height, title}`, once; the shell accepts it only
 *   from its parent with the injected app origin. Posted to `'*'` since the frame origin is opaque
 *   (see `HtmlView`).
 * - frame → app `{type: "height", px}`, clamped by both sides; accepted only from that frame's
 *   window with origin `"null"`. Imported by `server/sandbox.ts` and `HtmlView` so both clamps
 *   share constants; dependency-free.
 */

/** The one path the sandbox listener serves a page on, and the one the app listener 404s. */
export const SANDBOX_FRAME_PATH = '/sandbox/frame';

/** The frame's height bounds, in CSS pixels. A frame cannot make itself taller than a few screens
 *  — a page that reported 10⁹ px would otherwise push the rest of the pane out of reach. */
export const SANDBOX_MIN_HEIGHT = 80;
export const SANDBOX_MAX_HEIGHT = 4_000;

/**
 * How long the app waits for the shell's first `ready` before showing the source with a notice
 * instead of a blank frame (unrouted host, rewritten CSP, proxy login, refused certificate).
 */
export const SANDBOX_READY_TIMEOUT_MS = 5_000;

/**
 * Where the README is read from when `DOCS_BASE_URL` is unset; the "How the sandbox works" link
 * resolves `README.md#html-sandbox-artefacts` against it. Air-gapped deployments point this at an
 * internal mirror.
 */
export const DEFAULT_DOCS_BASE_URL = 'https://github.com/8fqycwdt8v-oss/Chemclaw3_ui/blob/main/';

/** The README's sandbox section, resolved against a docs base (absolute, or a path on this origin). */
export function sandboxDocsUrl(base: string, pageUrl: string): string {
  try {
    return new URL(
      'README.md#html-sandbox-artefacts',
      new URL(base || DEFAULT_DOCS_BASE_URL, pageUrl),
    ).href;
  } catch {
    return new URL('README.md#html-sandbox-artefacts', DEFAULT_DOCS_BASE_URL).href;
  }
}

/** A height clamped to the bounds, or `null` for something that is not a height at all. */
export function clampHeight(px: unknown): number | null {
  if (typeof px !== 'number' || !Number.isFinite(px)) return null;
  return Math.min(SANDBOX_MAX_HEIGHT, Math.max(SANDBOX_MIN_HEIGHT, Math.round(px)));
}

/** Whether a frame message is the shell's `{type: "ready"}` — and nothing else is read from it. */
export function readyMessage(data: unknown): boolean {
  return data !== null && typeof data === 'object' && (data as { type?: unknown }).type === 'ready';
}

/** The height a frame message carries, or `null` when the message is anything but `{type:"height", px}`. */
export function heightMessage(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null;
  const { type, px } = data as { type?: unknown; px?: unknown };
  return type === 'height' ? clampHeight(px) : null;
}

/**
 * The sandbox origin if usable, else `''`. Unusable: unset, not http(s), or the app's own origin (a
 * frame on the token-holding origin is no sandbox, so content is shown as escaped source).
 */
export function usableSandboxOrigin(sandboxOrigin: string, appOrigin: string): string {
  if (!sandboxOrigin) return '';
  let origin: string;
  try {
    const url = new URL(sandboxOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    origin = url.origin;
  } catch {
    return '';
  }
  return origin === appOrigin ? '' : origin;
}
