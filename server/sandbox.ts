/**
 * The HTML sandbox's shell page (wave 3) — the only thing the second listener serves.
 *
 * ## Why a second listener, and not a path on this one
 *
 * An `html` artefact is markup and script the agent wrote, and the app's origin holds the bearer
 * token. The frame that runs it is `sandbox="allow-scripts"` with no `allow-same-origin`, so its
 * document is opaque-origin whatever URL it came from — and it is *also* served from a different
 * origin (`SANDBOX_ORIGIN`), so that one attribute lost in a later edit would not put agent script
 * on the token's origin. A path on the app listener cannot be a different origin, so the app
 * listener answers `/sandbox/frame` with a 404 (`app.ts`) and this one answers nothing else.
 *
 * ## The page
 *
 * A static shell with one inline script, under the contract's policy: no network the CSP governs
 * (`connect-src 'none'`, `default-src 'none'`), inline script and style only, images and fonts
 * only from `data:`/`blob:`, no form submissions, no `<base>`, and framable **only by the app
 * origin**. It accepts one message — `{type: "html", html, scripts, height, title}` from its parent
 * window *and* from the app origin injected below — and from then on posts back
 * `{type: "height", px}` and nothing else, debounced and clamped (`shared/sandbox.ts`).
 *
 * ## Scripts are off unless a person turned them on (wave-3 amendment)
 *
 * The shell does not write the artefact into its own document. It puts it in a nested `srcdoc`
 * frame with `sandbox=""` — no script at all — at the spec's height. Only a message carrying
 * `scripts: true`, which the app sends after a click on "Run scripts", gets `sandbox="allow-scripts"`,
 * and then with `RTC_PRELUDE` in front. The reason is measured, not argued: CSP does not govern
 * WebRTC, so a scripted page can send data out over STUN/UDP whatever `connect-src` says, and can
 * write the clipboard after one click. The nested frame inherits this response's CSP, and its
 * navigations are bounded by this document's `default-src 'none'` (no `frame-src`), so it cannot
 * navigate itself anywhere; the shell's own frame is bounded by the app's `frame-src`.
 *
 * No cookies are set, no credential is read, and nothing about a caller is logged beyond the
 * access line every response gets.
 */

import type http from 'node:http';
import { SANDBOX_FRAME_PATH, SANDBOX_MAX_HEIGHT, SANDBOX_MIN_HEIGHT } from '../shared/sandbox.ts';

/**
 * The shell's Content-Security-Policy — the contract's string, with the app origin as the one
 * ancestor allowed to frame it.
 */
export function sandboxCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join('; ');
}

/** The headers the shell page is served with, besides its content type and length. */
export function sandboxHeaders(appOrigin: string): Record<string, string> {
  return {
    'content-security-policy': sandboxCsp(appOrigin),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-site',
    'x-dns-prefetch-control': 'off',
    // The page is a constant of this process's configuration; revalidated so a changed APP_ORIGIN
    // takes on the next load rather than after a heuristic expiry.
    'cache-control': 'no-cache',
  };
}

/**
 * A string as a JavaScript literal that is safe inside `<script>`: JSON, with `<` escaped so the
 * value cannot close the tag it sits in. The origin is operator-supplied and already validated as
 * a plain origin (`plainOrigin`), so this is the second check, not the only one.
 */
const scriptLiteral = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The prelude a **scripted** render puts in front of the artefact (wave-3 amendment): it removes the
 * WebRTC constructors from the content's realm, because WebRTC is the one egress no CSP directive
 * governs — measured, a page under this shell's `connect-src 'none'` sent UDP carrying data it had
 * read to an arbitrary host through a STUN candidate, and Chromium ignores `webrtc 'block'`.
 *
 * **Defence in depth only, and bypassable.** It reaches the realm it runs in and no other: a page
 * that creates a nested `srcdoc` frame gets a fresh realm whose constructors were never touched, and
 * a scripted render inherits `allow-scripts` into it. The control that holds is the *default*: no
 * script runs at all until a person presses "Run scripts" — and, for a deployment, the browser
 * policy `WebRtcIPHandling=disable_non_proxied_udp` (README, "HTML sandbox").
 */
export const RTC_PRELUDE =
  '<script>(function () {' +
  "var names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'];" +
  'for (var i = 0; i < names.length; i++) {' +
  'try { Object.defineProperty(window, names[i], { value: undefined, writable: false, configurable: false }); }' +
  'catch (e) {}' +
  '}' +
  '})();</script>';

/** The shell page itself, for one app origin. */
export function renderSandboxShell(appOrigin: string): string {
  const script = `(function () {
  var APP = ${scriptLiteral(appOrigin)};
  var MIN = ${SANDBOX_MIN_HEIGHT};
  var MAX = ${SANDBOX_MAX_HEIGHT};
  var PRELUDE = ${scriptLiteral(RTC_PRELUDE)};
  var up = window.parent;
  var done = false;
  var timer = 0;
  var last = -1;
  function clamp(px) {
    return Math.min(MAX, Math.max(MIN, Math.ceil(typeof px === 'number' && isFinite(px) ? px : 0)));
  }
  function report() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var root = document.documentElement;
      var px = clamp(root ? root.getBoundingClientRect().height : 0);
      if (px === last) return;
      last = px;
      up.postMessage({ type: 'height', px: px }, APP);
    }, 50);
  }
  window.addEventListener('message', function (event) {
    if (done || event.source !== up || event.origin !== APP) return;
    var data = event.data;
    if (!data || data.type !== 'html' || typeof data.html !== 'string') return;
    done = true;
    var scripts = data.scripts === true;
    var html = data.html;
    if (scripts) {
      // After a doctype, never before it: a script ahead of the doctype would put the page in quirks mode.
      var doctype = /^\\s*<!doctype[^>]*>/i.exec(html);
      html = doctype ? doctype[0] + PRELUDE + html.slice(doctype[0].length) : PRELUDE + html;
    }
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', scripts ? 'allow-scripts' : '');
    frame.setAttribute('title', typeof data.title === 'string' ? data.title : 'Artefact content');
    frame.style.cssText = 'display:block;border:0;width:100%;height:' + clamp(data.height) + 'px';
    frame.srcdoc = html;
    document.body.appendChild(frame);
    if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);
    report();
  });
})();`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Artefact sandbox</title><style>html,body{margin:0;padding:0}</style></head><body>' +
    `<script>${script}</script></body></html>`
  );
}

/**
 * What the second listener answers: the shell on `GET`/`HEAD /sandbox/frame`, and a bare 404 for
 * every other path. Synchronous and stateless — the page is rendered once per process.
 *
 * Returns the route label it answered under, for the access line and the metrics, which are keyed
 * on patterns rather than on attacker-chosen paths (`app.ts`).
 */
export function createSandboxHandler(
  appOrigin: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => string {
  const page = renderSandboxShell(appOrigin);
  const headers = sandboxHeaders(appOrigin);
  return (req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    const method = req.method ?? 'GET';
    if (path !== SANDBOX_FRAME_PATH) {
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end('Not Found');
      return 'sandbox:other';
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return SANDBOX_FRAME_PATH;
    }
    res.writeHead(200, {
      ...headers,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page),
    });
    res.end(method === 'HEAD' ? undefined : page);
    return SANDBOX_FRAME_PATH;
  };
}
