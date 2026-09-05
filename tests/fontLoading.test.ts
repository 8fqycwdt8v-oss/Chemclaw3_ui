// @vitest-environment node

/**
 * How the fonts reach a first paint, and the two things that were wrong about it.
 *
 * A review reported that the build emits 302.67 kB of woff2 for the ~88.65 kB a browser rendering
 * English actually fetches, and asked for the latin subsets only. The measurement is right and the
 * conclusion is not: `unicode-range` means the other 214 kB is *emitted*, never *downloaded*, and
 * `src/index.css` already writes down why that is the arrangement here — "the Greek subset — μ, α,
 * β, Δ, and the rest of a chemistry answer — downloads only when a glyph in it is actually used".
 * `src/main.tsx` carries the refusal and its reasons; this file holds the two halves that were
 * real.
 *
 *  - **A face was being inlined into the render-blocking stylesheet.** Vite inlines assets under
 *    4 kB, and `jetbrains-mono-cyrillic-ext` is 2,028 bytes, so it shipped as a 2,727-character
 *    base64 blob inside `index-*.css` — downloaded by everyone, for a subset nothing here renders,
 *    which is exactly the `unicode-range` bargain defeated. Measured after: the stylesheet went
 *    59,836 → 57,171 bytes, 13.52 → 11.01 kB gzipped.
 *  - **Nothing preloaded the one face the first paint certainly needs.** Body text is
 *    'Inter Variable', discovered only after the stylesheet has been fetched and parsed.
 *
 * The preload could only be written because Vite rewrites `<link href>` in `index.html` through
 * the same asset pipeline as the CSS import *and dedupes it* — verified in a real
 * `npm run build:client`, where the emitted href was `/assets/inter-latin-wght-normal-Dx4kXJAl.woff2`
 * and the stylesheet's own `@font-face` named the identical path. Hand-writing a hashed name would
 * have been the mistake; the hash is content-derived.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the preloaded font', () => {
  const html = read('index.html');
  const preload = /<link[^>]*rel="preload"[^>]*>/s.exec(html)?.[0] ?? '';

  it('is declared as a font, anonymously, with the right type', () => {
    // `crossorigin` is not optional on a font preload: fonts are fetched in CORS mode, and a
    // preload without it warms a *different* cache entry than the one the CSS then asks for — the
    // classic "preloaded but not used" double download.
    expect(preload).toMatch(/as="font"/);
    expect(preload).toMatch(/type="font\/woff2"/);
    expect(preload).toMatch(/crossorigin/);
  });

  it('names a file that exists, so the build can hash it', () => {
    const href = /href="([^"]+)"/.exec(preload)?.[1] ?? '';
    expect(href).toMatch(/inter-latin-wght-normal\.woff2$/);
    // A relative path, which is what makes Vite resolve and rewrite it. An absolute `/assets/…`
    // would be treated as a public-directory URL, shipped verbatim, and 404.
    expect(href.startsWith('.')).toBe(true);
    expect(existsSync(new URL(`../${href.replace(/^\.\//, '')}`, import.meta.url))).toBe(true);
  });

  it('is the only one, so nothing preloads a face the first paint may not use', () => {
    // 'JetBrains Mono Variable' is the tempting second: nothing in the shell, the sidebar or the
    // composer is monospaced, so it is needed only once a transcript with a code span renders —
    // and an unused preload is 40 kB of critical-path bandwidth plus a browser warning saying so.
    expect([...html.matchAll(/rel="preload"/g)]).toHaveLength(1);
  });
});

describe('the build', () => {
  it('never inlines a font into the stylesheet', async () => {
    const config = (await import('../vite.config.ts')).default as {
      build?: { assetsInlineLimit?: unknown };
    };
    const limit = config.build?.assetsInlineLimit;
    expect(typeof limit).toBe('function');

    const decide = limit as (filePath: string, content: Buffer) => boolean | undefined;
    const tiny = Buffer.alloc(16);
    for (const font of ['x.woff2', 'x.woff', 'x.ttf', 'x.otf']) {
      expect(decide(font, tiny), font).toBe(false);
    }
    // Scoped: `undefined` hands the decision back to Vite's default limit, where inlining a small
    // image is a saved request rather than a defeated `unicode-range`.
    expect(decide('icon.svg', tiny)).toBeUndefined();
  });
});
