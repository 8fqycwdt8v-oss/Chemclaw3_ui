/**
 * The one Node global Ketcher reaches for in a browser, provided before Ketcher is evaluated.
 *
 * `ketcher-react` reads and writes `global` as a bare identifier — `global.currentState`,
 * `global._ui_editor`, `global.FileReader` — which exists in Node and in a webpack build that
 * polyfills it, and in no browser. Vite does not polyfill it, so the production chunk threw
 * `ReferenceError: global is not defined` and the editor never reached `onInit`: the dialog sat on
 * "Loading the structure editor…" until the load timeout. That was true on `ketcher@3.17.2` too —
 * nothing in the browser suite waited for the editor, so nothing saw it. `e2e/rdkit.spec.ts` now
 * draws through it.
 *
 * Aliased to `globalThis` here rather than through Vite's `define`, which would rewrite `global`
 * in every chunk the app ships, the entry included. This module is imported first by
 * `sketcher.ketcher.tsx` — ES modules evaluate their imports in order — so it lands in the lazy
 * sketcher chunk and runs only when a chemist presses Draw.
 */

const scope = globalThis as typeof globalThis & { global?: typeof globalThis };
scope.global ??= globalThis;

export {};
