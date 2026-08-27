/**
 * The record this app did not keep.
 *
 * Before `src/lib/logger.ts` there was no client logger and no sink: a render error reached one
 * `console.error`, an unhandled rejection reached nothing at all, and every deliberate silent
 * catch recorded nothing anywhere. These tests pin the three things that make the new record
 * trustworthy rather than decorative — that the level is a runtime decision (a deployment's, and
 * support's, without a redeploy), that entries survive in the ring buffer for the crash screen,
 * and that the sink batches rather than posting per entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from './helpers.ts';

let restore: (() => void) | null = null;

/** A fresh module graph: `src/env.ts` and the logger both resolve their config at import. */
async function loadLogger(config: Record<string, unknown>, search = '') {
  window.__CHEMCLAW_CONFIG__ = config as never;
  window.history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  return import('../src/lib/logger.ts');
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  restore?.();
  restore = null;
  delete window.__CHEMCLAW_CONFIG__;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

describe('the level is a runtime decision', () => {
  it('drops what the configured level excludes and keeps what it admits', async () => {
    const { logger } = await loadLogger({ logLevel: 'warn' });
    logger.info('an.info');
    logger.warn('a.warning');
    expect(logger.snapshot().map((e) => e.message)).toEqual(['a.warning']);
  });

  it('records nothing at all under `silent`', async () => {
    const { logger } = await loadLogger({ logLevel: 'silent' });
    logger.error('an.error');
    expect(logger.snapshot()).toEqual([]);
  });

  it('lets ?debug=1 raise one browser without a redeploy, and remembers it across a reload', async () => {
    // The support case this exists for: one chemist is seeing it, and turning the whole
    // deployment verbose to find out why is not an option.
    const first = await loadLogger({ logLevel: 'info' }, '?debug=1');
    expect(first.logger.level()).toBe('debug');

    // The flag is gone from the URL on the next page load; the override is not.
    const second = await loadLogger({ logLevel: 'info' });
    expect(second.logger.level()).toBe('debug');

    // And `?debug=0` gives the deployment's own setting back.
    const third = await loadLogger({ logLevel: 'info' }, '?debug=0');
    expect(third.logger.level()).toBe('info');
  });
});

describe('what an entry carries', () => {
  it('stamps the turn and session the caller is in, so a line can be joined to the service', async () => {
    const { logger } = await loadLogger({ logLevel: 'info' });
    logger.setContext({ correlationId: 'corr-1', sessionId: 'sess-1' });
    logger.info('turn.timing', { totalMs: 12 });

    expect(logger.snapshot()[0]).toMatchObject({
      message: 'turn.timing',
      correlationId: 'corr-1',
      sessionId: 'sess-1',
      context: { totalMs: 12 },
    });
  });

  it('hands the crash screen text carrying the version and the reference', async () => {
    const { logger, diagnosticsText } = await loadLogger({
      logLevel: 'info',
      appVersion: '1.2.3',
    });
    logger.setContext({ correlationId: 'corr-2' });
    logger.error('render.failed', { name: 'TypeError' });

    const text = diagnosticsText();
    expect(text).toContain('1.2.3');
    expect(text).toContain('corr-2');
    expect(text).toContain('render.failed');
  });
});

describe('the sink', () => {
  it('is not installed until the application starts it', async () => {
    // The reason it is explicit rather than automatic: otherwise every unit test in this
    // repository would issue background POSTs into whatever fetch stub it had installed.
    const stub = stubFetch(() => new Response(null, { status: 204 }));
    restore = stub.restore;
    const { logger } = await loadLogger({ logLevel: 'info' });
    logger.error('nobody.is.listening');
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.calls).toHaveLength(0);
  });

  it('batches rather than posting once per entry, and sends the envelope the BFF parses', async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }));
    restore = stub.restore;
    const { logger, startClientEventSink } = await loadLogger({
      logLevel: 'info',
      appVersion: '9.9.9',
      apiBase: '/api',
    });
    const stop = startClientEventSink();

    // Below the batch size, so nothing has been sent yet — the flush is on the stop below rather
    // than on a timer this test would have to wait out.
    for (let i = 0; i < 5; i += 1) logger.warn(`event.${i}`);
    expect(stub.calls).toHaveLength(0);

    stop();

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/client-events');
    const body = JSON.parse(String(stub.calls[0]?.init?.body)) as {
      app_version: string;
      entries: { message: string; level: string }[];
    };
    expect(body.app_version).toBe('9.9.9');
    expect(body.entries).toHaveLength(5);
    expect(body.entries[0]).toMatchObject({ message: 'event.0', level: 'warn' });
  });

  it('flushes early once a burst reaches the batch size', async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }));
    restore = stub.restore;
    const { logger, startClientEventSink } = await loadLogger({ logLevel: 'info' });
    const stop = startClientEventSink();

    for (let i = 0; i < 20; i += 1) logger.warn(`burst.${i}`);
    expect(stub.calls).toHaveLength(1);

    stop();
  });

  it('gives up after repeated sink failures rather than retrying a broken endpoint for ever', async () => {
    // A sink that hammers a dead endpoint is the defect this module exists to report, one layer
    // down — and it cannot log its own failure without recursing.
    const stub = stubFetch(() => new Response(null, { status: 500 }));
    restore = stub.restore;
    const { logger, startClientEventSink } = await loadLogger({ logLevel: 'info' });
    const stop = startClientEventSink();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (let i = 0; i < 20; i += 1) logger.warn('doomed');
      // Let the rejected/failed POST settle so the failure counter has moved on.
      await new Promise((r) => setTimeout(r, 5));
    }
    stop();

    // Three failures, and then it stops trying.
    expect(stub.calls.length).toBeLessThanOrEqual(4);
  });
});
