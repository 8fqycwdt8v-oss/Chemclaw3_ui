/**
 * Small header helpers shared by the proxy and the auth routes.
 *
 * These live here rather than in `proxy.ts` because the auth routes need the same answers — what
 * scheme the client used, what origin this deployment is reachable at — and the auth layer has no
 * business importing the proxy to get them.
 */

import type { IncomingMessage } from 'node:http';
import { cfg } from './config.ts';

/** The first value of a header that may arrive repeated. */
export function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Strip the IPv4-mapped IPv6 prefix, which most log pipelines do not normalise. */
export function normaliseAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * The scheme the client used to reach THIS proxy.
 *
 * Trusts an inbound `x-forwarded-proto` when present, because in the deployments that set it we
 * are not the edge; falls back to whether our own socket is TLS.
 */
export function clientProto(req: IncomingMessage): string {
  const forwarded = firstHeader(req.headers['x-forwarded-proto']);
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http';
}

/**
 * The origin this deployment is reachable at, as `https://host[:port]`.
 *
 * `PUBLIC_ORIGIN` wins when set, and setting it is what any real deployment should do: the
 * fallback below reads the `Host` header, which is client-supplied. That is survivable rather than
 * safe — the two places this value is used both have an independent check behind them. The OAuth
 * `redirect_uri` is compared by Entra against the registration's allow-list, so a forged host
 * produces AADSTS50011 rather than a redirect anywhere useful; and the CSRF origin check compares
 * the request's `Origin` against this, so an attacker who could set both would only be proving they
 * control their own headers, not that they hold the user's cookies.
 *
 * It is still worth configuring, because both failure modes are confusing rather than harmless.
 */
export function selfOrigin(req: IncomingMessage): string {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers.host) ?? '';
  return `${clientProto(req)}://${host}`;
}

/**
 * Whether cookies written for this request may carry `Secure` (and therefore the `__Host-` prefix).
 *
 * Tied to the scheme rather than to a setting: a `Secure` cookie is silently dropped by the browser
 * over plain HTTP, so hard-coding it on would break local development in a way that presents as
 * "sign-in does not stick" with nothing in any log.
 */
export const cookieSecure = (req: IncomingMessage): boolean => clientProto(req) === 'https';
