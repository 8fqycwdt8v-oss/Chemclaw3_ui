/**
 * The HTML sandbox's two-sided protocol (wave 3) — what the app and the sandbox shell agree on.
 *
 * An `html` artefact is agent-written markup and script. It never runs on the app's origin, which
 * holds the bearer token: it runs in a frame served by the BFF's **second listener**
 * (`SANDBOX_ORIGIN`, a different origin, ideally a different hostname), embedded with
 * `sandbox="allow-scripts"` and nothing else — so its document is opaque-origin as well as
 * cross-origin, cannot reach the network (`connect-src 'none'` on the shell), and cannot touch the
 * app's storage, cookies, top window or a popup.
 *
 * The two halves talk in exactly two messages, and both checks are on the receiving side:
 *
 *  - **app → frame: `{type: "html", html}`**, posted once, when the frame has loaded. The shell
 *    accepts it only from its parent window and only when `event.origin` is the app origin the
 *    server injected — so another tab, another frame or a page that framed the shell cannot hand it
 *    content. Posted with target `'*'` because the frame's origin is opaque and no origin string
 *    names it; what that does not protect is argued in `HtmlView`.
 *  - **frame → app: `{type: "height", px}`**, debounced and clamped by the shell, and clamped again
 *    by the app, which accepts it only from that frame's window (`event.source`) with the opaque
 *    origin (`"null"`) a sandboxed document posts from. Nothing else a frame posts is read.
 *
 * Imported by the BFF (`server/sandbox.ts`, which inlines the numbers into the shell's script) and
 * by the SPA (`HtmlView`), so the clamp the shell applies and the one the app applies are one pair
 * of constants. Dependency-free: it is on the server's path and in a lazy client chunk.
 */

/** The one path the sandbox listener serves a page on, and the one the app listener 404s. */
export const SANDBOX_FRAME_PATH = '/sandbox/frame';

/** The frame's height bounds, in CSS pixels. A frame cannot make itself taller than a few screens
 *  — a page that reported 10⁹ px would otherwise push the rest of the pane out of reach. */
export const SANDBOX_MIN_HEIGHT = 80;
export const SANDBOX_MAX_HEIGHT = 4_000;

/** A height clamped to the bounds, or `null` for something that is not a height at all. */
export function clampHeight(px: unknown): number | null {
  if (typeof px !== 'number' || !Number.isFinite(px)) return null;
  return Math.min(SANDBOX_MAX_HEIGHT, Math.max(SANDBOX_MIN_HEIGHT, Math.round(px)));
}

/** The height a frame message carries, or `null` when the message is anything but `{type:"height", px}`. */
export function heightMessage(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null;
  const { type, px } = data as { type?: unknown; px?: unknown };
  return type === 'height' ? clampHeight(px) : null;
}

/**
 * The sandbox origin as a usable origin, or `''` when there is none to use.
 *
 * Unusable: unset, not an http(s) origin, or **the app's own origin** — a frame from the origin
 * holding the token is not a sandbox, whatever its attribute says, so that configuration is shown
 * as escaped source rather than run.
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
