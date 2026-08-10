// @vitest-environment node
/**
 * The BFF proxy's failure and heartbeat paths.
 *
 * Both cases here are ones a healthy backend will not produce on demand, and neither was covered:
 * `server/` had no tests but the route whitelist.
 *
 * The first is an upstream that dies *after* its response headers. That error arrives on the
 * response, not the request, and `.pipe()` does not forward it — so the client response was left
 * open forever with no error and no log line. A turn stream stopped mid-sentence and the browser
 * went on waiting.
 *
 * The second is the heartbeat's frame-boundary check. It only writes `: hb` between frames, since
 * injecting mid-frame would corrupt the frame the client is assembling. Reading the boundary from
 * the current chunk alone cannot see a `\n\n` split across two chunks, so a stream whose last
 * chunk ended mid-frame suppressed its own heartbeat for the entire silence that followed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

/** Start the real proxy against `upstreamPort`, with env applied before the module is loaded. */
async function startBff(upstreamPort: number, env: Record<string, string> = {}): Promise<number> {
  Object.assign(process.env, { CHEMCLAW_API_URL: `http://127.0.0.1:${upstreamPort}`, ...env });
  vi.resetModules();
  const { proxy } = await import('../server/proxy.ts');
  return listen((req, res) => proxy(req, res, req.url ?? '/', true));
}

/** GET through the BFF; resolves with how the client response actually terminated. */
function get(port: number, path: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ port, path }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve('end'));
      res.on('error', (e: NodeJS.ErrnoException) => resolve(`error:${e.code}`));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve(`error:${e.code}`));
    setTimeout(() => {
      req.destroy();
      resolve('HUNG');
    }, timeoutMs);
  });
}

describe('an upstream that dies after its headers', () => {
  it('terminates the client response instead of leaving it open', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"type":"token","text":"partial"}\n\n');
      setTimeout(() => res.socket?.destroy(), 40);
    });
    const bff = await startBff(upstream);

    // Before the fix this resolved 'HUNG': nothing ever ended or destroyed the client response.
    expect(await get(bff, '/sessions/x/messages')).not.toBe('HUNG');
  });

  it('still answers 502 when the upstream fails before any headers', async () => {
    // The pre-headers path is the one `upstreamReq.on('error')` already covered; adding a handler
    // on the response must not disturb it.
    const bff = await startBff(1); // nothing is listening on port 1

    const status = await new Promise<number>((resolve) => {
      http.get({ port: bff, path: '/healthz' }, (res) => {
        res.on('data', () => {});
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(502);
  });
});

describe('the heartbeat frame-boundary check', () => {
  it('sees a frame terminator split across two chunks', async () => {
    // The frame's two closing newlines are written in separate chunks, so neither chunk on its own
    // ends in `\n\n`. The stream then goes silent, which is when the heartbeat must fire.
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"type":"token","text":"hi"}\n');
      setTimeout(() => res.write('\n'), 20);
    });
    const bff = await startBff(upstream, { SSE_HEARTBEAT_MS: '80' });

    const body = await new Promise<string>((resolve) => {
      let acc = '';
      const req = http.get({ port: bff, path: '/sessions/x/messages' }, (res) => {
        res.on('data', (c: Buffer) => {
          acc += c.toString();
        });
      });
      setTimeout(() => {
        req.destroy();
        resolve(acc);
      }, 500);
    });

    expect(body).toContain(': hb');
  });
});
