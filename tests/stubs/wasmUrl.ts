/**
 * Stands in for Vite's `?url` import of the RDKit binary.
 *
 * Under `vite build` that import resolves to the hashed asset path Vite emitted; vitest has no such
 * asset, and the stub loader ignores the value anyway — `locateFile` is never called because
 * nothing is instantiated. The path is a recognisable fiction rather than an empty string so that
 * if it ever *does* reach a fetch, the failure names itself.
 */
export default '/__stub__/RDKit_minimal.wasm';
