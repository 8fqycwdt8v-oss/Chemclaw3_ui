import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Must mirror vite.config.ts. This is a separate config with its own resolver, so an alias added
  // only there leaves every component test failing to resolve `@/…` at once.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    // `.tsx` too, so a component can be tested where a store contract alone would not prove the
    // thing that was actually broken: a value written to state that nothing ever renders.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
