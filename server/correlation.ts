/**
 * The id that joins one click to every record of it.
 *
 * Minted per request at the front door, so it exists even for `/healthz`, `/config.js`, 5xx and
 * blocked requests; it goes to this process's access line, onto the response for the browser to
 * quote back, and upstream as `X-Chemclaw-Correlation-Id`. Minted, not adopted: `server/proxy.ts`
 * strips client `x-chemclaw-*` headers, so there is no inbound id to trust. A 32-char hex id
 * matches the service's adoption pattern (`[A-Za-z0-9_-]{8,64}` in `api/middleware.py`), so one id
 * spans both processes' logs and `audit_events`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The header the service reads a correlation id from and stamps its own onto; one spelling for both
 * directions.
 */
export const CORRELATION_HEADER = 'x-chemclaw-correlation-id';

/** A fresh id for one request: `uuid4` hex, which is the shape the service adopts unchanged. */
export const mintCorrelationId = (): string => randomUUID().replaceAll('-', '');

/**
 * The correlation id an upstream response carries, or `''`. It wins over the minted one: normally
 * they match, and where something in between issued its own, the service's recorded id is the one
 * worth quoting.
 */
export function correlationFrom(headers: IncomingHttpHeaders): string {
  const value = headers[CORRELATION_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}
