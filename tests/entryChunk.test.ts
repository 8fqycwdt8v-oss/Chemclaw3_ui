// @vitest-environment node

/**
 * No chemistry toolkit in the entry bundle — as a property, not as a byte count.
 *
 * `src/chem/rdkit.ts` and `src/components/Molecule.tsx` both argued the RDKit swap by quoting the
 * entry chunk's size, and both were stale: one said the entry ends the branch at 509 kB while the
 * other said 485 kB, two numbers for one chunk, and it measured 505.90 kB on 2026-09-05. A size in
 * prose is a claim about one commit on one branch — it moves when anything anywhere is added — so
 * what those files now point at is this, which asserts the thing the argument actually rests on
 * and which a build cannot quietly break.
 *
 * The rule: **the only file that may statically import a chemistry toolkit is one that nothing
 * imports statically.** A `import type` is erased and does not count; `import('…')` inside a
 * loader is a call and does not count. Everything else puts 6.9 MB of WASM loader or 7.71 MB of
 * editor on the first paint.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url);

/** Every `.ts`/`.tsx` under `src/`, path relative to it. Declaration files are types by
 *  definition and carry no runtime import. */
function sources(dir = '', out: string[] = []): string[] {
  for (const entry of readdirSync(new URL(dir, SRC))) {
    const path = `${dir}${entry}`;
    if (statSync(new URL(path, SRC)).isDirectory()) sources(`${path}/`, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const files = sources();

/** A static `import … from '<specifier>'`, excluding `import type`. */
const staticallyImports = (source: string, specifier: RegExp): boolean =>
  new RegExp(`^import (?!type )[^;]*?from '${specifier.source}'`, 'ms').test(source);

const read = (path: string): string => readFileSync(new URL(path, SRC), 'utf8');

describe('the entry bundle', () => {
  it('found the source tree it is checking', () => {
    // A traversal that silently found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('chem/rdkit.ts');
    expect(files).toContain('chem/sketcher.ketcher.tsx');
  });

  it('reaches RDKit only through a dynamic import', () => {
    for (const file of files) {
      expect(staticallyImports(read(file), /@rdkit\/rdkit.*/), file).toBe(false);
    }
    // And the dynamic one is still there, so this is not passing because the import moved away.
    expect(read('chem/rdkit.ts')).toMatch(/import\('@rdkit\/rdkit'\)/);
  });

  it('reaches Ketcher only from the adapter, which is itself only reached dynamically', () => {
    for (const file of files) {
      const isAdapter = file === 'chem/sketcher.ketcher.tsx';
      expect(staticallyImports(read(file), /ketcher-.*/), file).toBe(isAdapter);
      expect(staticallyImports(read(file), /\.\/sketcher\.ketcher\.tsx/), file).toBe(false);
    }
    expect(read('chem/sketcher.ts')).toMatch(/import\('\.\/sketcher\.ketcher\.tsx'\)/);
  });
});
