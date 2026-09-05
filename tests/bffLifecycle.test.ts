// @vitest-environment node
//
// Node, and a real child process: everything under test here is `server/index.ts`, which exists to
// start, stop and refuse. None of it is reachable by importing a module — the shutdown is a signal
// handler, the listen failure is an event on a socket that could not bind, and the two process
// handlers only mean anything in a process that has installed them.

/**
 * What this process does at its edges: coming up, going down, and falling over.
 *
 * Three defects, each measured against a running BFF before it was fixed:
 *
 *  - **SIGTERM took the listening socket away immediately.** `server.close()` ran synchronously in
 *    the handler. Measured: SIGTERM at t=301 ms, `/readyz` answering 200 at t=204 ms,
 *    `UND_ERR_SOCKET` at t=306 ms, `ECONNREFUSED` from t=403 ms, exit 0 at t=314 ms. `/readyz`
 *    never returned one 503, so nothing told a load balancer to stop sending — and everything it
 *    sent in that window became a connection error a chemist reads as the app being broken.
 *  - **A server that could not listen printed a V8 stack.** Measured on a held port: twenty-odd
 *    unstructured lines and exit 1, with the JSON startup lines above them. A log query for
 *    `logger=chemclaw3-ui level=ERROR` found nothing at all about the one event that stopped the
 *    pod from serving.
 *  - **The same was true of any unhandled rejection or uncaught exception**, and Node treats both
 *    as fatal, so the least-explained failures were the fatal ones.
 *
 * The subprocess is driven with a real signal and real sockets because that is the only honest way
 * to ask these questions; the drain is turned down so a test does not wait ten seconds for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

const ENTRY = new URL('../server/index.ts', import.meta.url).pathname;

/** A stand-in Chemclaw service, so `/readyz` has something real to be ready about. */
let upstream: http.Server;
let upstreamUrl = '';

/** A port nothing is listening on, taken by binding one and letting it go. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Bff {
  /** stdin is `ignore`, so this is the shape `spawn` actually returns here. */
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Every JSON record the process wrote, in order. */
  records: Record<string, unknown>[];
  exit: Promise<number | null>;
}

/** Start `server/index.ts` as this repository ships it, collecting its log records. */
function startBff(env: Record<string, string>): Bff {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, CLIENT_DIR: '/nonexistent-client-dir', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const records: Record<string, unknown>[] = [];
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A raw stack is exactly what this file exists to assert the absence of; keeping it out of
        // `records` is what makes "there is a record" mean something.
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, records, exit };
}

/** Wait for a record matching `predicate`, or fail loudly with what did arrive. */
async function waitForRecord(
  bff: Bff,
  predicate: (r: Record<string, unknown>) => boolean,
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = bff.records.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no matching record; got ${JSON.stringify(bff.records)}`);
}

/** One probe: the status as text, or the transport error it died of. */
async function probe(port: number, path: string): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2_000),
    });
    return String(res.status);
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as Error).name;
  }
}

beforeAll(async () => {
  // Ready to everything: this file is about the shutdown, not about the upstream's own verdict.
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('SIGTERM', () => {
  it('fails readiness for a whole drain period before it stops listening', async () => {
    const DRAIN_MS = 1_500;
    const port = await freePort();
    const bff = startBff({
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      CHEMCLAW_API_URL: upstreamUrl,
      SHUTDOWN_DRAIN_MS: String(DRAIN_MS),
    });
    try {
      await waitForRecord(bff, (r) => r.message === 'listening');
      expect(await probe(port, '/readyz')).toBe('200');

      // Poll both probes across the whole shutdown, the way a kubelet and a load balancer do.
      const trace: { ms: number; ready: string; live: string }[] = [];
      const startedAt = Date.now();
      const polling = (async () => {
        while (Date.now() - startedAt < DRAIN_MS + 2_000) {
          const [ready, live] = await Promise.all([
            probe(port, '/readyz'),
            probe(port, '/healthz'),
          ]);
          trace.push({ ms: Date.now() - startedAt, ready, live });
          await new Promise((r) => setTimeout(r, 100));
        }
      })();

      bff.child.kill('SIGTERM');
      await polling;

      // The whole defect in one assertion: before this there was no 503 at all — `/readyz` went
      // from 200 to ECONNREFUSED inside ~100 ms, so no probe ever saw a refusal to act on.
      const refused = trace.filter((t) => t.ready === '503');
      expect(refused.length).toBeGreaterThan(0);

      // And liveness stayed up for every one of them. A draining pod is still serving the requests
      // it already has; failing liveness would have it restarted out from under them.
      for (const sample of refused) expect(sample.live).toBe('200');

      // Long enough for at least one readiness period, not a token pause.
      const firstRefusal = refused[0]?.ms ?? 0;
      const lastRefusal = refused.at(-1)?.ms ?? 0;
      expect(lastRefusal - firstRefusal).toBeGreaterThan(DRAIN_MS / 2);

      // Then it really does stop, rather than draining for ever.
      expect(await bff.exit).toBe(0);
      expect(await probe(port, '/healthz')).toBe('ECONNREFUSED');

      // Both halves said so in the log, in the same JSON shape as everything else.
      expect(bff.records.some((r) => r.message === 'draining')).toBe(true);
      expect(bff.records.some((r) => r.message === 'closing listener')).toBe(true);
    } finally {
      bff.child.kill('SIGKILL');
    }
  }, 20_000);

  it('names the drain in the readiness body, so a probe log says why', async () => {
    const port = await freePort();
    const bff = startBff({
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      CHEMCLAW_API_URL: upstreamUrl,
      SHUTDOWN_DRAIN_MS: '2000',
    });
    try {
      await waitForRecord(bff, (r) => r.message === 'listening');
      bff.child.kill('SIGTERM');
      await waitForRecord(bff, (r) => r.message === 'draining');

      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(503);
      // `upstream_status: 0` because a pod on its way out does not probe the service it is
      // leaving: the verdict is about this pod, not about the backend.
      expect(await res.json()).toEqual({
        status: 'degraded',
        upstream_status: 0,
        detail: 'draining',
      });
    } finally {
      bff.child.kill('SIGKILL');
    }
  }, 20_000);
});

describe('a server that cannot listen', () => {
  it('reports EADDRINUSE as a record rather than a stack, and exits 1', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as AddressInfo).port;
    const bff = startBff({
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      CHEMCLAW_API_URL: upstreamUrl,
    });
    try {
      // Before: `Error: listen EADDRINUSE` plus a V8 stack on stderr, so `records` — which holds
      // only parseable JSON — would be empty of it.
      const record = await waitForRecord(bff, (r) => r.message === 'server error');
      expect(record.level).toBe('ERROR');
      expect(record.logger).toBe('chemclaw3-ui');
      expect(record.fields).toMatchObject({
        code: 'EADDRINUSE',
        address: `127.0.0.1:${port}`,
      });
      expect(await bff.exit).toBe(1);
    } finally {
      bff.child.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 20_000);
});

/**
 * The two process-level nets.
 *
 * Driven by importing the entry point into a process that then throws, because that is what the
 * handlers are: properties of a process, not of a module. Node 22 already exits 1 on both — what
 * is under test is that the failure is *recorded* in the shape a log stack reads, which a raw
 * stack is not.
 */
describe('a failure nobody caught', () => {
  for (const [label, throwing] of [
    ['unhandled promise rejection', "Promise.reject(new Error('probe'));"],
    ['uncaught exception', "throw new Error('probe');"],
  ] as const) {
    it(`records the ${label} and exits 1`, async () => {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(ENTRY)});\nsetTimeout(() => { ${throwing} }, 300);`,
        ],
        {
          env: {
            ...process.env,
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            CLIENT_DIR: '/nonexistent-client-dir',
            CHEMCLAW_API_URL: upstreamUrl,
            LOG_LEVEL: 'info',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (c: Buffer) => (output += c.toString()));
      child.stderr.on('data', (c: Buffer) => (output += c.toString()));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

      const record = output
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .find((r) => r.message === label);

      expect(record?.level).toBe('ERROR');
      expect((record?.fields as { error?: string } | undefined)?.error).toBe('probe');
      expect(code).toBe(1);
    }, 20_000);
  }
});
