// @vitest-environment node

/**
 * A request whose session ended before the proxy started it is answered and never sent.
 *
 * Driven at `proxy()` with a hand-made credential, because the window is the few milliseconds
 * between a bearer being resolved and the request going out, which a real session cannot be made to
 * hit on demand. What the failure used to be: the 401 was written, the request went upstream
 * anyway, and its answer was written to the ended response — `ERR_HTTP_HEADERS_SENT`, which
 * `server/index.ts` rightly treats as fatal for the whole process.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uncaught: Error[] = [];
const collect = (error: Error): void => {
  uncaught.push(error);
};

afterEach(() => {
  process.off('uncaughtException', collect);
  uncaught.length = 0;
});

async function rig(
  credential: (end: () => void) => Record<string, unknown>,
  body: string | undefined,
  upstreamStatus = 200,
): Promise<{ status: number; reached: string[]; text: string; stop: () => Promise<void> }> {
  const reached: string[] = [];
  const upstream = http.createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.writeHead(upstreamStatus, { 'content-type': 'text/plain' });
    res.end('upstream answer');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  vi.resetModules();
  process.env.CHEMCLAW_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const { proxy } = await import('../server/proxy.ts');
  const front = http.createServer((req, res) => {
    proxy(
      req,
      res,
      '/attachments',
      false,
      { route: '/api/attachments', upstreamMs: null, correlationId: 'c' },
      1_000,
      {
        bearer: 'b',
        renew: () => Promise.resolve(null),
        replayable: false,
        touch: () => undefined,
        touchEveryMs: 60_000,
        endedSetCookie: 'chemclaw_session=; Path=/; Max-Age=0',
        ...credential(() => undefined),
      } as never,
    );
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  process.on('uncaughtException', collect);
  const res = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/`, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  // Time for a request that was wrongly sent to arrive, and for its answer to be (wrongly) written.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    status: res.status,
    reached,
    text,
    stop: async () => {
      front.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => front.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    },
  };
}

describe('a session that is already gone when the request is about to start', () => {
  it('is told session_expired, with the cookie cleared, and nothing goes upstream', async () => {
    const out = await rig(() => ({ watch: () => null }), 'hello');
    try {
      expect(out.status).toBe(401);
      expect(JSON.parse(out.text)).toMatchObject({ code: 'session_expired' });
      expect(out.reached).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      await out.stop();
    }
  });

  it('is not sent even when the session ends inside the registration itself', async () => {
    // The end fires during `watch`, before it returns: the response is complete by the time the
    // request would be built.
    const out = await rig(
      () => ({
        watch: (end: () => void) => {
          end();
          return () => undefined;
        },
      }),
      'hello',
    );
    try {
      expect(out.status).toBe(401);
      expect(out.reached).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      await out.stop();
    }
  });
});

describe('a failure inside a request’s own handlers', () => {
  it('ends that request and does not escape as an uncaught exception', async () => {
    // The service refuses the bearer; renewing it throws instead of answering. That is this
    // request's failure, not the process's.
    const attempt = rig(
      () => ({
        replayable: true,
        renew: () => {
          throw new Error('renewal blew up');
        },
        watch: () => () => undefined,
      }),
      'x',
      401,
    );
    // The connection is cut, so the client sees an error rather than an answer.
    await attempt.then(
      async (out) => out.stop(),
      () => undefined,
    );
    expect(uncaught).toEqual([]);
  });
});
