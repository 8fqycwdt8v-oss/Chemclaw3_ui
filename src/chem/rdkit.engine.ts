/**
 * RDKit itself: the WASM module and every call that touches it. Runs on a worker (a 600-character
 * draw blocks the main thread for ~0.6 s; `scripts/measure-rdkit-placement.mjs`), so it is
 * transport- and DOM-free: every export takes and returns `postMessage`-able values.
 * `rdkit.worker.ts` dispatches to it; `rdkit.client.ts` calls it in-process when there is no
 * `Worker`. `src/chem/rdkit.ts` is the seam callers use.
 *
 * Every `JSMol` must be deleted (it is a C++ object on the Emscripten heap); nothing here returns
 * one, and each helper frees its handles in a `finally`.
 */

import type { JSMol, RDKitLoader, RDKitModule } from '@rdkit/rdkit';
import { withLoadTimeout } from './toolkitLoad.ts';

/**
 * The longest SMILES handed to `get_mol`. Around 1,100 characters RDKit's WASM traps (`memory
 * access out of bounds`), which kills the runtime for the rest of the page, and inline SMILES in
 * answers are parsed on mount. 600 is well below the trap and above any structure drawn here (a
 * 60-mer peptide is 421).
 *
 * A refusal above this cap is not a chemical verdict: surfaces consult `tooLongToParse` before
 * saying "not a molecule". Inside the cap, a long chain can still exhaust the JS stack in canonical
 * ranking; that is reported as `too-complex` (see `Refused`).
 */
export const MAX_PARSED_SMILES_CHARS = 600;

/**
 * Whether this string exceeds `MAX_PARSED_SMILES_CHARS`. A negative about such a string is this
 * module's refusal, not a verdict; surfaces ask this before telling a chemist it is not a molecule.
 */
export function tooLongToParse(smiles: string): boolean {
  return smiles.length > MAX_PARSED_SMILES_CHARS;
}

/**
 * Set when a call left the WASM runtime dead. `loadRDKit` stops handing it out and
 * `rdkitAvailable()` answers `false`, so surfaces say the toolkit is unavailable rather than "not a
 * molecule" about every string.
 */
let poisoned = false;

/** Resolved once, then reused. Only a *success* is cached — see the catch below. */
let modulePromise: Promise<RDKitModule | null> | null = null;

/**
 * The most recent load attempt failed and no new one has started. Lets `rdkitAvailable()` answer
 * instantly from the attempt already made; `loadRDKit` still retries for callers that want a
 * module.
 */
let lastAttemptFailed = false;

function loadRDKit(): Promise<RDKitModule | null> {
  if (poisoned) return Promise.resolve(null);
  const pending = (modulePromise ??= (async () => {
    // A new attempt is under way; set before the first await so no caller sees the gap.
    lastAttemptFailed = false;
    try {
      // Bounded: none of these steps has its own deadline (see `toolkitLoad.ts`).
      return await withLoadTimeout(
        (async () => {
          const [loader, { default: wasmUrl }] = await Promise.all([
            // The package's typings do not match its CommonJS default export, so the runtime shape
            // is asserted.
            import('@rdkit/rdkit') as unknown as Promise<{ default: RDKitLoader }>,
            // `?url` keeps the 6.9 MB binary out of the JS bundle and hands us the hashed asset
            // path Vite emitted for it, which is what `locateFile` has to answer with.
            import('@rdkit/rdkit/dist/RDKit_minimal.wasm?url'),
          ]);
          return await loader.default({ locateFile: () => wasmUrl });
        })(),
        'The structure toolkit did not finish loading.',
      );
    } catch {
      // Failure is not memoised (timeouts included): none of these causes is about the input, so
      // the next request retries.
      modulePromise = null;
      lastAttemptFailed = true;
      return null;
    }
  })());
  return pending;
}

/**
 * Whether the toolkit loaded. Helpers answer `null`/`false` for "not a molecule", which is wrong
 * for "RDKit never loaded", so anything making a chemical claim on a negative asks this first.
 * Reports on the attempt already made, so it is cheap on a render path; `loadRDKit` retries.
 */
export async function rdkitAvailable(): Promise<boolean> {
  if (lastAttemptFailed && modulePromise === null) return false;
  return (await loadRDKit()) !== null;
}

/**
 * Why a call produced nothing. `unreadable`: RDKit read it and it is not a molecule. `too-complex`:
 * this thread ran out of stack in RDKit's recursive canonical ranking — it is a molecule, and a
 * call from a shallower stack may succeed (`scripts/measure-rdkit-rangeerror.mjs`, e.g. a chain of
 * 580 characters).
 */
export type Refused = 'unreadable' | 'too-complex';

/**
 * The refusals that are not a verdict about the string and need their own sentence at every
 * claiming surface. Derived from `Refused`, so a new member breaks compilation where it must be
 * handled (`structure.ts` and `StructureInput.tsx` carry `never` checks).
 */
export type NotAChemicalVerdict = Exclude<Refused, 'unreadable'>;

/**
 * What one `withMol` produced: a value, or the reason there is none. Threaded rather than a module
 * flag, because a stack exhaustion is about one call on one thread and calls run concurrently.
 */
type Attempt<T> = { readonly value: T } | { readonly refused: Refused };

/** The two refusals, named once so the shape is not rebuilt at six call sites. */
const UNREADABLE = { refused: 'unreadable' } as const;
const TOO_COMPLEX = { refused: 'too-complex' } as const;

/**
 * Run `fn` over a parsed molecule, always freeing it. `get_mol` returns `null` or throws for
 * unreadable input; the one throw that is not about the string is a stack exhaustion (`Refused`).
 */
function withMol<T>(rdkit: RDKitModule, smiles: string, fn: (mol: JSMol) => T): Attempt<T> {
  let mol: JSMol | null = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return UNREADABLE;
    return { value: fn(mol) };
  } catch (error) {
    // Liveness first, before inspecting the throw: an ordinary C++ exception means "not a
    // molecule", but a runtime abort makes that a lie about every string, and Emscripten's throw
    // shape is not a contract. `tests/rdkitTrap.test.ts` drives both placements.
    if (!stillAlive(rdkit)) {
      poisoned = true;
      return UNREADABLE;
    }
    // Alive, so a stack exhaustion is about this thread: on a worker (smaller stack) rethrow so
    // `rdkit.client.ts` retries on the page; in-process there is no better placement, so it is
    // `too-complex`.
    if (error instanceof RangeError && OFF_MAIN_THREAD) throw error;
    // What is left is a live module that could not finish the recursion, which is the only
    // `too-complex` this file will mint.
    return error instanceof RangeError ? TOO_COMPLEX : UNREADABLE;
  } finally {
    try {
      mol?.delete();
    } catch {
      // A dead runtime can also throw from `delete()`; keep the verdict already decided rather than
      // rejecting.
    }
  }
}

/**
 * Whether this copy runs on a worker (decides whether a stack exhaustion is escalated). Checked via
 * `typeof globalThis.WorkerGlobalScope` because the project builds against the `dom` lib, and not
 * with `in`, which test stubs satisfy.
 */
const OFF_MAIN_THREAD =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

/**
 * Whether the module can still read a molecule: parses `CCO`; a throw or invalid ethanol means the
 * heap is gone.
 */
function stillAlive(rdkit: RDKitModule): boolean {
  let probe: JSMol | null = null;
  try {
    probe = rdkit.get_mol('CCO');
    return probe !== null && probe.is_valid();
  } catch {
    return false;
  } finally {
    try {
      probe?.delete();
    } catch {
      // A dead runtime can refuse the free as well. The verdict is already `false`.
    }
  }
}

/**
 * `withMol` for SMILES input, with the length cap. Molblocks have no cap: long V2000 files degrade
 * to `null` or a stack exhaustion without trapping, and quickly.
 */
function withSmilesMol<T>(rdkit: RDKitModule, smiles: string, fn: (mol: JSMol) => T): Attempt<T> {
  // `unreadable`, not a new refusal: surfaces already check `tooLongToParse` first.
  if (smiles.length > MAX_PARSED_SMILES_CHARS) return UNREADABLE;
  return withMol(rdkit, smiles, fn);
}

/** A canonical name, or which of the two `Refused` reasons there is none. */
export type CanonicalRead =
  { readonly status: 'named'; readonly canonical: string } | { readonly status: Refused };

/**
 * What RDKit made of `smiles`: its canonical SMILES (the entity key, so two spellings collapse to
 * one), or a `Refused` reason. `rdkit.ts` narrows this to `string | null` for callers that only
 * want a key. A toolkit that never loaded reads as `unreadable`; surfaces ask `rdkitAvailable()`.
 */
export async function readCanonicalSmiles(smiles: string): Promise<CanonicalRead> {
  const rdkit = await loadRDKit();
  if (!rdkit) return { status: 'unreadable' };
  const attempt = withSmilesMol(rdkit, smiles, (mol) => mol.get_smiles());
  if ('refused' in attempt) return { status: attempt.refused };
  // An empty SMILES is a handle with no atoms, which is not a structure.
  return attempt.value ? { status: 'named', canonical: attempt.value } : { status: 'unreadable' };
}

/**
 * Whether RDKit can read `smiles` as a molecule — the gate before drawing a recogniser's guess. No
 * `too-complex` case: this never calls the recursive canonical ranking
 * (`scripts/measure-rdkit-rangeerror.mjs`).
 */
export async function isMolecule(smiles: string): Promise<boolean> {
  const rdkit = await loadRDKit();
  if (!rdkit) return false;
  return 'value' in withSmilesMol(rdkit, smiles, () => true);
}

/**
 * An MDL molblock (`.mol` or one `.sdf` record) as canonical SMILES, or a `Refused` reason. Exists
 * so no caller holds a `JSMol`. 2D coordinates are dropped (keys and messages are SMILES).
 * Three-valued: a long chain can be `too-complex`. No length cap (see `withSmilesMol`).
 */
export async function readCanonicalSmilesFromMolblock(molblock: string): Promise<CanonicalRead> {
  const rdkit = await loadRDKit();
  if (!rdkit) return { status: 'unreadable' };
  const attempt = withMol(rdkit, molblock, (mol) => mol.get_smiles());
  if ('refused' in attempt) return { status: attempt.refused };
  // An empty canvas is a valid zero-atom molblock; it is not a structure.
  return attempt.value ? { status: 'named', canonical: attempt.value } : { status: 'unreadable' };
}

/** Options for `drawSvg`. */
export interface DrawOptions {
  width: number;
  height: number;
  /** Draw dark-theme colours. RDKit takes this as a drawing option rather than something CSS can
   *  reach, because the SVG's strokes carry explicit colours. */
  dark?: boolean;
}

/**
 * `smiles` as an SVG, or `null`. Uses RDKit's depiction, normalized and straightened, so a compound
 * looks the same in every card. Uncached: the cache lives on the calling thread (`moleculeSvg` in
 * `rdkit.ts`).
 */
export async function drawSvg(smiles: string, opts: DrawOptions): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;

  // `too-complex` folds into `null`: depiction does not canonically rank, so it does not occur
  // here.
  const attempt = withSmilesMol(rdkit, smiles, (mol) => {
    mol.normalize_depiction(1);
    mol.straighten_depiction();

    const details: Record<string, unknown> = {
      width: opts.width,
      height: opts.height,
      // Transparent, so one drawing works on the surface, the sunken surface and inside a sheet
      // without the card behind it showing through a white rectangle.
      backgroundColour: [0, 0, 0, 0],
      ...(opts.dark ? { legendColour: [0.85, 0.85, 0.85], symbolColour: [0.85, 0.85, 0.85] } : {}),
    };

    return mol.get_svg_with_highlights(JSON.stringify(details)) || null;
  });
  return 'value' in attempt ? attempt.value : null;
}

/**
 * `smiles` as an MDL molblock, or `null` — what an SDF export is built from, with the same 2D
 * layout `drawSvg` uses.
 */
export async function molblock(smiles: string): Promise<string | null> {
  const rdkit = await loadRDKit();
  if (!rdkit) return null;
  const attempt = withSmilesMol(rdkit, smiles, (mol) => {
    mol.normalize_depiction(1);
    mol.straighten_depiction();
    return mol.get_molblock() || null;
  });
  return 'value' in attempt ? attempt.value : null;
}

/**
 * Whether the toolkit loads. Unlike `rdkitAvailable`, this starts an attempt: a gate before work.
 */
export async function toolkitLoads(): Promise<boolean> {
  return (await loadRDKit()) !== null;
}

/**
 * Every engine call by name — the one registry both placements read (`rdkit.worker.ts` dispatches
 * through it, `rdkit.client.ts` calls it directly without a worker). `rdkit.protocol.ts` derives
 * the wire types from it.
 */
export const operations = {
  available: rdkitAvailable,
  toolkitLoads,
  readCanonicalSmiles,
  isMolecule,
  readCanonicalSmilesFromMolblock,
  drawSvg,
  molblock,
} as const;
