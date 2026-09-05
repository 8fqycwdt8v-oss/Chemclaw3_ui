/**
 * The id that joins one click to every record of it.
 *
 * It used to be read off the **upstream response** and nowhere else, so it existed only for
 * requests the service actually answered. Measured against a running BFF, every `/healthz`,
 * `/readyz` and `/config.js` access line carried `correlation_id: ""` — and so did every 502, 499,
 * 413 and `/api:blocked`, which is the whole population during an outage. That is precisely when
 * somebody needs to join a browser's `/api/client-events` report to the request that caused it, and
 * the browser stamps its entries with whatever id it was last told (`src/lib/logger.ts`), which
 * during an outage is nothing.
 *
 * So the front door mints one per request, and it travels three ways from here: into this process's
 * access line, onto the response so the browser can quote it back, and upstream in
 * `X-Chemclaw-Correlation-Id`.
 *
 * **Minted rather than adopted, and that is not a preference.** `server/proxy.ts` strips every
 * client-supplied `x-chemclaw-*` request header deliberately — a browser must not be able to name
 * itself with a header the system trusts elsewhere — so there is no inbound id to trust, and this
 * process is the first hop that can honestly issue one.
 *
 * The *shape* is chosen so the service will adopt it rather than replace it. Its
 * `_request_correlation_id` (`api/middleware.py` in Chemclaw3) takes an inbound id when it matches
 * `[A-Za-z0-9_-]{8,64}` and mints a `uuid4().hex` otherwise; a 32-character hex id therefore
 * arrives, is adopted, and comes back on the response — one id across both processes' access logs
 * and the service's `audit_events`, instead of two that a reader has to join by timestamp.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The header the Chemclaw service reads a correlation id from, and stamps its own onto.
 *
 * One spelling, used in both directions. `Chemclaw3-mcp` records what the second spelling costs:
 * a reader looking for `x-chemclaw-correlation` against a sender writing
 * `X-Chemclaw-Correlation-Id` bound an empty string on every request in that whole fleet, and it
 * was invisible because nothing consumed the value yet.
 */
export const CORRELATION_HEADER = 'x-chemclaw-correlation-id';

/** A fresh id for one request: `uuid4` hex, which is the shape the service adopts unchanged. */
export const mintCorrelationId = (): string => randomUUID().replaceAll('-', '');

/**
 * The correlation id an upstream response carries, or `''` when it carries none.
 *
 * The upstream's answer wins over the minted one wherever it exists: normally the two are the same
 * string (the service adopts what it was sent), and where they differ it is because something
 * between here and the service issued its own — in which case the id the *service* wrote into its
 * own records is the one worth quoting.
 */
export function correlationFrom(headers: IncomingHttpHeaders): string {
  const value = headers[CORRELATION_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}
