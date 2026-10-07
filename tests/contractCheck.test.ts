/**
 * The drift check's own inputs, checked — because nothing else checks them.
 *
 * `scripts/check-openapi.mjs` is the one thing in this repo that compares the BFF whitelist to the
 * routes the service actually serves, and it is not part of `npm test`: it needs a live backend, so
 * it runs by hand. That makes its own correctness invisible in exactly the way it exists to fix.
 * Two of its inputs were wrong at once and neither could be seen from a green suite.
 *
 * **A path parameter with no sample reports a live route as dead.** The script matches the
 * whitelist's regexes against *concrete* paths built by substituting `SAMPLES` into the backend's
 * templates, and its own docstring promises that "a wrong guess about which alphabet a parameter
 * takes cannot report a live route as dead" — true only while every id shape has a sample.
 * `design-` plus twelve hex had none, so all four `/protocols/{design_id}` entries came back in the
 * fatal list: measured, the run reported seven dead routes where three were real. A check that
 * cries wolf on more than half its findings is one nobody reads to the end.
 *
 * The property is asserted against `server/routes.ts`'s own id patterns rather than against a
 * hand-written list, so a pattern added there without a sample fails here rather than in a run
 * nobody makes.
 *
 * **A remedy that names a module the backend does not have.** Three places told a reader to start
 * the service with `uvicorn service.app:create_app`. There is no `service` package — the factory is
 * `chemclaw.api.app:create_app`, and the old string exits with `ModuleNotFoundError: No module
 * named 'service'`. It is the first instruction somebody follows after the check fails to connect,
 * which is the worst possible place for it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const check = readFileSync('scripts/check-openapi.mjs', 'utf8');

/** The script's stand-ins for a path parameter, read off the script — the list is the thing. */
const SAMPLES = [
  ...(check.match(/const SAMPLES = \[[\s\S]*?\n\];/)?.[0] ?? '').matchAll(
    /^\s*'([^']*)'(?:\.repeat\((\d+)\))?,/gm,
  ),
].map((m) => (m[2] ? (m[1] ?? '').repeat(Number(m[2])) : (m[1] ?? '')));

describe('the contract check can build a path for every id the whitelist takes', () => {
  /**
   * The id patterns `server/routes.ts` composes its routes out of, read off the source.
   *
   * Each is declared as one capture group over a single path segment (`const DESIGN =
   * '(design-[0-9a-f]{12})'`), which is what makes them checkable one at a time — the route regexes
   * themselves are whole-path and cannot be inverted into a template.
   */
  const idPatterns = [
    ...readFileSync('server/routes.ts', 'utf8').matchAll(
      /^const ([A-Z_]+) = (?:'([^']*)'|"([^"]*)");$/gm,
    ),
  ].map((m) => ({ name: m[1] ?? '', source: m[2] ?? m[3] ?? '' }));

  it('reads both lists off the source rather than restating them', () => {
    expect(idPatterns.length).toBeGreaterThan(3);
    expect(SAMPLES.length).toBeGreaterThan(3);
  });

  it('has a sample satisfying every id pattern the whitelist composes routes from', () => {
    const unsampled = idPatterns.filter(
      ({ source }) => !SAMPLES.some((sample) => new RegExp(`^${source}$`).test(sample)),
    );
    expect(
      unsampled.map((p) => `${p.name} = ${p.source}`),
      'check-openapi.mjs has no SAMPLE for these id shapes, so every route using one is ' +
        'reported dead whether it is live or not',
    ).toEqual([]);
  });
});

describe('the remedy names a module the backend actually has', () => {
  // `chemclaw.api.app:create_app` — verified against the Chemclaw3 checkout, where `app.py` lives
  // at `src/chemclaw/api/app.py` and `create_app` is its factory. There is no top-level `service`
  // package there at all, in any layout: the old string is a `ModuleNotFoundError`, not a
  // mis-typed port.
  const FACTORY = 'chemclaw.api.app:create_app';

  it.each(['scripts/check-openapi.mjs', 'scripts/dev.mjs', 'README.md'])(
    '%s tells the reader to run the factory that exists',
    (file) => {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(`uvicorn ${FACTORY}`);
      expect(text, `${file} still names a module the backend does not have`).not.toContain(
        'service.app:create_app',
      );
    },
  );
});
