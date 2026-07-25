import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BFF_PORT = Number(process.env.BFF_PORT ?? 8787);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
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
