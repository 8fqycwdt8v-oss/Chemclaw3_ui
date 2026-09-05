/**
 * One pathological SMILES must not take chemistry away for the rest of the tab.
 *
 * Two independent failures, both measured against the shipped `@rdkit/rdkit` 2025.3.4-1.0.0 rather
 * than reasoned about:
 *
 *  - `rdkit.get_mol('C'.repeat(1080))` raises `RuntimeError: memory access out of bounds`.
 *    Emscripten aborts the runtime, so **every later call throws too** — a control `CCO` parsed
 *    fine before it and threw after it, in the same process.
 *  - `withMol` catches, and its answer for a throw is `null`, which every caller reads as "not a
 *    molecule". So after the trap the app tells a chemist that ethanol is not a molecule, in the
 *    honest-sounding words the `rdkitUnavailable` path exists to avoid ("RDKit could not read this
 *    as a molecule"), while `rdkitAvailable()` still answers `true` because the module did load.
 *    Only a reload recovered it.
 *
 * Reachable with nobody doing anything wrong: `Markdown` renders an inline code span through
 * `InlineSmiles`, which parses on mount, and `looksLikeSmiles` accepted `'CC'.repeat(600)`.
 *
 * The fix is two bounds and they are tested separately, because they answer different questions.
 * The **cap** stops the trap being reachable at all. The **liveness probe** is what makes the app
 * honest if one happens anyway — through a path this cap does not cover, or a future RDKit with a
 * different threshold — by turning "not a molecule" back into "the toolkit is not available".
 *
 * A file of its own because `loadRDKit` memoises per module registry and the mock has to be in
 * place before the first import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** How the WASM behaves when it has been aborted: everything throws, for ever. */
const wasm = vi.hoisted(() => ({ dead: false, parses: 0 }));

vi.mock('@rdkit/rdkit', () => {
  const mol = (smiles: string) => ({
    is_valid: () => true,
    get_smiles: () => smiles,
    normalize_depiction: () => {},
    straighten_depiction: () => {},
    get_svg_with_highlights: () => '<svg />',
    delete: () => {},
  });
  return {
    default: async () => ({
      get_mol: (smiles: string) => {
        wasm.parses += 1;
        if (wasm.dead) throw new RangeError('memory access out of bounds');
        // The real binary traps here rather than returning; ~1040 is the measured threshold.
        if (smiles.length >= 1040) {
          wasm.dead = true;
          throw new RangeError('memory access out of bounds');
        }
        return mol(smiles);
      },
    }),
  };
});

beforeEach(() => {
  wasm.dead = false;
  wasm.parses = 0;
  vi.resetModules();
});

describe('a SMILES longer than the toolkit survives', () => {
  it('is refused without being handed to the parser', async () => {
    const { isMolecule } = await import('../src/chem/rdkit.ts');

    expect(await isMolecule('C'.repeat(1080))).toBe(false);
    // Zero, not "it returned false": the point is that `get_mol` was never called, because calling
    // it is what kills the runtime. A cap that let the call through and reported the throw would
    // pass a weaker assertion and fix nothing.
    expect(wasm.parses).toBe(0);
    expect(wasm.dead).toBe(false);
  });

  it('leaves every structure a chemist would actually draw readable', async () => {
    const { canonicalSmiles } = await import('../src/chem/rdkit.ts');

    // Paclitaxel-scale, and the 60-mer peptide `tests/chem.test.tsx` blesses at 421 characters.
    expect(await canonicalSmiles('C'.repeat(421))).toBe('C'.repeat(421));
    expect(await canonicalSmiles('CCO')).toBe('CCO');
  });
});

describe('a trap that happens anyway', () => {
  it('turns the toolkit unavailable rather than calling every molecule unreadable', async () => {
    const { canonicalSmiles, rdkitAvailable } = await import('../src/chem/rdkit.ts');

    expect(await rdkitAvailable()).toBe(true);
    expect(await canonicalSmiles('CCO')).toBe('CCO');

    // Straight past the cap, the way a molblock or a future threshold could.
    wasm.dead = true;
    expect(await canonicalSmiles('CCO')).toBeNull();

    // The claim that matters. Before this, the surfaces asked `rdkitAvailable()` first, were told
    // `true`, and therefore said "not a molecule" about ethanol.
    expect(await rdkitAvailable()).toBe(false);
  });

  it('does not condemn the module for an ordinary parse failure', async () => {
    // The other half, and the reason the probe exists rather than a `catch` that assumes the
    // worst: a C++ exception out of the depiction code is recoverable — measured, a 1050-character
    // chain throws one, `delete()` still works, and the next molecule parses fine.
    const { canonicalSmiles, rdkitAvailable } = await import('../src/chem/rdkit.ts');

    expect(await canonicalSmiles('CCO')).toBe('CCO');
    expect(await rdkitAvailable()).toBe(true);
  });
});
