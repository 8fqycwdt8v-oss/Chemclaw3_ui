// @vitest-environment node
//
// Node, not happy-dom: this drives real POSTs against a real `node:http` BFF.

/**
 * `/api/client-events` is unauthenticated by design — it reports failures from before sign-in — so
 * a per-IP token bucket is the only thing bounding how fast one peer may fill this pod's log. The
 * bucket gives each address `CLIENT_EVENTS_RATE_PER_MIN` batches a minute with a matching burst,
 * and answers 429 once it is empty.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let bff: http.Server;
let port = 0;

beforeAll(async () => {
  vi.resetModules();
  // No upstream needed: this route is answered locally and never proxied.
  process.env.CHEMCLAW_API_URL = 'http://127.0.0.1:1';
  process.env.CLIENT_DIR = '/nonexistent-client-dir';
  process.env.AUTH_MODE = 'dev';
  process.env.LOG_LEVEL = 'error';
  // A low ceiling so the test crosses it in a handful of requests rather than sixty-one.
  process.env.CLIENT_EVENTS_RATE_PER_MIN = '3';
  const { createBffServer } = await import('../server/app.ts');
  bff = createBffServer();
  await new Promise<void>((resolve) => bff.listen(0, '127.0.0.1', resolve));
  port = (bff.address() as AddressInfo).port;
});

afterAll(async () => {
  bff.closeAllConnections();
  await new Promise<void>((resolve) => bff.close(() => resolve()));
});

const postBatch = (): Promise<number> =>
  fetch(`http://127.0.0.1:${port}/api/client-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [{ level: 'error', message: 'x' }] }),
  }).then((r) => r.status);

describe('the per-IP rate limit', () => {
  it('accepts up to the burst and then 429s the same address', async () => {
    const { resetClientEventsRateLimit } = await import('../server/clientEvents.ts');
    resetClientEventsRateLimit();

    // The first three (the configured ceiling) are accepted...
    expect(await postBatch()).toBe(204);
    expect(await postBatch()).toBe(204);
    expect(await postBatch()).toBe(204);
    // ...and the fourth, in the same instant from the same IP, is refused.
    expect(await postBatch()).toBe(429);
  });

  it('lets the same address through again once its bucket is reset', async () => {
    const { resetClientEventsRateLimit } = await import('../server/clientEvents.ts');
    resetClientEventsRateLimit();

    expect(await postBatch()).toBe(204);
  });
});
