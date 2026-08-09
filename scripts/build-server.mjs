/**
 * Bundle the BFF into a single file.
 *
 * `packages: 'bundle'` inlines `sirv`, so the runtime container stage needs no node_modules at
 * all — it copies `dist/` and nothing else.
 *
 * The output is `.mjs`, not `.js`, and that extension is load-bearing. The bundle is ESM, and the
 * runtime image copies only `dist/` — so there is no `package.json` and no `"type": "module"`
 * anywhere above it. Node still runs it, because module-syntax detection (unflagged since 22.7)
 * re-parses a `.js` file as ESM when it fails to parse as CommonJS. But that is a compatibility
 * fallback, not a declaration: it costs a failed parse on every boot, it is exactly the kind of
 * heuristic that gets tightened, and `package.json` declares support for `node >=22.6`, where the
 * detection is still behind a flag and the container would genuinely fail to start. `.mjs` states
 * the format instead of relying on Node to infer it.
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.mjs',
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

// Client source maps are stripped in `build:client`, before compression — see
// `scripts/compress-client.mjs`. Doing it here would be too late: the compression step would
// already have produced `.map.gz`/`.map.br` siblings, which sirv serves for a request for the
// map itself, so the maps would still be public in compressed form.
//
// The server bundle's own map is kept: it lands outside CLIENT_DIR and is never served.
