/**
 * One dropped connection is not "a browser that cannot run the editor".
 *
 * `loadSketcher` memoised `null` for the life of the page, so the first failed load of a **7.71 MB**
 * chunk (measured, `npm run build:client`) permanently disabled Draw — while the button stayed
 * there, still opening a dialog that could only ever say "The structure editor could not be
 * loaded". Two seams held one fact and answered it opposite ways: `loadRDKit` has cleared its
 * promise on failure from the beginning, for exactly this reason and in almost these words.
 *
 * The retry is unbounded on purpose, and that is the other half of what is asserted here. Every
 * attempt is a chemist pressing a button, so nothing can loop; a counter would be a budget the one
 * person on a flaky connection burns through, after which the editor is gone for the page's life —
 * which is the defect, restored.
 *
 * **What this does and does not stand in for.** The failure injected below is thrown while the
 * module's export is read, which is the shape of a chunk that arrives and will not evaluate. It is
 * not a browser module map recording a failed *fetch* against a URL; that case is named in
 * `loadSketcher`'s own comment as the one this cannot recover without cache-busting the chunk
 * path, and no test in a Node runner can honestly claim to reproduce it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Flipped by the test; read every time the adapter's export is touched. */
const chunk = vi.hoisted(() => ({ broken: true, reads: 0 }));

// The path the vitest alias resolves `./sketcher.ketcher.tsx` to, so `sketcher.ts`'s own dynamic
// import is the thing being exercised rather than a mock of the seam itself.
vi.mock('./stubs/sketcher.tsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stubs/sketcher.tsx')>();
  return {
    ...real,
    // A getter, not a throwing factory: vitest caches a module factory's result, so a factory that
    // threw could not be asked a second time — and being asked a second time is the whole subject
    // of this file. Nothing outside `loadSketcher` reads this binding, so the count below is its
    // count.
    get mountKetcher() {
      chunk.reads += 1;
      if (chunk.broken) throw new Error('the sketcher chunk did not arrive');
      return real.mountKetcher;
    },
  };
});

beforeEach(() => {
  chunk.broken = true;
  chunk.reads = 0;
  vi.resetModules();
});

describe('a sketcher chunk that failed once', () => {
  it('degrades to the paste and drop paths for that attempt', async () => {
    const { loadSketcher } = await import('../src/chem/sketcher.ts');

    expect(await loadSketcher()).toBeNull();
    expect(chunk.reads).toBe(1);
  });

  it('is asked again on the next Draw click', async () => {
    const { loadSketcher } = await import('../src/chem/sketcher.ts');

    expect(await loadSketcher()).toBeNull();

    chunk.broken = false;
    expect(await loadSketcher()).toBeTypeOf('function');
    expect(chunk.reads).toBe(2);
  });

  it('does not keep asking once it has succeeded', async () => {
    const { loadSketcher } = await import('../src/chem/sketcher.ts');

    chunk.broken = false;
    expect(await loadSketcher()).toBeTypeOf('function');
    expect(await loadSketcher()).toBeTypeOf('function');
    // The success is still memoised: a second Draw click must not refetch 7.71 MB.
    expect(chunk.reads).toBe(1);
  });

  it('has no retry budget to run out of', async () => {
    const { loadSketcher } = await import('../src/chem/sketcher.ts');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(await loadSketcher()).toBeNull();
    }
    expect(chunk.reads).toBe(12);

    // The thirteenth is still a real attempt. A bound here would have stopped at whatever number
    // it declared, and the chemist would be on the paste path for the rest of the day.
    chunk.broken = false;
    expect(await loadSketcher()).toBeTypeOf('function');
  });
});
