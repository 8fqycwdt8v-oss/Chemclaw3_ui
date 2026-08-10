// @vitest-environment node
/**
 * The framing headers, which MSAL's silent token renewal depends on.
 *
 * `acquireTokenSilent` opens a hidden iframe to Entra, and Entra redirects that iframe back to
 * `redirectUri` — `${origin}/auth/callback`, served by this BFF as the SPA fallback. So the app
 * frames itself, and a policy of `frame-ancestors 'none'` plus `X-Frame-Options: DENY` forbids
 * that: the callback document never renders, MSAL never reads the fragment, and the token quietly
 * stops being renewable about an hour after login.
 *
 * Nothing caught it because the e2e suite runs in dev auth mode, which takes neither branch —
 * ISSUES.md records that a real MSAL redirect has never been exercised against this router.
 *
 * These assertions pin both directions: same-origin framing must be permitted so renewal works,
 * and cross-origin framing must still be refused so the clickjacking protection is intact.
 */

import { describe, expect, it, vi } from 'vitest';

async function cspFor(mode: string): Promise<string> {
  process.env.AUTH_MODE = mode;
  if (mode === 'msal') {
    process.env.ENTRA_TENANT_ID = 'tenant';
    process.env.ENTRA_CLIENT_ID = 'client';
    process.env.API_SCOPE = 'api://x/Chat.Access';
  }
  vi.resetModules();
  const { cfg } = await import('../server/config.ts');
  return cfg.csp;
}

describe('frame-ancestors', () => {
  it("permits same-origin framing in msal mode, so MSAL's renewal iframe can load", async () => {
    const csp = await cspFor('msal');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it('still refuses cross-origin framing in msal mode', async () => {
    const csp = await cspFor('msal');
    const directive = csp.split('; ').find((d) => d.startsWith('frame-ancestors'));
    expect(directive).toBe("frame-ancestors 'self'");
    expect(directive).not.toContain('*');
  });

  it('allows the preview iframe in dev mode', async () => {
    expect(await cspFor('dev')).toContain('frame-ancestors *');
  });

  it('still allows the outbound iframe to Entra in msal mode', async () => {
    // frame-src governs where *we* may frame to; it was never the blocking directive, and the
    // fix must not disturb it.
    expect(await cspFor('msal')).toContain('frame-src https://login.microsoftonline.com');
  });
});
