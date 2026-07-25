/**
 * Bundle the BFF into a single file.
 *
 * `packages: 'bundle'` inlines `sirv`, so the runtime container stage needs no node_modules at
 * all — it copies `dist/` and nothing else.
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'bundle',
  sourcemap: true,
  // ESM output that bundles CJS dependencies needs these shims available.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_of } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_of(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});
