/**
 * A stand-in for Entra's authorize/token/logout endpoints, for end-to-end tests.
 *
 * `tests/bffAuthFlow.test.ts` already drives the same flow at the HTTP level, but it plays the
 * browser's part itself — it reads the redirect and calls `/auth/callback` directly. What it
 * therefore cannot prove is that a *real* browser completes the round trip: that it follows the
 * redirect chain, that it holds the `SameSite=Lax` login cookie across a cross-site navigation and
 * sends it back on the return leg, and that `src/auth/bffAuth.ts` then finds the user signed in.
 * Every one of those is a place this design could be wrong in a way no server-side test would see.
 *
 * The PKCE check here is real: the verifier presented at `/token` must hash to the challenge sent
 * to `/authorize`. A mock that skipped it would let the BFF stop sending a verifier entirely and
 * these tests would still pass.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_ENTRA_PORT ?? 8792);

/** code -> what the authorize leg promised, so the token leg can check it. */
const codes = new Map();
let counter = 0;

const readBody = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => resolve(text));
  });

/** An unsigned id_token. The BFF reads it without verifying — see `readIdToken`'s docstring. */
const idToken = (nonce) =>
  [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        oid: 'e2e-user-object-id',
        preferred_username: 'e2e@example.test',
        name: 'End To End',
        roles: [],
        nonce,
      }),
    ).toString('base64url'),
    'not-a-signature',
  ].join('.');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname.endsWith('/authorize')) {
    const q = url.searchParams;
    // The real Entra would show a sign-in page. There is no user to type a password here, so the
    // mock consents immediately — the browser behaviour under test is the redirect, not the form.
    const code = `code-${(counter += 1)}`;
    codes.set(code, {
      nonce: q.get('nonce'),
      challenge: q.get('code_challenge'),
      redirectUri: q.get('redirect_uri'),
    });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    res.writeHead(302, { location: back.toString() });
    res.end();
    return;
  }

  if (url.pathname.endsWith('/token')) {
    const form = new URLSearchParams(await readBody(req));
    const fail = (error, description) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error, error_description: description }));
    };

    let nonce = null;
    if (form.get('grant_type') === 'authorization_code') {
      const issued = codes.get(form.get('code'));
      if (!issued) return fail('invalid_grant', 'unknown code');
      // Single use, as a real authorization code is.
      codes.delete(form.get('code'));
      const digest = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (digest !== issued.challenge) return fail('invalid_grant', 'PKCE verifier mismatch');
      if (form.get('redirect_uri') !== issued.redirectUri) {
        return fail('invalid_grant', 'redirect_uri does not match the authorize request');
      }
      nonce = issued.nonce;
    }
    if (!form.get('client_secret')) return fail('invalid_client', 'no client secret presented');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
        // Long, so the proactive refresh does not fire during a test run and the assertions are
        // about the sign-in rather than about refresh timing.
        expires_in: 7200,
        id_token: idToken(nonce),
      }),
    );
    return;
  }

  if (url.pathname.endsWith('/logout')) {
    res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
    res.end();
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-entra listening on http://127.0.0.1:${PORT}`);
});
