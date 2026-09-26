/**
 * The storage a test sees is the DOM environment's, on every Node `engines` admits.
 *
 * Node 25 ships `localStorage`, `sessionStorage` and `Storage` as globals, on by default. vitest's
 * environment setup copies a window property onto the global only where the global does not have
 * it already, so on 25 happy-dom's storage was skipped without a word and five files that touch
 * storage met Node's instead — an object whose methods are absent unless `--localstorage-file` is
 * given (`localStorage.getItem is not a function`). CI runs Node 22, which has no such global, so
 * the pipeline stayed green while `npm test` on a current laptop did not; the local workaround was
 * `NODE_OPTIONS=--no-experimental-webstorage`, which fixed the symptom for one shell.
 *
 * The fix is that same flag, but in `vitest.config.ts`'s worker `execArgv`, so it is a property of
 * the suite rather than of whoever runs it. This file holds both halves:
 *
 * - **The flag reached the worker.** This is the half that fails on a Node 22 runner too: deleting
 *   the config line changes nothing observable on 22 *except* this assertion, which is the only
 *   way the pipeline can notice the fix going away before a laptop on 25 does.
 * - **The storage is happy-dom's.** The direct statement of what was broken, which fails on 25 the
 *   moment any other route lets Node's global back in.
 */

import { Storage as HappyDomStorage } from 'happy-dom';
import { describe, expect, it } from 'vitest';

describe('web storage under test', () => {
  it('runs the workers with Node’s own Web Storage switched off', () => {
    expect(process.execArgv).toContain('--no-experimental-webstorage');
  });

  it.each([
    ['localStorage', () => globalThis.localStorage],
    ['sessionStorage', () => globalThis.sessionStorage],
  ])('%s is the DOM environment’s, and it round-trips', (_name, storage) => {
    const store = storage();
    expect(store).toBeInstanceOf(HappyDomStorage);
    expect(globalThis.Storage).toBe(HappyDomStorage);
    store.setItem('webStorage.probe', 'kept');
    expect(store.getItem('webStorage.probe')).toBe('kept');
    store.clear();
    expect(store.length).toBe(0);
  });
});
