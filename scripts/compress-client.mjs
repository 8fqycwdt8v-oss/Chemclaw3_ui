/**
 * Precompress the built client assets, so sirv's `gzip`/`brotli` options have something to serve.
 *
 * `server/index.ts` has enabled both since the beginning, with a comment saying it serves "Vite's
 * precompressed output". Vite does not produce precompressed output, and no plugin was configured
 * to — so the flags matched nothing, every asset was served uncompressed, and the process had
 * (correctly) refused to add a request-time compressor because that would break SSE. The result
 * was the worst of both: no compression, and a comment asserting otherwise.
 *
 * sirv looks for `<file>.gz` and `<file>.br` beside the original and serves them when the request
 * allows that encoding, so producing the siblings is the whole fix.
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const CLIENT_DIR = process.env.CLIENT_DIR ?? 'dist/client';

// Text formats only. Images and fonts are already compressed, and a .gz sibling for a .png is
// bytes on disk that will never be smaller than the original.
//
// `.map` is deliberately absent: maps are removed below rather than compressed.
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt|webmanifest)$/;

// Below roughly one MTU the framing overhead outweighs the saving.
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * Remove the client source maps, BEFORE anything is compressed.
 *
 * `vite.config.ts` builds them because a readable production stack trace is worth having, but
 * `dist/client` is copied wholesale into the runtime image and served by sirv — so every `.js.map`
 * was publicly downloadable, handing any anonymous caller the complete unminified source. They are
 * generated and then not shipped: the debugging value survives in a local build and in CI
 * artefacts without being published.
 *
 * Ordering matters and is the reason this lives here rather than in `build-server.mjs`, which is
 * where it was first written: that script runs after this one, so the maps would already have been
 * compressed into `.map.gz`/`.map.br` siblings — and sirv serves a sibling for a request for the
 * map, so removing only the plain files would have left the maps public in compressed form.
 */
let strippedMaps = 0;
if (process.env.KEEP_CLIENT_SOURCEMAPS !== 'true') {
  for (const file of walk(CLIENT_DIR)) {
    if (!/\.map(\.gz|\.br)?$/.test(file)) continue;
    rmSync(file);
    strippedMaps += 1;
  }
  console.log(`stripped ${strippedMaps} client source map(s) from ${CLIENT_DIR}`);
}

let compressed = 0;
let originalBytes = 0;
let gzipBytes = 0;

for (const file of walk(CLIENT_DIR)) {
  if (!COMPRESSIBLE.test(file)) continue;
  if (file.endsWith('.gz') || file.endsWith('.br')) continue;
  const source = readFileSync(file);
  if (source.length < MIN_BYTES) continue;

  const [gz, br] = await Promise.all([
    gzipAsync(source, { level: 9 }),
    brotliAsync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
  ]);

  // Only keep a sibling that is actually smaller — sirv would otherwise happily serve a
  // "compressed" file larger than the original.
  if (gz.length < source.length) writeFileSync(`${file}.gz`, gz);
  if (br.length < source.length) writeFileSync(`${file}.br`, br);

  compressed += 1;
  originalBytes += source.length;
  gzipBytes += Math.min(gz.length, source.length);
}

const pct = originalBytes === 0 ? 0 : Math.round((1 - gzipBytes / originalBytes) * 100);
console.log(
  `compressed ${compressed} asset(s) in ${CLIENT_DIR} ` +
    `(${(originalBytes / 1024).toFixed(0)} kB -> ${(gzipBytes / 1024).toFixed(0)} kB gzip, ${pct}% smaller)`,
);

// Sanity: a build that produced nothing to compress is almost certainly a build that did not run.
if (compressed === 0) {
  console.warn(`compress-client: nothing compressed under ${CLIENT_DIR} — did the client build?`);
  if (!statSync(CLIENT_DIR, { throwIfNoEntry: false })) process.exit(1);
}
