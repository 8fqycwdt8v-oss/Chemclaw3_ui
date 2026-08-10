/**
 * Types for `ketcher-standalone`'s `binaryWasm` entry point.
 *
 * The package's default entry inlines Indigo's 11 MB WASM as base64 inside a 21 MB JavaScript file.
 * The `binaryWasm` entry is the same code loading the binary as a real `.wasm` asset instead, which
 * is what lets Vite emit it as a hashed file the browser can stream and cache — the same trade
 * `src/chem/rdkit.ts` makes with `?url`. Its `exports` entry declares `import` and `require` but no
 * `types`, so TypeScript resolves the runtime file and finds no declaration beside it.
 *
 * Re-exporting from the package root rather than restating a shape: the root *is* typed, and the
 * two entries are the same module built two ways. A hand-written stub here would drift.
 */
declare module 'ketcher-standalone/dist/binaryWasm' {
  export { StandaloneStructServiceProvider } from 'ketcher-standalone';
}
