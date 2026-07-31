import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    // `.tsx` too, so a component can be tested where a store contract alone would not prove the
    // thing that was actually broken: a value written to state that nothing ever renders.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
