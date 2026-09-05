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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // A literal, so the dev-auth branch is statically dead in a normal production build rather
    // than merely unreachable at runtime.
    __ALLOW_DEV_AUTH__: JSON.stringify(ALLOW_DEV_AUTH),
  },
  // `@/…` is what the vendored shadcn components import by. Mirrored in tsconfig.json and — the
  // one that gets forgotten — vitest.config.ts, which is a separate config with its own resolver.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist/client',
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
  },
  server: {
    port: 5173,
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
