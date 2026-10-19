/**
 * The HTML sandbox's shell page — the only thing the second listener serves. Agent-written HTML
 * runs in a `sandbox="allow-scripts"` frame (opaque origin) that is also on a different origin
 * (`SANDBOX_ORIGIN`), so losing the attribute would still not put it on the token's origin. The app
 * listener 404s `/sandbox/frame`.
 *
 * The shell: one inline script under a closed CSP (`default-src 'none'`, `connect-src 'none'`,
 * `data:`/`blob:` images and fonts, no forms, no `<base>`), framable only by the app origin. It
 * posts `{type: "ready"}` to the app origin, accepts `{type: "html", html, scripts, height, title}`
 * from its parent at the app origin, and then only posts `{type: "height", px}` (debounced,
 * clamped; `shared/sandbox.ts`).
 *
 * The artefact goes into a nested `srcdoc` frame: `sandbox=""` (no script) unless `scripts: true`,
 * then `allow-scripts` with `RTC_PRELUDE`. Scripts can still use WebRTC and the clipboard (accepted
 * risk); they cannot navigate. No cookies are set or read.
 */

import type http from 'node:http';
import { SANDBOX_FRAME_PATH, SANDBOX_MAX_HEIGHT, SANDBOX_MIN_HEIGHT } from '../shared/sandbox.ts';

/** The shell's CSP, with the app origin as the only allowed framing ancestor. */
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
 * A string as a script-safe JS literal (JSON with `<` escaped). The origin is already validated
 * (`plainOrigin`).
 */
const scriptLiteral = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * Prelude for scripted renders: removes the WebRTC constructors (CSP does not govern WebRTC).
 * Defence in depth only — a nested `srcdoc` realm bypasses it. Browser policy narrows the residual;
 * `HTML_SCRIPTS_DEFAULT=off` removes it (README, "HTML sandbox").
 */
export const RTC_PRELUDE =
  '<script>(function () {' +
  "var names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'];" +
  'for (var i = 0; i < names.length; i++) {' +
  'try { Object.defineProperty(window, names[i], { value: undefined, writable: false, configurable: false }); }' +
  'catch (e) {}' +
  '}' +
  '})();</script>';

/** Headers for every refusal on the sandbox listener: text, not renderable, not framable. */
const REFUSAL_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/plain; charset=utf-8',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

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
  // Armed: say so, to the app origin only. Without it the app had to guess from \`load\` that this
  // listener existed, and a message posted a moment early was lost with nothing to say so.
  if (up !== window) up.postMessage({ type: 'ready' }, APP);
})();`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Artefact sandbox</title><style>html,body{margin:0;padding:0}</style></head><body>' +
    `<script>${script}</script></body></html>`
  );
}

/**
 * The second listener's handler: the shell on `GET`/`HEAD /sandbox/frame`, a bare 404 otherwise.
 * Returns the route label for logs and metrics.
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
      res.writeHead(404, REFUSAL_HEADERS);
      res.end('Not Found');
      return 'sandbox:other';
    }
    if (method !== 'GET' && method !== 'HEAD') {
      // The same closed headers as the 404: every response this origin sends carries a policy, so
      // a refusal is not the one page here a browser would render with none.
      res.writeHead(405, { ...REFUSAL_HEADERS, allow: 'GET, HEAD' });
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
