import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BFF_PORT = Number(process.env.BFF_PORT ?? 8787);

/**
 * Whether this build may fall back to the no-token dev auth provider (`src/auth/index.ts`).
 *
 * Defaults to `false`, so an ordinary `npm run build` cannot produce a bundle that serves
 * unauthenticated access. A deployment that genuinely wants dev auth — `start.sh`, the compose
 * stack, the e2e suite — opts in with an env var, which is a greppable string in a tracked file
 * rather than an absent one.
 */
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === 'true';

/**
 * Where the client build lands.
 *
 * `dist/client` unless something asks otherwise, and the one thing that asks is the gate: its
 * `dev-auth-build` step builds the opt-in bundle the browser suite needs, and that build used to
 * overwrite `dist/client` with it. Nothing rebuilt it afterwards, so `npm run ci && npm start`
 * served a bundle carrying the no-token dev auth provider — driven: `node
 * scripts/assert-no-dev-auth.mjs` after a green gate named `dist/client/assets/devAuth-*.js`.
 * Two artifacts, two directories: the production one is never the one with dev auth in it.
 */
const CLIENT_OUT_DIR = process.env.CLIENT_OUT_DIR ?? 'dist/client';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // A literal, so the dev-auth branch is statically dead in a normal production build rather
    // than merely unreachable at runtime.
    __ALLOW_DEV_AUTH__: JSON.stringify(ALLOW_DEV_AUTH),
  },
  /**
   * The RDKit worker is an ES module, because that is how it is constructed.
   *
   * `rdkit.client.ts` writes `new Worker(new URL('./rdkit.worker.ts', import.meta.url), { type:
   * 'module' })` — the only form Vite compiles into an emitted chunk. Vite's default `worker.format`
   * is `iife`, which it emits **regardless** of that `type`, and the two disagreeing is quiet rather
   * than loud: an IIFE bundle happens to be valid module syntax, so the browser runs it, and what a
   * reader sees is a module-typed worker whose bundle is not one. Measured on this tree, the iife
   * build also inlined the whole 74 kB RDKit loader into the worker chunk rather than sharing the
   * dynamic one, because an IIFE has no import to split on.
   */
  worker: { format: 'es' },
  // `@/…` is what the vendored shadcn components import by. Mirrored in tsconfig.json and — the
  // one that gets forgotten — vitest.config.ts, which is a separate config with its own resolver.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: CLIENT_OUT_DIR,
    /**
     * Never inline a font into the stylesheet.
     *
     * Vite inlines any asset under 4 kB as a `data:` URI, and exactly one font face is under it:
     * `jetbrains-mono-cyrillic-ext` is 2,028 bytes, so it was emitted as a 2,727-character base64
     * blob **inside `index-*.css`** — the render-blocking stylesheet every visitor downloads
     * before the first paint. The point of `@fontsource-variable`'s per-unicode-range faces is
     * that a subset is fetched only when a glyph in it is used, and inlining is the one thing that
     * defeats it: nothing in this application renders Cyrillic Extended, and everybody was
     * downloading it anyway, uncacheable separately and unshrinkable by the 33% base64 tax.
     *
     * Scoped to fonts by returning `undefined` for everything else, which leaves Vite's default
     * limit in charge of the small SVGs and images where inlining is a saved request rather than a
     * defeated `unicode-range`.
     *
     * Measured on 2026-09-05: `index-*.css` went 59,836 → 57,171 bytes, and 13.52 → 11.01 kB
     * gzipped. The gzip saving is the larger share of the two because base64 is already
     * incompressible while the CSS around it is not — 2.5 kB off the render-blocking wire cost of
     * every first load, for a subset nothing here renders.
     */
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    // No maps at all. `'hidden'` suppresses the `//# sourceMappingURL=` comment and still writes
    // the `.map` files next to the chunks — into the very directory the Dockerfile copies whole
    // and `sirv` serves, so appending `.map` to any chunk URL returned the TypeScript of the
    // whole SPA with `sourcesContent` inlined. Nothing here uploads them to an error tracker,
    // which was the only thing `'hidden'` was buying. Turn this back on together with whatever
    // consumes them, and strip the files from the image in the same change.
    sourcemap: false,
    rolldownOptions: {
      output: {
        /**
         * Everything the first paint needs, in one chunk with the entry.
         *
         * Rolldown (Vite 8's bundler) splits shared code by *which entries reach it*, and every
         * `import()` is an entry — so a module the shell imports statically and a lazy chunk also
         * imports landed in a chunk of its own, preloaded beside the entry rather than inside it.
         * By wave 1 of the artefacts feature that was fourteen first-load files: react-router in
         * `hooks-*.js`, valibot in `exhibitConstants-*.js` (named after the module that happened to
         * reach it first, which is why it looked like the artefact feature's doing), the Radix
         * dismissable-layer/focus-scope/dialog code in one `dist-*.js` and floating-ui/popper in
         * another. None of it was lazy — the shell's tooltip and dropdown menu need all of it —
         * so the split bought no deferral and cost each file its own gzip dictionary and its own
         * import/export glue.
         *
         * `tags: ['$initial']` is Rolldown's built-in tag for "statically imported by an entry or
         * part of its dependency chain", so this group captures exactly the first-load closure and
         * nothing a lazy chunk alone reaches: Ketcher, RDKit, the pane, the markdown renderer and
         * the panels stay where they were. Measured on 2026-10-03 the way `check:bundle` measures
         * (entry plus every `modulepreload`, gzip level 9), bytes:
         *
         *     main before this (14 first-load chunks)   755,003 raw   238,985 gzip  (233.4 KiB)
         *     main with this alone (2 chunks)           751,218 raw   231,417 gzip  (226.0 KiB)
         *     with artefacts wave 2 on top              755,561 raw   232,743 gzip  (227.3 KiB)
         *
         * so this recovers 7,568 bytes gzip — slightly more than the 7,370 wave 1 added (230,015 →
         * 237,385) — and the whole of `assets/*.js` shrank too (2,136,172 → 2,127,674 gzip), so
         * nothing moved from the first load into a lazy chunk to buy the number. The runtime chunk
         * stays its own file because Rolldown emits it separately whatever the groups say.
         *
         * One cost to know about: a module is placed whole in one chunk, so a dependency the first
         * load shares with a lazy chunk (valibot) carries *every* export either side uses in the
         * first-load chunk — measured, under a kilobyte raw for the geometry schema's validators.
         */
        codeSplitting: { groups: [{ name: 'app', tags: ['$initial'] }] },
      },
    },
  },
  server: {
    /**
     * One address, and fail rather than drift.
     *
     * Vite's default host is `localhost`, which Node resolves to `::1` first on Linux, and its
     * default on a taken port is to move to 5174 and say so in a line nobody reads. Chemclaw3's
     * `infra/live/e2e-full-stack/up.sh` polls `http://127.0.0.1:5173` — so both defaults turned a
     * working dev server into "ui-spa never came up", and a stale Vite on 5173 into a lane quietly
     * testing yesterday's SPA. `scripts/dev.mjs` prints the same address; the fixture suite's
     * `playwright.config.ts` does not start this server (it serves the built client via the BFF).
     */
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy to the BFF, NOT straight to the Chemclaw service. If dev talked to FastAPI
      // directly we would never exercise the BFF's SSE path until production — and the BFF's
      // SSE path is exactly where the interesting failures live.
      '/api': {
        target: `http://127.0.0.1:${BFF_PORT}`,
        changeOrigin: false,
        ws: false,
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const contentType = String(proxyRes.headers['content-type'] ?? '');
            if (!contentType.includes('text/event-stream')) return;
            // Flush the header block early so the browser can tell "connecting" from "the agent
            // is thinking" — but write the upstream headers ourselves first, because the order
            // here is not what it looks like. http-proxy emits `proxyRes` *before* it copies the
            // upstream headers onto `res`, and it guards that copy with `!res.headersSent`.
            // Flushing alone therefore sent an empty header block and turned the copy into a
            // no-op: the body streamed perfectly while `content-type` — and the BFF's CSP and
            // nosniff headers — never arrived at all. The client checks the content type before
            // it will parse, so every turn in the browser died on `Expected an event stream but
            // received ""`, while the identical request straight to the BFF on 8787 was correct.
            // That asymmetry is the tell, and it is why curl-to-the-BFF cannot clear this path.
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            (res as { flushHeaders?: () => void }).flushHeaders?.();
          });
        },
      },
      '/config.js': { target: `http://127.0.0.1:${BFF_PORT}` },
    },
  },
});
