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
 *
 * Every wait ends on an event (a close or a status line), never on a window of wall time, and
 * a request that must be served goes to a listener with bounds no stall reaches: Node starts a
 * connection's first clock at accept and checks it on a sweep, so on a starved process a tight
 * bound answers a well-formed request 408 before reading it. Neither clock can be faked — the sweep
 * takes its timer from `node:timers` at load, and the deadline is libuv's.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

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
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

interface Listener {
  server: http.Server;
  port: number;
}

/**
 * A BFF over the stand-in upstream, with `env` on top of the shared settings. The BFF reads its
 * configuration once, at import, so each listener is a fresh import of the module graph.
 */
async function startBff(env: Record<string, string>): Promise<Listener> {
  const settings: Record<string, string> = {
    CHEMCLAW_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    MAX_BODY_BYTES: String(MAX_BODY_BYTES),
    CLIENT_DIR: '/nonexistent-client-dir',
    ...env,
  };
  for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
  vi.resetModules();
  try {
    const { createBffServer } = await import('../server/app.ts');
    const server = createBffServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  } finally {
    vi.unstubAllEnvs();
  }
}

const stop = ({ server }: Listener): Promise<void> =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/**
 * The status codes of every response in a raw HTTP/1.1 byte stream, read from the status lines.
 *
 * Never a scan of the whole response for a code: every response carries
 * `x-chemclaw-correlation-id`, a uuid4 with the dashes taken out, whose index 12 is a fixed `4`, so
 * `408` turns up in about 1% of correct responses' ids (2% across the keep-alive case's two).
 */
const statuses = (response: string): number[] =>
  [...response.matchAll(/^HTTP\/1\.1 (\d{3})\b/gm)].map((match) => Number(match[1]));

/**
 * One raw connection: what it was sent back, and its close, both as events. Raw, because a
 * declared `Content-Length` the sender does not honour is precisely the request an HTTP client
 * library refuses to construct — and it is the case here.
 */
class Raw {
  readonly socket: net.Socket;
  readonly closed: Promise<void>;
  received = '';
  private readonly changed = new Set<() => void>();

  private constructor(port: number) {
    this.socket = net.connect(port, '127.0.0.1');
    // Read the response, or do not expect to notice the disconnection: a `net.Socket` with no
    // reader stays paused, so it never sees the server's FIN and never emits 'close'.
    this.socket.on('data', (chunk: Buffer) => {
      this.received += chunk.toString();
      for (const wake of this.changed) wake();
    });
    this.socket.on('error', () => this.socket.destroy());
    this.closed = new Promise<void>((resolve) => this.socket.on('close', () => resolve()));
    void this.closed.then(() => {
      for (const wake of this.changed) wake();
    });
  }

  /** Connected (or failed to), with `request` written. */
  static open(port: number, request = ''): Promise<Raw> {
    const raw = new Raw(port);
    return new Promise((resolve) => {
      raw.socket.on('connect', () => {
        if (request) raw.socket.write(request);
        resolve(raw);
      });
      void raw.closed.then(() => resolve(raw));
    });
  }

  /** The status codes once `count` responses have begun, or the connection has closed. */
  responses(count: number): Promise<number[]> {
    return new Promise((resolve) => {
      const check = (): void => {
        const seen = statuses(this.received);
        if (seen.length < count && !this.socket.destroyed) return;
        this.changed.delete(check);
        resolve(seen);
      };
      this.changed.add(check);
      check();
    });
  }
}

/**
 * A POST that announces a body it is entitled to send, sends one byte of it, and stops — the
 * cheapest way to hold a connection, and the shape of the measured outage. The declared length
 * sits *under* the body cap on purpose: this is the request the cap cannot refuse.
 */
const SLOW_POST =
  'POST /api/sessions HTTP/1.1\r\n' +
  'Host: 127.0.0.1\r\n' +
  'Content-Type: application/json\r\n' +
  `Content-Length: ${MAX_BODY_BYTES - 1}\r\n\r\n` +
  'A';

const GET_HEALTHZ = 'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';

describe('a client that never finishes sending', () => {
  let tight: Listener;
  let loose: Listener;
  beforeAll(async () => {
    tight = await startBff({ REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS) });
    loose = await startBff({});
  });
  afterAll(async () => {
    await stop(tight);
    await stop(loose);
  });

  it('is disconnected rather than held for ever', async () => {
    // Before: still open after 151 s having sent 29 body bytes. "For ever" is this test's
    // timeout: the wait is for the close itself, however late a loaded machine runs the sweep.
    const slow = await Raw.open(tight.port, SLOW_POST);
    await slow.closed;
    expect(statuses(slow.received)).toEqual([408]);
  }, 20_000);

  it('cannot take the whole /api surface down by holding the upstream pool', async () => {
    // 129 is the measured threshold: 120 answered in 11 ms, 129 was a total outage. Held on a
    // listener whose request bound no test reaches, so every one of them is still in flight when
    // the probe is answered: the upstream pool has room for ordinary calls beside them.
    const slow = await Promise.all(
      Array.from({ length: 129 }, () => Raw.open(loose.port, SLOW_POST)),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${loose.port}/api/healthz`);
      expect(res.status).toBe(200);
      expect(slow.filter((raw) => raw.socket.destroyed).length).toBe(0);
    } finally {
      for (const raw of slow) raw.socket.destroy();
    }
  }, 20_000);
});

describe('a body larger than the BFF will carry', () => {
  let loose: Listener;
  beforeAll(async () => {
    loose = await startBff({});
  });
  afterAll(() => stop(loose));

  it('is refused before the upstream is contacted', async () => {
    const oversize = await Raw.open(
      loose.port,
      'POST /api/sessions HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'X-Probe: oversize\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${100 * 1024 * 1024}\r\n\r\n` +
        'x'.repeat(1_024),
    );

    expect(await oversize.responses(1)).toEqual([413]);
    await oversize.closed;
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

    const status = await fetch(`http://127.0.0.1:${loose.port}/api/sessions`, {
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

/**
 * The header phase, and the connection count: the two socket-level bounds the process now sets for
 * itself.
 *
 * `headersTimeout` was pinned at 125 s "just above the LB idle timeout", which is only a reason if
 * the timer starts when the SOCKET is accepted. It did, up to Node 14.11. It starts at the first
 * byte of the request now, so the pin was buying nothing and costing the header phase a bound 250×
 * looser than it needs — a request line and no more held a connection for two minutes, free.
 *
 * Listeners of their own, because the whole question here is what the header bound does when it is
 * much *tighter* than the request bound.
 */
describe('the header phase and the connection count', () => {
  const HEADERS_TIMEOUT_MS = 500;
  /** Forty times the header bound: a test that confuses the two would have to wait for it. */
  const REQUEST_TIMEOUT_MS_LOOSE = 20_000;
  const MAX_CONNECTIONS = 4;

  let headers: Listener;
  let ceiling: Listener;
  beforeAll(async () => {
    headers = await startBff({
      HEADERS_TIMEOUT_MS: String(HEADERS_TIMEOUT_MS),
      REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS_LOOSE),
    });
    // The ceiling alone: held connections that send nothing must outlast the test, so no tight
    // bound may sweep them away and make room.
    ceiling = await startBff({ MAX_CONNECTIONS: String(MAX_CONNECTIONS) });
  });
  afterAll(async () => {
    await stop(headers);
    await stop(ceiling);
  });

  it('cuts a request whose headers never arrive, long before the request timeout', async () => {
    // A request line and then silence — sixteen bytes, and under the old pin it held a connection
    // for 125 s. Now it is bounded by the header timeout plus one sweep, and the sweep is derived
    // from the *tighter* of the two bounds precisely so it does not become the bound itself.
    const startedAt = Date.now();
    const partial = await Raw.open(headers.port, 'GET /healthz HTTP/1.1\r\n');
    await partial.closed;

    expect(statuses(partial.received)).toEqual([408]);
    // Only the request bound could have cut it at or after this, and only a stall as long as the
    // bound itself could delay the header cut that far.
    expect(Date.now() - startedAt).toBeLessThan(REQUEST_TIMEOUT_MS_LOOSE);
  }, 30_000);

  it('still serves a keep-alive connection idled far past the header timeout', async () => {
    // This one passes before the change as well, and it is here for what it pins rather than for
    // what it catches: the whole justification for lowering the bound is that the timer starts at
    // the first byte of the REQUEST and not at the accept, which is a property of the runtime and
    // not of this repository. A Node that went back to connection-based timing would serve the
    // first request, then kill the second — and the comment in `config.ts` would be wrong again
    // with nothing to say so.
    const request = 'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n';
    let kept = await Raw.open(headers.port, request);
    // A connection's FIRST clock does start at accept, so a starved process can cut that request
    // before reading it: the bound at work, not the property here. A fresh connection then.
    while ((await kept.responses(1))[0] !== 200) {
      kept.socket.destroy();
      kept = await Raw.open(headers.port, request);
    }
    try {
      // Three times the header bound, and well inside the 120 s keep-alive.
      await new Promise((r) => setTimeout(r, HEADERS_TIMEOUT_MS * 3));
      kept.socket.write(request);
      expect(await kept.responses(2)).toEqual([200, 200]);
    } finally {
      kept.socket.destroy();
    }
  }, 20_000);

  it('sheds a connection over the ceiling instead of holding it', async () => {
    // Nothing bounded concurrent client connections, so the pod's worst-case descriptor and buffer
    // use was whatever a caller decided to open. What this does NOT buy is stated in `config.ts`:
    // running out of descriptors at accept() is silent on this runtime rather than fatal, so the
    // value here is a ceiling this process picked, not a crash avoided.
    const { server, port } = ceiling;
    const connections = promisify(server.getConnections.bind(server));
    const accepted: Promise<void>[] = [];
    const allAccepted = new Promise<void>((resolve) => {
      const onConnection = (socket: net.Socket): void => {
        accepted.push(new Promise((closed) => socket.on('close', () => closed())));
        if (accepted.length < MAX_CONNECTIONS) return;
        server.off('connection', onConnection);
        resolve();
      };
      server.on('connection', onConnection);
    });
    const held: Raw[] = [];
    for (let i = 0; i < MAX_CONNECTIONS; i += 1) held.push(await Raw.open(port));
    await allAccepted;
    expect(await connections()).toBe(MAX_CONNECTIONS);

    try {
      // Before: served 200 like any other request, and the count kept climbing. Either way the
      // connection closes (dropped, or `Connection: close` after the answer), so that is the wait.
      const over = await Raw.open(port, GET_HEALTHZ);
      await over.closed;
      expect(over.received).toBe('');
    } finally {
      for (const raw of held) raw.socket.destroy();
    }

    // And it comes back on its own once those connections are gone: shedding is not a latch.
    await Promise.all(accepted);
    const after = await Raw.open(port, GET_HEALTHZ);
    expect(await after.responses(1)).toEqual([200]);
  }, 20_000);
});
