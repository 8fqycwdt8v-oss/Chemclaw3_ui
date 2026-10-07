/**
 * `GET /readyz`: "this pod can serve", which requires the Chemclaw service. `/healthz` stays a
 * literal liveness answer (restarting the UI because the backend died helps nobody). Cached for
 * `PROBE_CACHE_MS`, like the service's own `/readyz`.
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

/**
 * Set on SIGTERM and never cleared: readiness answers 503 while draining (liveness stays 200).
 * Checked before probing, so a draining pod sends no upstream probes.
 */
let draining = false;

/** Fail `/readyz` from now on. One-way — nothing here brings a pod back. */
export function beginDraining(): void {
  draining = true;
}

/**
 * The probe in flight, so concurrent probes share one upstream call (the cache only helps after one
 * resolves). Cleared in `finally`.
 */
let inFlight: Promise<Readiness> | null = null;

/** One credential-less GET against the upstream, resolving its status (0 if unreachable). */
function requestStatus(path: string): Promise<number> {
  const upstream = new URL(cfg.apiUrl);
  const transport = upstream.protocol === 'https:' ? https : http;

  return new Promise<number>((resolve) => {
    // `agent: false`: a probe must not queue behind streams holding the proxy's pool.
    const req = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path,
        headers: { host: upstream.host, accept: 'application/json' },
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The body is drained, not forwarded: this route is unauthenticated.
        res.resume();
        resolve(status);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end();
  });
}

/**
 * Under `msal`, check the backend is still an auth boundary: an anonymous `GET /sessions` must be
 * refused (401/403). Any other response means it accepts anonymous callers, so the pod is not
 * ready. A network error is left to the reachability check.
 */
async function upstreamAcceptsAnonymous(): Promise<boolean> {
  const status = await requestStatus('/sessions');
  return status !== 0 && status !== 401 && status !== 403;
}

async function probe(): Promise<Readiness> {
  const status = await requestStatus('/readyz');
  if (status < 200 || status >= 300) {
    return {
      ready: false,
      upstreamStatus: status,
      detail: status === 0 ? 'upstream unreachable' : 'upstream not ready',
    };
  }

  // The backend is up. In `msal` mode, also insist it is still enforcing identity — otherwise a
  // pod that answers `/readyz` happily is serving every `/api` route to anyone who can reach it.
  if (cfg.authMode === 'msal' && (await upstreamAcceptsAnonymous())) {
    return { ready: false, upstreamStatus: status, detail: 'upstream accepts anonymous' };
  }

  return { ready: true, upstreamStatus: status, detail: '' };
}

/** Readiness now: from cache when it is fresh, from the probe already running when it is not. */
export async function readiness(): Promise<Readiness> {
  // Ahead of the cache too, or a value stamped `ready` seconds before the signal would keep this
  // pod in rotation for the rest of its cache window — the whole drain, on the shipped numbers.
  if (draining) return { ready: false, upstreamStatus: 0, detail: 'draining' };
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  inFlight ??= probe()
    .then((value) => {
      // Stamped when the answer arrives rather than when the probe started, so the cache window
      // is time the answer has actually been stale for.
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam: the cache is process-wide, so a second test would read the first one's answer. */
export function clearReadinessCache(): void {
  cached = null;
  // Test seam: reset the drain flag.
  draining = false;
}
