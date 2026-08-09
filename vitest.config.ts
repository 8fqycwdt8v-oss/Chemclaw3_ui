import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const stub = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // RDKit is a 6.9 MB WASM binary that fetches a `.wasm` sibling over HTTP; under happy-dom it
      // aborts on the missing file. The loader catches that and degrades, so the suite passed
      // either way — by running the *degraded* path in every test that draws a structure, which
      // would make a real break in the drawing code indistinguishable from "no RDKit here".
      // The stub is behavioural (see its docstring) so the drawing path is genuinely exercised.
      { find: /^@rdkit\/rdkit\/dist\/RDKit_minimal\.wasm\?url$/, replacement: stub('./tests/stubs/wasmUrl.ts') },
      { find: /^@rdkit\/rdkit$/, replacement: stub('./tests/stubs/rdkit.ts') },
    ],
  },
  test: {
    environment: 'happy-dom',
    // `.tsx` too, so a component can be tested where a store contract alone would not prove the
    // thing that was actually broken: a value written to state that nothing ever renders.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
