// @vitest-environment node
//
// Node, not happy-dom: this drives real sockets against a real `node:http` server.

/**
 * What one unauthenticated peer can do to the `/api` surface.
 *
 * The BFF authenticates nothing of its own — the backend does all of it — so every control that
 * decides how much of this process a stranger may hold is a socket-level one. Two were missing and
 * both were measured against a running BFF with a fake upstream:
 *
 *  - `requestTimeout = 0` plus `maxSockets: 128` and no connection cap: 120 concurrent one-byte
 *    POSTs answered `/api/healthz` in 11 ms, **129 took the whole `/api` surface offline** (curl
 *    exit 28), and it recovered the instant the sockets were released. A slow body was still open
 *    after 151 s having sent 29 bytes.
 *  - no body cap anywhere: `POST /api/sessions` with a 100 MB body reached the backend whole, in
 *    0.9 s, with no credential.
 *
 * The numbers below are the same measurement with the timeout turned down, because a test cannot
 * wait 60 s to watch a socket die.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * What the stand-in upstream actually received, tagged with the probe that sent it.
 *
 * Tagged rather than counted, because the slow requests above are still closing while the body
 * tests run — an untagged list is a list of somebody else's sockets.
 */
const received: { probe: string; bytes: number }[] = [];

/** Bytes the upstream got for one probe. */
const bytesFor = (probe: string): number[] =>
  received.filter((r) => r.probe === probe).map((r) => r.bytes);

let upstream: http.Server;
let bff: http.Server;
let port = 0;

/** Short enough for a test, and the point of the knob: it is a bound, whatever its value. */
const REQUEST_TIMEOUT_MS = 500;
const MAX_BODY_BYTES = 4_096;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    // Recorded on 'close' rather than 'end', so a body the BFF cuts off mid-stream is still
    // counted — that is the case worth measuring.
    const probe = String(req.headers['x-probe'] ?? '');
    req.on('close', () => received.push({ probe, bytes }));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_MS);
  process.env.MAX_BODY_BYTES = String(MAX_BODY_BYTES);
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  const { createBffServer } = await import('../server/app.ts');

  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/**
 * A POST that announces a body it is entitled to send, sends one byte of it, and stops — the
 * cheapest way to hold a connection, and the shape of the measured outage. The declared length
 * sits *under* the body cap on purpose: this is the request the cap cannot refuse.
 */
function slowPost(): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      // Read the response, or do not expect to notice the disconnection: a `net.Socket` with no
      // reader stays paused, so it never sees the server's FIN and never emits 'close'.
      socket.resume();
      socket.write(
        'POST /api/sessions HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${MAX_BODY_BYTES - 1}\r\n\r\n` +
          'A',
      );
      resolve(socket);
    });
    socket.on('error', () => resolve(socket));
  });
}

/** `GET /api/healthz` through the proxy, the same legitimate request the audit used. */
async function healthz(timeoutMs: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.status;
}

describe('a client that never finishes sending', () => {
  it('is disconnected rather than held for ever', async () => {
    const socket = await slowPost();
    const closed = new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), REQUEST_TIMEOUT_MS * 8).unref?.();
    });

    // Before: still open after 151 s having sent 29 body bytes.
    expect(await closed).toBe(true);
    socket.destroy();
  });

  it('cannot take the whole /api surface down by holding the upstream pool', async () => {
    // 129 is the measured threshold: 120 answered in 11 ms, 129 was a total outage.
    const sockets = await Promise.all(Array.from({ length: 129 }, slowPost));
    try {
      // Generous relative to the 500 ms bound, tight relative to "never".
      await expect(healthz(REQUEST_TIMEOUT_MS * 10)).resolves.toBe(200);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 20_000);
});

/**
 * Raw request/response, because a declared `Content-Length` that the sender does not honour is
 * precisely the case an HTTP client library refuses to construct — and it is the case here.
 */
function rawRequest(head: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    let response = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head + body));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });
    socket.on('close', () => resolve(response));
    socket.on('error', () => resolve(response));
    setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS * 6).unref?.();
  });
}

describe('a body larger than the BFF will carry', () => {
  it('is refused before the upstream is contacted', async () => {
    const response = await rawRequest(
      'POST /api/sessions HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'X-Probe: oversize\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${100 * 1024 * 1024}\r\n\r\n`,
      'x'.repeat(1_024),
    );

    expect(response.split('\r\n')[0]).toContain('413');
    // Before: the backend received all 104,857,600 bytes, in 0.9 s, with no credential.
    expect(bytesFor('oversize')).toEqual([]);
  });

  it('is cut off mid-stream when it arrives chunked, with no length to check', async () => {
    const chunk = 'x'.repeat(1_024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i += 1) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

    const status = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-probe': 'chunked' },
      body,
      // @ts-expect-error -- undici requires duplex for a streaming body
      duplex: 'half',
    }).then(
      (res) => res.status,
      () => 0,
    );

    // Before: 200, with all 65,536 bytes delivered — `content-length` is absent on a chunked
    // upload, so the declared-length check above cannot see this one at all.
    expect(status).not.toBe(200);
    for (const bytes of bytesFor('chunked')) {
      expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES + chunk.length);
    }
  });
});
