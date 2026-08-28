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
  // No source map: the Dockerfile copies `dist/` whole into the runtime image, so a
  // `dist/server.js.map` ships the BFF's full TypeScript — the route whitelist, the header drop
  // rules, the auth-posture probe — to anyone who can pull the image. Nothing consumes it (there is
  // no debugger attached in production), and `vite.config.ts` already suppresses the client map for
  // the same reason.
  sourcemap: false,
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
