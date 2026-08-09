import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BFF_PORT = Number(process.env.BFF_PORT ?? 8787);

/**
 * Whether this build may fall back to the no-token dev auth provider (`src/auth/index.ts`).
 *
 * Defaults to `false` so an ordinary `npm run build` cannot produce a bundle that serves
 * unauthenticated access. A deployment that genuinely wants dev auth — `start.sh`, the compose
 * stack — opts in with an env var, which is a greppable string in a tracked file rather than an
 * absent one.
 */
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // A literal, so the dev-auth branch is statically dead in a normal production build.
    __ALLOW_DEV_AUTH__: JSON.stringify(ALLOW_DEV_AUTH),
  },
  build: {
    outDir: 'dist/client',
    // Source maps are built (they make a production stack trace readable) but are NOT shipped:
    // `scripts/build-server.mjs` strips them from dist/client after the build, so the container
    // does not serve the entire readable source of the app to anonymous callers.
    sourcemap: true,
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
            if (contentType.includes('text/event-stream')) {
              // Vite's dev proxy will otherwise hold the header block, so the browser cannot
              // distinguish "connecting" from "the agent is thinking".
              (res as { flushHeaders?: () => void }).flushHeaders?.();
            }
          });
        },
      },
      '/config.js': { target: `http://127.0.0.1:${BFF_PORT}` },
    },
  },
});
