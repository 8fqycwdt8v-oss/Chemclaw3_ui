/**
 * A front door for `e2e/oidc-mock.spec.ts`: validate the bearer the BFF forwards, then pass the
 * request on to `e2e/fixture-service.ts`.
 *
 * **What it stands in for.** Chemclaw3's `api/auth.py::validate_token`, which this lane cannot run
 * (core is Linux-only and needs Postgres). The checks are the same four, in the same posture:
 * RS256 only, the signature against the key the tenant's JWKS publishes for the token's `kid`,
 * `aud` equal to the configured audience (the confused-deputy guard), `iss` equal to the configured
 * issuer, and `exp` *required* — plus a non-empty `oid`, which core refuses a token without. A
 * request that fails any of them is a 401, as there, so a token the browser obtained but the
 * service would refuse fails the spec rather than passing it.
 *
 * **What it proves that the page alone cannot.** The page can show that MSAL signed someone in and
 * that it put a bearer on `/api/...`. Only something on the far side of the BFF can show the token
 * *arrived*, intact, and is one a resource server accepts. `GET /__oidc/seen` — on this port, not
 * through the BFF, which would refuse an unlisted route anyway — answers who it has seen.
 *
 *   node --experimental-strip-types e2e/oidc-upstream.ts <port> <fixture-port>
 *
 * Configured by environment: `OIDC_JWKS_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_CA_FILE`
 * (the mock tenant's self-signed certificate, trusted for the JWKS fetch and nothing else).
 */

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { get as httpsGet } from 'node:https';

const port = Number(process.argv[2] ?? 4343);
const fixturePort = Number(process.argv[3] ?? 4342);
const jwksUrl = process.env.OIDC_JWKS_URL ?? '';
const issuer = process.env.OIDC_ISSUER ?? '';
const audience = process.env.OIDC_AUDIENCE ?? 'api://chemclaw';
const ca = process.env.OIDC_CA_FILE ? readFileSync(process.env.OIDC_CA_FILE) : undefined;

interface Seen {
  oid: string;
  upn: string;
  roles: string[];
  path: string;
}
const seen: Seen[] = [];
const refused: { path: string; reason: string }[] = [];

function fetchJwks(): Promise<{ keys: (JsonWebKey & { kid: string })[] }> {
  return new Promise((resolve, reject) => {
    httpsGet(jwksUrl, { ca }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error as Error);
        }
      });
    }).on('error', reject);
  });
}

const b64url = (part: string): Buffer => Buffer.from(part, 'base64url');

/** The claims of a token core would accept, or the reason it would not. */
async function validate(token: string): Promise<Record<string, unknown> | string> {
  const parts = token.split('.');
  if (parts.length !== 3) return 'not a JWT';
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(b64url(headerPart).toString()) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') return `alg ${header.alg} is not RS256`;
  const jwk = (await fetchJwks()).keys.find((key) => key.kid === header.kid);
  if (!jwk) return `no published key for kid ${header.kid}`;
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    b64url(signaturePart),
  );
  if (!ok) return 'bad signature';
  const claims = JSON.parse(b64url(payloadPart).toString()) as Record<string, unknown>;
  if (claims.aud !== audience) return `aud ${String(claims.aud)} is not ${audience}`;
  if (claims.iss !== issuer) return `iss ${String(claims.iss)} is not ${issuer}`;
  if (typeof claims.exp !== 'number') return 'no exp';
  if (claims.exp * 1000 < Date.now()) return 'expired';
  if (typeof claims.oid !== 'string' || !claims.oid.trim()) return 'no oid';
  return claims;
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path === '/__oidc/seen') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seen, refused }));
    return;
  }

  const forward = () => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: fixturePort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };

  // Core answers its probes without a credential, and so does this — the BFF's `/readyz` calls them.
  if (path === '/healthz' || path === '/readyz') return forward();

  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const deny = (reason: string) => {
    refused.push({ path, reason });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: reason }));
  };
  if (!token) return deny('no bearer token');
  validate(token).then(
    (result) => {
      if (typeof result === 'string') return deny(result);
      seen.push({
        oid: String(result.oid),
        upn: String(result.preferred_username ?? ''),
        roles: Array.isArray(result.roles) ? result.roles.map(String) : [],
        path,
      });
      forward();
    },
    (error: Error) => deny(`validation failed: ${error.message}`),
  );
}).listen(port, '127.0.0.1');
