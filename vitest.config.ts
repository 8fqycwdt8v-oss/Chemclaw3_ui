import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const stub = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Must mirror vite.config.ts. This is a separate config with its own resolver, so an alias added
  // only there leaves every component test failing to resolve `@/…` at once.
  //
  // The array form, because the chemistry stubs below need regex finds — an object alias is a
  // prefix match and would rewrite `@rdkit/rdkit/dist/…` with the module stub.
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${stub('./src')}/` },
      // RDKit is a 6.9 MB WASM binary that fetches a `.wasm` sibling over HTTP; under happy-dom it
      // aborts on the missing file. The loader catches that and degrades, so the suite would pass
      // either way — by running the *degraded* path in every test that draws a structure, which
      // would make a real break in the drawing code indistinguishable from "no RDKit here".
      // The stub is behavioural (see its docstring) so the drawing path is genuinely exercised.
      {
        find: /^@rdkit\/rdkit\/dist\/RDKit_minimal\.wasm\?url$/,
        replacement: stub('./tests/stubs/wasmUrl.ts'),
      },
      { find: /^@rdkit\/rdkit$/, replacement: stub('./tests/stubs/rdkit.ts') },
      // The Ketcher *adapter*, not the seam. `src/chem/sketcher.ts` runs for real — the lazy
      // import, the cached module promise, the degrade-to-null — and only the file that actually
      // instantiates a 12 MB WASM editor is replaced. Loading the real one under happy-dom would
      // take the whole suite hostage to a Web Worker and a canvas, for no coverage.
      { find: /^\.\/sketcher\.ketcher\.tsx$/, replacement: stub('./tests/stubs/sketcher.tsx') },
    ],
  },
  test: {
    environment: 'happy-dom',
    // `.tsx` too, so a component can be tested where a store contract alone would not prove the
    // thing that was actually broken: a value written to state that nothing ever renders.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
