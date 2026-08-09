/**
 * The streaming reverse proxy to the Chemclaw service.
 *
 * Built on `node:http.request` rather than `fetch`/undici deliberately. Node's global fetch
 * dispatcher defaults to `bodyTimeout: 300_000` — an *idle* timeout between body chunks — and
 * `GET /sessions/{id}/events` is legitimately silent for many minutes at a time, so undici would
 * abort a perfectly healthy stream after five. A 600s turn on the messages endpoint sits right on
 * the same edge. `http.request` has no body idle timeout, hands back a `Readable` on both sides so
 * `.pipe()` gives us backpressure for free, and needs no dependency.
 *
 * Authorization is never *inspected* here in either mode. The backend already performs full RS256
 * signature + audience + issuer validation on every request; a second copy of that logic here
 * would be one more thing to misconfigure and would make the origin of a 401 ambiguous. What
 * differs by mode is where the header comes from: under `msal-spa` the browser's own header is
 * forwarded verbatim, and under `bff` it is discarded and replaced with the token this process
 * holds on the user's behalf. See `InjectedAuth`.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config.ts';
import { clientProto, firstHeader, normaliseAddress } from './httpUtil.ts';
import { log } from './log.ts';

/**
 * A token to present upstream on the caller's behalf.
 *
 * Present only in `bff` mode. `accessToken` may be an empty string — an anonymous request under
 * BFF custody — and that still means "strip whatever the browser sent", which is why this is an
 * object rather than a bare `string | null`.
 */
export interface InjectedAuth {
  accessToken: string;
}

/**
 * Parsed lazily, not at module scope.
 *
 * `server/index.ts` imports this module before it calls `validateConfig()`, so a module-level
 * `new URL(cfg.apiUrl)` ran first and a typo'd `CHEMCLAW_API_URL` produced a raw `TypeError:
 * Invalid URL` naming this file — while the curated message in `validateConfig` could never
 * print. The most likely configuration mistake had the least useful error.
 */
let upstreamUrl: URL | null = null;
const upstream = (): URL => (upstreamUrl ??= new URL(cfg.apiUrl));
const transport = (): typeof http | typeof https =>
  upstream().protocol === 'https:' ? https : http;

/**
 * keepAlive with NO socket timeout. A turn can legitimately run for the backend's full 600s
 * wall clock without producing a byte, and the job stream longer still.
 */
let agentInstance: http.Agent | null = null;
const agent = (): http.Agent =>
  (agentInstance ??= new (transport().Agent)({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 128,
    timeout: 0,
  }));

/** Headers that describe a single hop and must never be copied across one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const isEventStream = (headers: IncomingHttpHeaders): boolean =>
  String(headers['content-type'] ?? '').includes('text/event-stream');

/**
 * Inject SSE comment frames while the upstream is quiet, so intermediaries with idle timeouts
 * do not drop a healthy but silent stream.
 *
 * Only ever writes `: hb\n\n` — a comment, which every SSE parser discards. It never synthesises
 * a fake event. It also only writes at a frame boundary: if the last bytes we forwarded were not
 * `\n\n`, we may be mid-frame (a frame can be split across TCP chunks), and injecting there would
 * corrupt the frame the client is still assembling.
 */
function attachHeartbeat(upstreamRes: IncomingMessage, res: ServerResponse): void {
  let lastChunkAt = Date.now();
  // The last two bytes forwarded, tracked ACROSS chunks rather than within one.
  //
  // This was `chunk.subarray(-2)` per chunk, which is wrong for the case that matters: a frame
  // terminator split across TCP chunks arrives as a final chunk of a single `\n`, giving
  // `tail.length === 1` and therefore `atFrameBoundary = false`. Nothing reset it until the next
  // `data` event — so if the stream then went quiet, which is precisely the situation heartbeats
  // exist for, the heartbeat never fired again and an idle-timeout intermediary was free to drop
  // a perfectly healthy stream. Carrying the previous byte forward makes the boundary test a
  // property of the byte stream instead of a property of how it happened to be chunked.
  let prevByte = -1;
  let lastByte = -1;

  // A 'data' listener coexists with .pipe(); both receive chunks in flowing mode.
  upstreamRes.on('data', (chunk: Buffer) => {
    lastChunkAt = Date.now();
    if (chunk.length === 0) return;
    if (chunk.length === 1) {
      prevByte = lastByte;
      lastByte = chunk[0] ?? -1;
    } else {
      prevByte = chunk[chunk.length - 2] ?? -1;
      lastByte = chunk[chunk.length - 1] ?? -1;
    }
  });

  const atFrameBoundary = (): boolean => prevByte === 0x0a && lastByte === 0x0a;

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastChunkAt < cfg.sseHeartbeatMs) return;
    // Before any body byte has been forwarded we are trivially at a boundary — there is no
    // half-written frame to corrupt — so a stream that is silent from the very first moment
    // (a turn waiting on an admission permit) still gets its keepalive.
    if (lastByte !== -1 && !atFrameBoundary()) return;
    res.write(': hb\n\n');
  }, cfg.sseHeartbeatMs);

  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  upstreamRes.on('end', stop);
  upstreamRes.on('error', stop);
}

/**
 * Request headers the upstream is allowed to see.
 *
 * An **allow-list**, and it used to be a deny-list. The difference matters because the deny-list
 * only named what it had thought of: `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`,
 * `x-real-ip` and any header a caller cared to invent all reached the backend verbatim, and this
 * process set none of them itself. Nothing upstream trusts them *today*, but "no component
 * between the browser and the service ever starts trusting a forwarded header" is not a property
 * a proxy can assume on the service's behalf — and if one ever does, a spoofed client IP is a
 * rate-limit bypass and an audit-trail lie.
 *
 * The set is small because the backend's surface is small: a bearer token, content negotiation,
 * and the bits `multipart/form-data` needs.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'if-none-match',
  'if-modified-since',
  'last-event-id',
  // Conditional/partial reads. Without these on the request leg the corresponding response
  // headers are unreachable, so 206 was broken end to end.
  'range',
  'if-range',
  // Both `client.ts` and `useJobFeed.ts` set `cache: 'no-store'`, which the browser emits as a
  // request header; dropping it silently discarded the caller's stated intent.
  'cache-control',
  'pragma',
]);

/**
 * Response headers the browser is allowed to see.
 *
 * Also an allow-list, for the mirror-image reason. The old code copied everything non-hop-by-hop,
 * which forwarded `set-cookie` from the backend onto this app's origin — while the request leg
 * stripped `cookie`, so the cookie could be set and would then never come back.
 *
 * Keeping `set-cookie` out matters more now than it did then, not less. This origin *does* carry
 * cookies since BFF custody landed, and they are the session — so a backend (or anything able to
 * answer as one) that emitted a `Set-Cookie` would be writing into the same namespace as the
 * sealed session and the CSRF token. The allow-list is what makes that impossible rather than
 * merely unlikely. It also keeps `server:`/`x-powered-by` banners off the wire.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'retry-after',
  'content-disposition',
  'vary',
  // Restored after review found each of these breaks a path that used to work:
  // `location` — without it a 3xx is a redirect with no target, so a browser renders blank and
  //   `fetch` (which follows redirects by default) throws. Starlette's own `redirect_slashes`
  //   produces these.
  'location',
  // `www-authenticate` — RFC 9110 makes this MUST-send on a 401, and its `error_description` is
  //   the only machine-readable "expired" vs "invalid" signal a client gets.
  'www-authenticate',
  // `content-encoding` — `accept-encoding: identity` binds the backend, not a sidecar configured
  //   to compress anyway. Dropping it hands the browser gzip bytes labelled JSON, which fails as
  //   a `SyntaxError` in `res.json()` rather than as anything diagnosable.
  'content-encoding',
  // `allow` — a 405 that does not say which methods are permitted is not much of a 405.
  'allow',
  'accept-ranges',
  'content-range',
]);

/**
 * Copy the allowed request headers to the upstream and set the ones we own authoritatively.
 *
 * `injected` is the BFF-custody path: when it is non-`null` the browser's own `Authorization` is
 * discarded unconditionally and replaced with the token held server-side. Discarding it even when
 * there is nothing to inject is the point — in `bff` mode a bearer token arriving from the browser
 * is by definition not one this deployment issued, and forwarding it would let a caller bypass the
 * cookie session entirely and hand the backend a token of their own choosing.
 */
function buildUpstreamHeaders(
  req: IncomingMessage,
  injected: InjectedAuth | null,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  if (injected !== null) {
    delete headers['authorization'];
    if (injected.accessToken) headers['authorization'] = `Bearer ${injected.accessToken}`;
  }
  // Never let the upstream compress an event stream: a compressor buffers until its window
  // fills, so tokens would arrive in clumps or, on a short answer, not until the very end.
  headers['accept-encoding'] = 'identity';
  headers['host'] = upstream().host;
  // Appended, not overwritten — and this is the correction to a fix that made things worse.
  //
  // Overwriting with `req.socket.remoteAddress` sounded safe ("a client-supplied value would be a
  // forgery") and was not: in every deployment this project has — Replit, compose behind a
  // published port, any ingress — that address IS the proxy in front of us, and the inbound
  // header was the only place the real client address existed. Stripping it and substituting our
  // peer manufactured exactly the audit-trail lie the allow-list exists to prevent, with this
  // process's authority behind it.
  //
  // The standard shape is a list, oldest first, each hop appending its peer. A downstream reader
  // that trusts the first entry is making its own decision about how many proxies to trust; what
  // this must not do is destroy the information.
  const remote = normaliseAddress(req.socket.remoteAddress);
  const inbound = firstHeader(req.headers['x-forwarded-for']);
  const chain = [inbound, remote].filter((part): part is string => Boolean(part));
  if (chain.length > 0) headers['x-forwarded-for'] = chain.join(', ');
  // Describes the scheme the CLIENT used to reach this proxy, not the leg we are about to make.
  // Deriving it from the upstream protocol reported `http` to a backend whose user was on HTTPS.
  headers['x-forwarded-proto'] = clientProto(req);
  const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers.host);
  if (host) headers['x-forwarded-host'] = host;
  return headers;
}

/**
 * Methods it is safe to replay when the connection dies before any response.
 *
 * Observed live: a request landing on a pooled keep-alive socket that the upstream had already
 * closed fails with ECONNRESET, and the caller sees a 502 for a backend that is perfectly healthy.
 * The window is small but it is a race no amount of care on the upstream side closes.
 *
 * `POST` is deliberately absent, and that is the whole point of having a list. Replaying
 * `POST /sessions/{id}/messages` would either double-spend the turn budget or collide with the
 * backend's per-session turn lock and come back 409 — the same reasoning that made `streamTurn`
 * refuse to auto-retry on the client side. `DELETE /jobs/{id}` is included: cancellation is
 * idempotent, and asking twice to stop the same run is harmless.
 */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/** Connection-level failures, i.e. ones where the request provably never reached a handler. */
const REPLAYABLE_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/** How long, and how much more, an over-cap upload may keep sending before the socket is closed. */
const LINGER_MS = 5_000;
const LINGER_MAX_BYTES = 8 * 1024 * 1024;

export function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  expectSse: boolean,
  /** BFF custody: the token to present upstream, and the signal to drop the browser's own. */
  injected: InjectedAuth | null = null,
  /** Internal: set when this call is already the one retry a request gets. */
  isRetry = false,
): void {
  const upstreamReq = transport().request(
    {
      protocol: upstream().protocol,
      hostname: upstream().hostname,
      port: upstream().port || (upstream().protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers: buildUpstreamHeaders(req, injected),
      agent: agent(),
    },
    (upstreamRes) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key)) continue;
        if (!FORWARDED_RESPONSE_HEADERS.has(key)) continue;
        out[key] = value;
      }

      const streaming = expectSse && isEventStream(upstreamRes.headers);
      if (streaming) {
        delete out['content-length'];
        out['cache-control'] = 'no-cache, no-transform';
        // The standard opt-out from nginx's (and several cloud ingresses') response buffering,
        // which would otherwise hold the whole stream until it completes. Harmless elsewhere.
        out['x-accel-buffering'] = 'no';
      }

      res.writeHead(upstreamRes.statusCode ?? 502, out);
      // Without this Node holds the header block until the first body write, so the browser's
      // fetch() promise does not resolve and the client cannot tell "connecting" from "thinking".
      res.flushHeaders();

      if (streaming && cfg.sseHeartbeatMs > 0) attachHeartbeat(upstreamRes, res);

      upstreamRes.pipe(res);
    },
  );

  // No idle timeout: see the Agent comment above.
  upstreamReq.setTimeout(0);

  upstreamReq.on('socket', (socket) => {
    // Token frames are a few bytes each; Nagle would batch them into visible stutter.
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    // Bound only the CONNECT phase — an unreachable backend should fail fast even though an
    // established stream may then be silent indefinitely.
    if (cfg.upstreamConnectTimeoutMs > 0 && socket.connecting) {
      const connectTimer = setTimeout(() => {
        upstreamReq.destroy(new Error('upstream connect timeout'));
      }, cfg.upstreamConnectTimeoutMs);
      socket.once('connect', () => clearTimeout(connectTimer));
      upstreamReq.once('error', () => clearTimeout(connectTimer));
    }
  });

  /**
   * Propagate a client disconnect into the upstream request.
   *
   * This is the single most important line in the file. The backend serialises turns per session
   * and there is no cancel endpoint: if the user presses Stop (or closes the tab) and we leave the
   * upstream request open, the turn keeps running, keeps spending budget, and keeps holding the
   * session's turn slot — so the next message comes back 409 "a turn is already running". FastAPI
   * cancels the handler on client disconnect, so destroying the socket here is what actually
   * releases that lock.
   */
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    // Replay once through a fresh connection when the failure was the connection itself and the
    // method is safe to repeat. Only for a request with no body to re-send — `req` has already
    // been consumed by the pipe, so a body-carrying request cannot be replayed even in principle.
    const method = req.method ?? 'GET';
    const replayable =
      !isRetry &&
      REPLAYABLE_METHODS.has(method) &&
      REPLAYABLE_ERRORS.has(err.code ?? '') &&
      !req.readableDidRead &&
      // The client must still be there. `res.on('close')` fires exactly once, so if it has
      // already fired, a retry creates an upstream request that nothing will ever cancel — and on
      // the long-lived event stream that means a leaked connection per occurrence, against a
      // per-user cap. The disconnect propagation this file calls its most important line is
      // precisely what the retry path was bypassing.
      !res.destroyed &&
      !res.writableEnded;
    if (replayable) {
      log.debug(`retrying ${method} ${upstreamPath} once after ${err.code}`);
      proxy(req, res, upstreamPath, expectSse, injected, true);
      return;
    }

    log.warn(`upstream error for ${method} ${upstreamPath}: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'upstream unavailable', code: err.code ?? 'EPROXY' }));
  });

  // Bound the request body.
  //
  // This used to be a bare `req.pipe(upstreamReq)` with a comment observing that attachments
  // "stream through just as happily" — which is exactly the problem: nothing capped them, and
  // `server.requestTimeout` was 0, so one client could stream unlimited bytes for unlimited time
  // through this process and into the backend. The backend caps bodies at 4 MB and answers 413;
  // refusing at the edge means the bytes never cross the internal network, and the caller gets
  // the same status either way.
  let received = 0;
  let refused = false;
  req.on('data', (chunk: Buffer) => {
    if (refused) return;
    received += chunk.length;
    if (received <= cfg.maxBodyBytes) return;
    refused = true;
    log.warn(`request body over ${cfg.maxBodyBytes} bytes for ${req.method} ${upstreamPath}`);

    // Stop feeding the upstream, then answer — WITHOUT resetting the client's connection.
    //
    // The first version called `req.destroy()` in the same tick as `res.end()`. That destroys the
    // socket the client is still writing its body to, so the browser sees ERR_CONNECTION_RESET and
    // discards the response it had already received: the user got "could not reach the service"
    // for a file that was simply too large, which is the opposite diagnosis. (A Node client
    // happened to surface the 413 first, which is why this looked fine when tested from a script.)
    //
    // Unpiping first also stops pipe's own `ondata` writing into a destroyed upstream request,
    // which raced a second socket kill against the same response.
    req.unpipe(upstreamReq);
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.writeHead(413, {
        'content-type': 'application/json',
        // The remaining body is not going to be read, so the connection cannot be reused. Saying
        // so lets the client finish writing and close cleanly instead of being reset mid-upload.
        connection: 'close',
      });
      res.end(
        JSON.stringify({ detail: `request body exceeds the ${cfg.maxBodyBytes} byte limit` }),
      );
    }
    // Lingering close: drain and discard what is still arriving, bounded, then close.
    //
    // This is what nginx does for `client_max_body_size` and it exists for exactly this reason —
    // a client that is mid-upload will not read a response off a socket that has been reset, so
    // closing immediately means the 413 is never seen. Draining lets the client finish writing,
    // notice the response, and close cleanly. Bounded in both time and bytes so an oversized
    // upload still cannot be used to hold the connection open indefinitely, which is the point of
    // having a cap at all.
    req.resume();
    let drained = 0;
    const onDrainChunk = (chunk: Buffer): void => {
      drained += chunk.length;
      if (drained > LINGER_MAX_BYTES) req.destroy();
    };
    req.on('data', onDrainChunk);
    const linger = setTimeout(() => req.destroy(), LINGER_MS);
    // `unref` so a lingering drain never holds the process open during shutdown.
    linger.unref();
    req.once('end', () => clearTimeout(linger));
    req.once('close', () => clearTimeout(linger));
  });

  req.pipe(upstreamReq);
}
