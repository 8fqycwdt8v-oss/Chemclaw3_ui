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
    // `hidden` still emits maps for error reporting but drops the sourceMappingURL comment, so
    // production bundles stop advertising them to anyone who opens devtools.
    sourcemap: 'hidden',
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
