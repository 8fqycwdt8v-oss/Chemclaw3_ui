/**
 * A 6.9 MB fetch that is accepted and never answered.
 *
 * `loadRDKit` had no deadline, so the module promise stayed pending for ever and every caller
 * waited on it: `SingleMolecule` sat on its reserved box, the structure panel sat on "Checking…",
 * and neither reached the "the structure toolkit could not be loaded" copy that exists precisely
 * for this. A silent empty box for the life of the page is the outcome the whole
 * available/unreadable distinction was built to avoid, and it needs no exotic failure — a captive
 * portal, a proxy that swallows the response, a half-open socket after a network change.
 *
 * The sketcher had answered this question already (60 s), so the two seams now share one number
 * out of `src/chem/toolkitLoad.ts` rather than growing a second one that drifts.
 *
 * **Without the timeout every assertion in this file hangs rather than failing**, which is the
 * point: the defect is not a wrong answer, it is no answer.
 *
 * A file of its own because `loadRDKit` memoises per module registry and the mock has to be in
 * place before the first import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLKIT_LOAD_TIMEOUT_MS } from '../src/chem/toolkitLoad.ts';

/** A loader that resolves nothing, ever — and counts how many times it was asked to. */
const wasm = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@rdkit/rdkit', () => ({
  default: async () => {
    wasm.calls += 1;
    return new Promise(() => {
      // Deliberately never settles. This is a response that never arrives, not an error.
    });
  },
}));

/**
 * A fresh `rdkit.ts` with the clock under this test's control.
 *
 * The module graph is warmed under the *real* clock first, deliberately. `loadRDKit` reaches the
 * loader through two dynamic imports, and resolving a module for the first time is real work that
 * a fake clock does not advance — so with the timers installed too early the 60 s deadline could
 * fire before the loader had been reached at all, and the "did it try again" count read 0, 2 or 3
 * depending on how the run interleaved. Warming first makes the imports a cache hit, and the
 * sequence deterministic.
 */
async function loadUnderFakeClock(): Promise<typeof import('../src/chem/rdkit.ts')> {
  const rdkit = await import('../src/chem/rdkit.ts');
  await import('@rdkit/rdkit');
  await import('@rdkit/rdkit/dist/RDKit_minimal.wasm?url');
  vi.useFakeTimers();
  return rdkit;
}

beforeEach(() => {
  wasm.calls = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a load nobody answers', () => {
  it('gives up rather than leaving every structure pending for the life of the page', async () => {
    const { moleculeSvg } = await loadUnderFakeClock();

    const drawing = moleculeSvg('CCO', { width: 320, height: 220 });
    await vi.advanceTimersByTimeAsync(0);
    expect(wasm.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(TOOLKIT_LOAD_TIMEOUT_MS);
    expect(await drawing).toBeNull();
  });

  it('reaches the honest copy in one budget rather than two', async () => {
    const { moleculeSvg, rdkitAvailable } = await loadUnderFakeClock();

    const drawing = moleculeSvg('CCO', { width: 320, height: 220 });
    await vi.advanceTimersByTimeAsync(TOOLKIT_LOAD_TIMEOUT_MS);
    expect(await drawing).toBeNull();

    // `Molecule` and the structure panel both ask this *immediately* after a negative, to choose
    // between "not a molecule" and "the toolkit is not here". Sending it through a second full
    // load would mean the honest sentence arrives two minutes after the page stopped working —
    // and no timer is advanced below, so a second load would hang this test rather than answer it.
    expect(await rdkitAvailable()).toBe(false);
    expect(wasm.calls).toBe(1);
  });

  it('still lets the next thing a chemist does try again', async () => {
    const { canonicalSmiles, isMolecule } = await loadUnderFakeClock();

    const first = canonicalSmiles('CCO');
    await vi.advanceTimersByTimeAsync(TOOLKIT_LOAD_TIMEOUT_MS);
    expect(await first).toBeNull();

    // The timeout is inside the not-memoised rule, not an exception to it: a request nobody
    // answered is no more a property of the input than a blocked `wasm-unsafe-eval` is.
    const second = isMolecule('CCO');
    await vi.advanceTimersByTimeAsync(0);
    expect(wasm.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(TOOLKIT_LOAD_TIMEOUT_MS);
    expect(await second).toBe(false);
  });
});
