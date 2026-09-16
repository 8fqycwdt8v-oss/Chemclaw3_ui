// @vitest-environment node

/**
 * The bundle budget, held as a budget rather than as a number somebody remembers.
 *
 * `scripts/check-bundle.mjs` policed what *lands* in the first load — MSAL stays lazy, the RDKit
 * worker is emitted and referenced — and said nothing about how big any of it is.
 * `tests/entryChunk.test.ts` already states why a size does not belong in prose, and asserts the
 * property instead; this is the other half, which is a number a build can check.
 *
 * **What this file can and cannot see.** The budget is enforced against `dist/client` by
 * `npm run check:bundle`, which needs a build and is a gate step. What a unit test can hold
 * without one is the part that decides whether that check means anything:
 *
 *  1. the measurement finds the files it is measuring — a sum over nothing passes every budget,
 *     which is the one way a size check fails silently in the direction of success;
 *  2. it finds the *right* files, i.e. the entry **and** its `modulepreload`ed siblings, which is
 *     the distinction this whole budget turns on — measured across this wave, three new
 *     dependencies moved the entry chunk by 4 bytes and the first load by 13 kB gzipped;
 *  3. the budget is above the measurement it was set from, with the headroom stated — a ratchet
 *     pinned to the current byte reds on an unrelated merge and teaches everybody to raise it.
 */

import { describe, expect, it } from 'vitest';
import { BUDGET, MEASURED, firstLoadFiles } from '../scripts/check-bundle.mjs';

/** A representative `index.html` as Vite writes one: the entry, its preloads, and the things that
 *  are not first-load JS at all. Transcribed from a real build rather than invented, because the
 *  shape of the tag is what this parser knows. */
const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <link rel="preload" href="/assets/inter-latin-wght-normal-Dx4kXJAl.woff2" as="font" crossorigin>
    <link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-C0FnF6B9.js">
    <link rel="modulepreload" crossorigin href="/assets/react-C21x__mS.js">
    <link rel="modulepreload" crossorigin href="/assets/chatStore-CkEM4rz-.js">
    <link rel="stylesheet" crossorigin href="/assets/index-BU804J5q.css">
    <script src="/config.js"></script>
    <script type="module" crossorigin src="/assets/index-CaUlnTkX.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('what the first-load budget measures', () => {
  it('finds the entry chunk and every chunk preloaded beside it', () => {
    expect(firstLoadFiles(INDEX_HTML)).toEqual([
      'assets/index-CaUlnTkX.js',
      'assets/rolldown-runtime-C0FnF6B9.js',
      'assets/react-C21x__mS.js',
      'assets/chatStore-CkEM4rz-.js',
    ]);
  });

  it('does not measure the entry alone, which is the mistake this budget exists to avoid', () => {
    // Driven rather than argued: this wave added `valibot`, `comlink` and `@tanstack/react-query`,
    // and the entry chunk moved by **4 bytes** — Rolldown put the new code in `chatStore-*.js` and
    // `Feedback-*.js`, which the browser fetches from a `modulepreload` at the same moment. An
    // entry-only budget would have reported +13 kB gzipped as no change at all.
    const files = firstLoadFiles(INDEX_HTML);
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((f) => /\/index-/.test(f))).toHaveLength(1);
  });

  it('takes no stylesheet, no font and no non-module script for JS', () => {
    // Each of those is a `<link>` or a `<script>` in the same head, and each would be counted by a
    // looser pattern — the font in particular is already Brotli-compressed internally, so folding
    // it in would make the gzip figure meaningless.
    for (const file of firstLoadFiles(INDEX_HTML)) expect(file.endsWith('.js')).toBe(true);
    expect(firstLoadFiles(INDEX_HTML).join()).not.toContain('config.js');
  });

  it('reports nothing rather than zero when it cannot find the entry', () => {
    // The failure that looks like success: a sum over no files is 0, and 0 is under every budget.
    // `check-bundle.mjs` fails on an empty list for exactly this reason, and this pins that the
    // list really is empty when the HTML has moved on.
    expect(firstLoadFiles('<html><body>nothing here</body></html>')).toEqual([]);
  });
});

describe('the budget itself', () => {
  it('is above what it was measured from, and says how much by', () => {
    // Both directions. A budget at or below the measurement is a ratchet that reds on somebody
    // else's merge; a budget far above it is not a budget. ~5% to ~15% is roughly "one more
    // dependency of react-query's weight", which is the size of decision this check exists to make
    // somebody take deliberately.
    for (const key of ['firstLoadGzip', 'firstLoadRaw'] as const) {
      const headroom = (BUDGET[key] - MEASURED[key]) / BUDGET[key];
      expect(headroom, `${key} has no headroom`).toBeGreaterThan(0.04);
      expect(headroom, `${key} is not a bound, it is a gesture`).toBeLessThan(0.16);
    }
  });

  it('records when it was measured, so a stale baseline is visible', () => {
    // Not asserted to be recent — nothing here can know what recent means — but present and
    // readable, which is the difference between a number with a date and a number.
    expect(MEASURED.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
