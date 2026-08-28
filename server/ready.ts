/**
 * `GET /readyz` — readiness, meaning "this pod can serve", not "this process is running".
 *
 * `/healthz` answers `{"status":"ok"}` from a string literal and has never touched the upstream,
 * which is correct for a *liveness* probe and useless as a readiness one: the BFF reported healthy
 * with the Chemclaw service entirely gone, because the only thing it was asserting was that
 * `node:http` could still write a response. Everything this process is for — the whole `/api`
 * surface — is the service's, so a BFF that cannot reach it is not ready.
 *
 * Liveness stays where it is and stays hardcoded, deliberately: restarting this container because
 * the *backend* died would take away the one thing still able to explain the outage to a chemist,
 * and it would come back no more ready than it went down. This route is what a readiness probe and
 * a load balancer should read; `/healthz` is what a restart decision should read.
 *
 * The result is cached for `PROBE_CACHE_MS`, matching the posture of the service's own `/readyz`
 * (which caches its database and connector probes for the same reason): a probe every second from
 * every replica turns a readiness check into load of its own.
 */

import http from 'node:http';
import https from 'node:https';
import { cfg } from './config.ts';

/** Long enough to stop a probe storm, short enough that a recovery is noticed within a cycle. */
const PROBE_CACHE_MS = 5_000;

/** A readiness probe that hangs is a readiness probe that fails; this is the whole budget. */
const PROBE_TIMEOUT_MS = 2_000;

export interface Readiness {
  ready: boolean;
  /** The upstream's status code, or 0 when it could not be reached at all. */
  upstreamStatus: number;
  /** Why it is not ready, in one word an operator can grep. Empty when it is. */
  detail: string;
}

let cached: { at: number; value: Readiness } | null = null;

function probe(): Promise<Readiness> {
  const upstream = new URL(cfg.apiUrl);
  const transport = upstream.protocol === 'https:' ? https : http;

  return new Promise<Readiness>((resolve) => {
    // Deliberately NOT the proxy's keep-alive agent: a probe must not queue behind the turn
    // stream that is holding every socket in that pool, or it would report a busy pod as a dead
    // one. `agent: false` gives this request a connection of its own.
    const req = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: '/readyz',
        headers: { host: upstream.host, accept: 'application/json' },
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The body is drained rather than read: the service's own reason is in its logs and on its
        // own route, and forwarding it here would republish an internal detail on a route that is
        // unauthenticated by design.
        res.resume();
        resolve({
          ready: status >= 200 && status < 300,
          upstreamStatus: status,
          detail: status >= 200 && status < 300 ? '' : 'upstream not ready',
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () =>
      resolve({ ready: false, upstreamStatus: 0, detail: 'upstream unreachable' }),
    );
    req.end();
  });
}

/** Readiness now, from cache when it is fresh. */
export async function readiness(): Promise<Readiness> {
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  const value = await probe();
  cached = { at: Date.now(), value };
  return value;
}

/** Test seam: the cache is process-wide, so a second test would read the first one's answer. */
export function clearReadinessCache(): void {
  cached = null;
}
