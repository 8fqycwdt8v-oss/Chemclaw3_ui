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

/**
 * Set once, on SIGTERM, and never cleared: this pod is going away.
 *
 * Readiness is where the drain belongs because readiness is the question it answers — "may a load
 * balancer send this pod traffic?" — and the answer during a shutdown is no, whatever the upstream
 * says. Liveness stays 200 throughout, deliberately, for the reason this module's own docstring
 * gives: a draining pod is still serving the requests it already has, and a restart decision taken
 * against it would kill them.
 *
 * Checked before the probe rather than after it, so a shutdown costs the service nothing: a pod on
 * its way out has no business opening a fresh upstream connection every five seconds to ask a
 * question whose answer it is going to ignore.
 */
let draining = false;

/** Fail `/readyz` from now on. One-way — nothing here brings a pod back. */
export function beginDraining(): void {
  draining = true;
}

/**
 * The probe that is running right now, so N concurrent probes cost one upstream call.
 *
 * The cache alone does not do this and cannot: it is written when a probe *resolves*, so every
 * request that arrives while one is in flight misses it and starts another. Measured against a
 * `/readyz` that takes 120 ms — a realistic figure for a check that touches a database and a
 * connector — 40 concurrent probes produced **40** upstream requests. That is the shape of a
 * readiness storm: a rolling restart, or a load balancer with several health-checking members,
 * turns the check into load on the very service it is asking about, precisely when it is least
 * able to take it.
 *
 * A single in-flight promise is the whole fix, and it is a `Promise` rather than a lock because
 * every waiter then gets the same answer instead of taking turns re-asking. Cleared in `finally`
 * so a rejected probe — `probe()` never rejects today, and this must not become the reason it
 * cannot — does not pin a poisoned promise for the life of the process.
 */
let inFlight: Promise<Readiness> | null = null;

/**
 * One credential-less GET against the upstream, resolving its status code (0 if unreachable).
 *
 * The single low-level request the two probes below share. No Authorization header is ever sent —
 * `/readyz` needs none, and the auth-posture probe's entire point is to arrive anonymous.
 */
function requestStatus(path: string): Promise<number> {
  const upstream = new URL(cfg.apiUrl);
  const transport = upstream.protocol === 'https:' ? https : http;

  return new Promise<number>((resolve) => {
    // Deliberately NOT the proxy's keep-alive agent: a probe must not queue behind the turn
    // stream that is holding every socket in that pool, or it would report a busy pod as a dead
    // one. `agent: false` gives this request a connection of its own.
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
        // The body is drained rather than read: the service's own reason is in its logs and on its
        // own route, and forwarding it here would republish an internal detail on a route that is
        // unauthenticated by design.
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
 * Is the backend still an auth boundary?
 *
 * The BFF forwards the browser's bearer verbatim and performs no verification of its own — which is
 * correct (no confused deputy), but it makes `CHEMCLAW_ENTRA_REQUIRED=true` on the *backend* the
 * only thing standing between an `msal` UI and anonymous access. A UI in `msal` mode pointed at a
 * backend still in its dev posture serves everyone with no token at all, and nothing in this
 * process could tell. So in `msal` mode readiness asks the one question that catches it: a
 * credential-less `GET /sessions` — a route that must be authenticated — should be refused with
 * 401 or 403. Any other answer (a 200 above all) means the backend is accepting anonymous callers
 * and this deployment's sign-in is a facade.
 *
 * Only a definite non-401/403 *response* flags it. A network error or timeout here is left to the
 * `/readyz` probe's own reachability verdict rather than being read as "anonymous accepted", so a
 * flaky backend cannot be mistaken for an open one.
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
  // The drain is one-way in a real process — there is no recovery from SIGTERM — but the flag is
  // module state, so a test that drains would otherwise leave every later test in this process
  // reading 503.
  draining = false;
}
