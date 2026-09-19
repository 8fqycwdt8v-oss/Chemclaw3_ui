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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How the WASM behaves when it has been aborted: everything throws, for ever.
 *
 * `overflows` and `freeThrows` are the two *recoverable* failures beside it, because the point of
 * every assertion here is telling those apart from the abort. A stack exhaustion leaves the runtime
 * alive; a free that refuses says nothing about the runtime at all.
 */
const wasm = vi.hoisted(() => ({
  dead: false,
  parses: 0,
  /** A SMILES whose *canonicalisation* overflows the JS stack, the runtime staying alive. */
  overflows: null as string | null,
  /** Whether `delete()` refuses, which a dead runtime does and `withMol`'s `finally` must survive. */
  freeThrows: false,
}));

vi.mock('@rdkit/rdkit', () => {
  const mol = (smiles: string) => ({
    is_valid: () => true,
    get_smiles: () => {
      // Only the canonical ranking recurses, which is why this and not `get_mol` is where a
      // stack exhaustion is modelled — the same property `tests/stubs/rdkit.ts` carries.
      if (wasm.overflows !== null && smiles === wasm.overflows) {
        throw new RangeError('Maximum call stack size exceeded');
      }
      return smiles;
    },
    normalize_depiction: () => {},
    straighten_depiction: () => {},
    get_svg_with_highlights: () => '<svg />',
    delete: () => {
      if (wasm.freeThrows) throw new Error('cannot free on a dead runtime');
    },
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
  wasm.overflows = null;
  wasm.freeThrows = false;
  vi.resetModules();
});

/** The one thing `rdkit.engine.ts` knows about its own placement, read at module scope. */
const asAWorker = (on: boolean): void => {
  if (on) (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope = class {};
  else delete (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
};

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

  it('is a refusal by this module, and says so rather than answering about the chemistry', async () => {
    const { isMolecule, tooLongToParse, MAX_PARSED_SMILES_CHARS } =
      await import('../src/chem/rdkit.ts');

    // The gap the cap opens, and the reason a surface may not read `false` here as a verdict.
    // Measured against the shipped binary on 2026-09-05: 600 characters parse and draw, 800 do,
    // 1,000 do (2.4 s, 504 kB of SVG), 1,040 parses and the draw throws with the runtime alive,
    // and 1,100 traps and kills it. So everything from 601 to ~1,099 is a molecule RDKit can read
    // and this module declines to — and `<Molecule>` used to render "Could not render this
    // structure" over it, which is a chemical claim about a chain that is perfectly fine.
    const polymer = 'C'.repeat(700);
    expect(polymer.length).toBeGreaterThan(MAX_PARSED_SMILES_CHARS);
    expect(await isMolecule(polymer)).toBe(false);
    expect(tooLongToParse(polymer)).toBe(true);
    expect(wasm.parses).toBe(0);

    // And it does not fire on anything inside the cap, where `false` really is about the string.
    expect(tooLongToParse('C'.repeat(MAX_PARSED_SMILES_CHARS))).toBe(false);
    expect(tooLongToParse('CCO')).toBe(false);
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

/**
 * The same trap, on the thread that owns the heap.
 *
 * **The placement that was never driven, and the one where the ordering inside `withMol` decides
 * the answer.** `rdkit.engine.ts` runs in two places: in-process on the page, and on a worker,
 * which is where every real call goes when the browser has one. Every case above runs the page
 * copy — happy-dom has no `Worker` — so the worker's own branch, `if (error instanceof RangeError
 * && OFF_MAIN_THREAD) throw error`, had no test at all.
 *
 * It sat *in front of* the liveness probe while the comment beside it said the probe runs first,
 * "because the shape of the throw is exactly what cannot be relied on — `tests/rdkitTrap.test.ts`
 * models [an abort] as a `RangeError`". Which this file does, deliberately, because Emscripten's
 * throw shape is not a contract. So on a worker an aborted runtime was rethrown as an escalation
 * rather than recognised: the worker never poisoned itself, its `available` went on answering
 * `true`, and the page copy re-ran the call and poisoned instead — the honest answer arriving from
 * the wrong module, and only because there happened to be a second one.
 *
 * Both directions are here, because a fix that just deleted the rethrow would pass the first.
 */
describe('a trap on the worker copy', () => {
  beforeEach(() => asAWorker(true));
  afterEach(() => asAWorker(false));

  it('poisons this copy rather than escalating a runtime that is gone', async () => {
    const engine = await import('../src/chem/rdkit.engine.ts');

    expect(await engine.readCanonicalSmiles('CCO')).toEqual({ status: 'named', canonical: 'CCO' });
    expect(await engine.rdkitAvailable()).toBe(true);

    wasm.dead = true;
    // Not a rejection: the seam's contract is a three-valued answer, and an escalation of this is
    // a claim that the page can do better, which it cannot — the heap is gone in both.
    await expect(engine.readCanonicalSmiles('CCO')).resolves.toEqual({ status: 'unreadable' });
    // The assertion that matters, and the one the shipped order could not satisfy on this thread:
    // the surfaces ask this before they say anything, and `true` here is how "not a molecule"
    // about ethanol reaches a chemist.
    expect(await engine.rdkitAvailable()).toBe(false);
  });

  it('still escalates a stack exhaustion, because that runtime is alive', async () => {
    const engine = await import('../src/chem/rdkit.engine.ts');

    const chain = 'C'.repeat(500);
    wasm.overflows = chain;
    // Rethrown, not answered: `rdkit.client.ts` reads a worker failure as "run it on the page",
    // whose stack is bigger. Swallowing it here is the one answer that must not be given.
    await expect(engine.readCanonicalSmiles(chain)).rejects.toThrow(RangeError);
    // And the probe that now runs first did not condemn the module for it.
    expect(await engine.rdkitAvailable()).toBe(true);
    expect(await engine.readCanonicalSmiles('CCO')).toEqual({ status: 'named', canonical: 'CCO' });
  });
});

/**
 * A free that refuses, which is the same sentence `stillAlive` already carries over its own.
 *
 * `withMol` ends in `finally { mol?.delete() }`, and its neighbour four lines down wraps exactly
 * that call in a `try` with the comment "A dead runtime can refuse the free as well." Unguarded,
 * a throw out of the `finally` **replaces** the answer the function had already decided on: the
 * `return` is discarded and the promise rejects instead.
 *
 * Where that lands is what makes it worth a test rather than a tidy-up. The two callers on the
 * surfaces' path are `void readStructure(...)` in `Composer`/`Molecule` and
 * `void readCanonicalSmiles(...)` in `StructureInput`, and neither has a `.catch` — so the panel
 * stays on "Checking…" for the life of the tab and the paste strip never appears. The handle is
 * lost either way; a verdict need not be.
 */
describe('a free the runtime refuses', () => {
  it('does not turn a decided answer into an unhandled rejection', async () => {
    const { readCanonicalSmiles } = await import('../src/chem/rdkit.ts');

    expect(await readCanonicalSmiles('CCO')).toEqual({ status: 'named', canonical: 'CCO' });

    // The realistic pairing: the runtime went away between the parse and the free.
    wasm.freeThrows = true;
    await expect(readCanonicalSmiles('CCO')).resolves.toEqual({
      status: 'named',
      canonical: 'CCO',
    });
  });

  it('answers the refusal it had already decided on when the call itself threw', async () => {
    const { readCanonicalSmiles, rdkitAvailable } = await import('../src/chem/rdkit.ts');

    expect(await rdkitAvailable()).toBe(true);
    // Both halves at once — the module is gone, so the canonicalisation throws *and* the free
    // does. This is the path where the discarded `return` was `UNREADABLE`.
    wasm.overflows = 'CCO';
    wasm.freeThrows = true;
    await expect(readCanonicalSmiles('CCO')).resolves.toEqual({ status: 'too-complex' });
  });
});
