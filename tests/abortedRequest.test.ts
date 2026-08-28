// @vitest-environment node
//
// Node, not happy-dom: this aborts a real socket against a real `node:http` BFF.

/**
 * An aborted request must still be booked.
 *
 * A client disconnect fires `close` on the response, not `finish`. The access log and the metrics
 * were written only from `finish`, so an aborted request produced no log line at all and — worse —
 * never decremented `chemclaw_ui_requests_in_flight`, the gauge `requestStarted` had already bumped
 * up. That gauge is therefore monotonic and pumpable: open a request against a slow upstream, abort
 * it, repeat, and the pod reports an ever-growing backlog it is not actually carrying, while the
 * abort leaves no trace an operator could see. Both are booked on `close` now, as status 499.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let upstream: http.Server;
let bff: http.Server;
let port = 0;
let lines: string[] = [];

/** Open upstream responses we must release in teardown so the process can exit. */
const openResponses = new Set<http.ServerResponse>();

beforeAll(async () => {
  // A stub upstream that answers headers and then hangs, so the proxied request is genuinely
  // in-flight when the client aborts.
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{'); // one byte, so the response has started but is not finished
    openResponses.add(res);
    res.on('close', () => openResponses.delete(res));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  process.env.AUTH_MODE = 'dev';
  process.env.LOG_LEVEL = 'info';
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const res of openResponses) res.end();
  // Both servers hold keep-alive sockets (the proxy's upstream agent, fetch's own pool), so a
  // plain `close` waits for connections that will not close on their own. Drop them.
  bff.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
});

const metrics = async (): Promise<string> =>
  (await fetch(`http://127.0.0.1:${port}/metrics`)).text();

/** The parsed access line for `route`, or undefined. */
const accessLine = (route: string): Record<string, unknown> | undefined => {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.message === 'request' && (parsed.fields as { route?: string })?.route === route) {
        return parsed.fields as Record<string, unknown>;
      }
    } catch {
      /* not a JSON log line */
    }
  }
  return undefined;
};

/** Wait until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a client that aborts mid-response', () => {
  it('is booked as 499, logged, and returns the in-flight gauge to its floor', async () => {
    // The gauge before we start — other tests in the file may leave it at zero, but read it rather
    // than assume it.
    const before = /chemclaw_ui_requests_in_flight (\d+)/.exec(await metrics());
    const baseline = before ? Number(before[1]) : 0;
    lines = [];

    const controller = new AbortController();
    const inFlight = fetch(`http://127.0.0.1:${port}/api/notes/abcdef123456`, {
      signal: controller.signal,
    }).catch(() => undefined); // the abort rejects the fetch; that is expected

    // Let the request reach the upstream and the first byte come back, so it is truly in-flight.
    await until(() => openResponses.size > 0);
    controller.abort();
    await inFlight;

    // The BFF's response `close` handler settles the request as 499.
    await until(() => accessLine('/api/notes/{id}') !== undefined);
    const line = accessLine('/api/notes/{id}');
    expect(line).toBeDefined();
    expect(line?.status).toBe(499);

    // And the gauge came back down rather than leaking — the whole point.
    let gauge = Number.POSITIVE_INFINITY;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const m = /chemclaw_ui_requests_in_flight (\d+)/.exec(await metrics());
      gauge = m ? Number(m[1]) : gauge;
      if (gauge <= baseline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gauge).toBeLessThanOrEqual(baseline);
  });
});
