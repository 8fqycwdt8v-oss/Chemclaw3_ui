/**
 * Write `.gz` and `.br` sidecars beside every compressible file in the client build.
 *
 * `server/app.ts` asks `sirv` for `gzip: true, brotli: true`, and those options do not compress
 * anything — they serve a PRE-COMPRESSED sibling (`index-abc.js.br`) when the request's
 * `Accept-Encoding` allows it, and fall through to the raw file when there is none. Nothing in the
 * build wrote one, so the option was inert and the comment above it described a step that did not
 * exist: measured on the shipped build, `find dist/client -name '*.gz' -o -name '*.br'` returned
 * **0** files and the main bundle went out at 634,903 B against 194,190 B gzipped — 3.27x — with
 * `Accept-Encoding: gzip, br` explicitly sent.
 *
 * A build step rather than a runtime compressor, deliberately, and it is the same reason
 * `server/app.ts` refuses to take a framework: an `express`-style compression middleware in this
 * process would also compress `text/event-stream`, and a compressor buffers until its window
 * fills — which is precisely the failure `npm run smoke` exists to catch. Compressing once at
 * build time costs the CPU once for the life of the image instead of once per cold load, and it
 * cannot reach the streaming path at all.
 *
 * `node:zlib` rather than a plugin: both codecs are in the standard library, and a dependency in
 * the build graph of a bundle a chemist executes is a supply-chain decision this repository takes
 * deliberately (see `tests/supplyChain.test.ts`).
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Extensions worth compressing.
 *
 * WASM is on the list and it is the one that pays best: `indigo-ketcher.wasm` is 11.8 MB raw and
 * 3.8 MB gzipped. Fonts are NOT — `.woff2` is already Brotli-compressed internally, so a second
 * pass costs build time and image size to save nothing. Nor are images.
 */
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.wasm', '.json']);

/**
 * Below this, a sidecar is not worth serving.
 *
 * A small file's compressed form is often larger than the original (framing overhead), and either
 * way the win is smaller than the extra file's own directory entry. The check below also drops any
 * sidecar that did not actually come out smaller, so this is the cheap half of the same rule.
 */
const MIN_BYTES = 1_024;

/** Every file under `dir`, depth-first, as absolute paths. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Compress `file` through `codec` into `file + suffix`, or leave nothing behind.
 *
 * A sidecar that is not smaller than the file it stands in for is deleted rather than shipped:
 * `sirv` prefers a sidecar whenever one exists, so keeping it would make the response BIGGER
 * while claiming an encoding. Returns the bytes the browser will actually receive.
 */
async function writeSidecar(file, suffix, codec, size) {
  const out = `${file}${suffix}`;
  await pipeline(createReadStream(file), codec, createWriteStream(out));
  const compressed = (await stat(out)).size;
  if (compressed >= size) {
    await unlink(out);
    return size;
  }
  return compressed;
}

const root = process.argv[2] ?? 'dist/client';
let raw = 0;
let gzipped = 0;
let files = 0;

for await (const file of walk(root)) {
  const ext = path.extname(file);
  if (!COMPRESSIBLE.has(ext)) continue;
  if (file.endsWith('.gz') || file.endsWith('.br')) continue;
  const size = (await stat(file)).size;
  if (size < MIN_BYTES) continue;

  // Maximum effort on both, because this runs once per image and every byte it saves is paid
  // 200 times over on a cold morning.
  const gz = await writeSidecar(file, '.gz', zlib.createGzip({ level: 9 }), size);
  await writeSidecar(
    file,
    '.br',
    zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    }),
    size,
  );

  files += 1;
  raw += size;
  gzipped += gz;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
console.log(
  `compressed ${files} files: ${mb(raw)} MB raw -> ${mb(gzipped)} MB gzip ` +
    `(${(raw / Math.max(1, gzipped)).toFixed(2)}x), plus brotli sidecars`,
);
