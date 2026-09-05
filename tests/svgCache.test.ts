/**
 * A depiction is a pure function of its inputs, and nothing memoised it.
 *
 * Every *mount* re-parsed and redrew: measured against the shipped `@rdkit/rdkit` 2025.3.4-1.0.0
 * over ten drug-like structures, 5.40 ms and 12.5 kB of SVG each (2.81 ms for 4-bromoanisole,
 * 9.71 ms for atorvastatin), all of it synchronous WASM on the main thread. This application
 * redraws for reasons that have nothing to do with chemistry — the theme toggle redraws everything
 * visible, switching conversations remounts the entity rail, one molecule shown in three places is
 * drawn three times — so 20 structures on screen cost 111.6 ms per theme flip and another 108.7 ms
 * flipping back, against 0.02 ms served from a cache.
 *
 * What is asserted here is the *count of parses*, not a duration: a timing assertion in a suite is
 * a flake, and the parse is the thing the milliseconds are made of. A file of its own because
 * `loadRDKit` memoises per module registry and the mock has to be in place before the first
 * import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Counted per `get_mol`, which is where the parse and the depiction both live. */
const wasm = vi.hoisted(() => ({ parses: 0 }));

vi.mock('@rdkit/rdkit', () => {
  const mol = (smiles: string) => ({
    is_valid: () => true,
    get_smiles: () => smiles,
    normalize_depiction: () => {},
    straighten_depiction: () => {},
    get_svg_with_highlights: (details: string) => {
      const opts = JSON.parse(details) as { width: number; legendColour?: unknown };
      // Every input the key is supposed to separate on is visible in the output, so a test can
      // tell a stale hit from a fresh draw rather than only counting.
      const body = smiles.startsWith('BIG') ? 'x'.repeat(600_000) : '';
      return `<svg data-smiles="${smiles}" data-w="${opts.width}" data-dark="${opts.legendColour ? 'y' : 'n'}">${body}</svg>`;
    },
    delete: () => {},
  });
  return {
    default: async () => ({
      get_mol: (smiles: string) => {
        wasm.parses += 1;
        // `Z…` is this fake's "not a molecule", so the refusal path is reachable.
        return smiles.startsWith('Z') ? null : mol(smiles);
      },
    }),
  };
});

const SIZE = { width: 320, height: 220 };

beforeEach(() => {
  wasm.parses = 0;
  vi.resetModules();
});

describe('drawing the same structure twice', () => {
  it('parses once and serves the second from the cache', async () => {
    const { moleculeSvg } = await import('../src/chem/rdkit.ts');

    const first = await moleculeSvg('CCO', SIZE);
    const second = await moleculeSvg('CCO', SIZE);

    expect(first).toContain('data-smiles="CCO"');
    expect(second).toBe(first);
    // One, not two. This is the rail remounting, the same compound in three cards, and the
    // structure grid drawing a hit it has already drawn.
    expect(wasm.parses).toBe(1);
  });

  it('redraws for a different theme, and never again for either', async () => {
    const { moleculeSvg } = await import('../src/chem/rdkit.ts');

    const light = await moleculeSvg('CCO', { ...SIZE, dark: false });
    const dark = await moleculeSvg('CCO', { ...SIZE, dark: true });

    // Two genuinely different drawings: RDKit takes the theme as a drawing option, so a cache that
    // ignored it would put light strokes on a light card.
    expect(light).toContain('data-dark="n"');
    expect(dark).toContain('data-dark="y"');
    expect(wasm.parses).toBe(2);

    // The toggle, flipped back. This is the 108.7 ms that used to be spent every time.
    expect(await moleculeSvg('CCO', { ...SIZE, dark: false })).toBe(light);
    expect(await moleculeSvg('CCO', { ...SIZE, dark: true })).toBe(dark);
    expect(wasm.parses).toBe(2);
  });

  it('redraws for a different canvas size', async () => {
    const { moleculeSvg } = await import('../src/chem/rdkit.ts');

    const wide = await moleculeSvg('CCO', { width: 320, height: 220 });
    const narrow = await moleculeSvg('CCO', { width: 160, height: 110 });

    expect(wide).toContain('data-w="320"');
    expect(narrow).toContain('data-w="160"');
    expect(wasm.parses).toBe(2);
  });
});

describe('a structure that could not be drawn', () => {
  it('is not remembered as a refusal', async () => {
    const { moleculeSvg } = await import('../src/chem/rdkit.ts');

    // `null` here is three different facts — not a molecule, past the length cap, or a runtime
    // that has just died — and only the first is about the input. Caching it would be the
    // memoised-failure defect `loadRDKit`'s catch refuses, one layer up: a structure that failed
    // to draw once during a bad moment would stay undrawable for the life of the page.
    expect(await moleculeSvg('ZZZ', SIZE)).toBeNull();
    expect(await moleculeSvg('ZZZ', SIZE)).toBeNull();
    expect(wasm.parses).toBe(2);
  });
});

describe('the budget', () => {
  it('evicts, and evicts the least recently used rather than the oldest drawn', async () => {
    const { moleculeSvg } = await import('../src/chem/rdkit.ts');

    // 600 kB per drawing against a 2,000,000-character budget, so the fourth one cannot fit
    // beside the first three. Bounded by characters and not by entries precisely because a real
    // drawing ranges from 2.0 kB (ethanol) to 304 kB (the 600-character chain the length cap
    // still admits), and a count would admit anywhere between 0.4 MB and 60 MB.
    for (const smiles of ['BIG1', 'BIG2', 'BIG3']) await moleculeSvg(smiles, SIZE);
    expect(wasm.parses).toBe(3);

    // Touch the oldest, making it the newest use.
    await moleculeSvg('BIG1', SIZE);
    expect(wasm.parses).toBe(3);

    await moleculeSvg('BIG4', SIZE);
    expect(wasm.parses).toBe(4);

    // BIG2 was the least recently used when BIG4 arrived, so it is the one that went.
    await moleculeSvg('BIG1', SIZE);
    expect(wasm.parses).toBe(4);
    await moleculeSvg('BIG2', SIZE);
    expect(wasm.parses).toBe(5);
  });
});
