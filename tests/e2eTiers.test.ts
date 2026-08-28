// @vitest-environment node

/**
 * Every browser spec runs in exactly one tier — checked, rather than written down and hoped for.
 *
 * This repository has three Playwright configs. `playwright.config.ts` sweeps `e2e/` and runs
 * everything it does not ignore against `e2e/fixture-service.ts`; the others each `testMatch` one
 * spec that needs a live stack. The two rules that keeps sound are exclusive, and both have failed:
 *
 *  * A live spec that the base config does not ignore runs **twice**, and the second run is against
 *    a fixture that answers one canned reply to every question. That happened: `full-stack.spec.ts`
 *    was collected by the base config for as long as it existed, and its scenarios could not pass
 *    there however healthy the real stack was. Nobody saw it, because `format:check` was red on
 *    `main` and CI never reached the step.
 *  * A fixture spec that the base config *does* ignore runs **nowhere** — the quieter failure of
 *    the two, since nothing goes red and the file simply stops being evidence about anything.
 *
 * The fix for the first was to add a name to a hand-written regex, which is the same fix that will
 * be forgotten next time. So the regex stays (a config cannot glob its siblings at load time) and
 * this test is what makes it true: it resolves each config's `testMatch` against the spec files
 * actually on disk, and checks both directions. A new tier is then one config file away from being
 * covered, and forgetting the ignore is red rather than silent.
 *
 * Read as text rather than imported. `defineConfig` returns its argument, so importing would work —
 * but it would also pull `@playwright/test` into the vitest process to learn two regexes, and the
 * thing under test here is what the file *says*, which is exactly what a reviewer reads.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** Every `playwright.<tier>.config.ts`, i.e. every config except the base sweep. */
const dedicatedConfigs = readdirSync(root).filter(
  (name) => /^playwright\..+\.config\.ts$/.test(name) && name !== 'playwright.config.ts',
);

/** Every browser spec in `e2e/`. */
const specs = readdirSync(new URL('e2e/', root)).filter((name) => name.endsWith('.spec.ts'));

/**
 * The regex literal assigned to `key` in a config's source.
 *
 * Deliberately narrow: it matches a literal, not an expression. A config that computed its
 * `testMatch` would fail here rather than being read approximately, which is the right outcome —
 * this test would otherwise report a green it cannot back up.
 */
function regexOption(source: string, key: 'testMatch' | 'testIgnore'): RegExp {
  const found = new RegExp(`${key}:\\s*/((?:\\\\.|[^/\\\\])+)/([gimsuy]*)`).exec(source);
  if (!found?.[1]) throw new Error(`${key} is not a regex literal in this config`);
  return new RegExp(found[1], found[2]);
}

describe('the three browser tiers', () => {
  it('has at least one dedicated config and one spec to check', () => {
    // Without this the two suites below would pass vacuously on an empty listing, which is the
    // other way to write a test that cannot fail.
    expect(dedicatedConfigs.length).toBeGreaterThan(0);
    expect(specs.length).toBeGreaterThan(0);
  });

  const ignored = regexOption(read('playwright.config.ts'), 'testIgnore');

  /** Which specs each dedicated config claims, resolved against what is actually on disk. */
  const owned = new Map<string, string[]>(
    dedicatedConfigs.map((config) => {
      const match = regexOption(read(config), 'testMatch');
      return [config, specs.filter((spec) => match.test(spec))];
    }),
  );

  for (const [config, claimed] of owned) {
    it(`${config} selects a spec that exists`, () => {
      // A `testMatch` matching nothing is a tier that silently runs zero tests — the shape this
      // whole file exists to make loud.
      expect(claimed, `${config}'s testMatch selects none of: ${specs.join(', ')}`).not.toEqual([]);
    });

    for (const spec of claimed) {
      it(`${spec} is owned by ${config} and so is ignored by the fixture tier`, () => {
        // The defect this test was written after: a live spec collected by the base config too,
        // and run against a fixture that answers one canned reply to every question.
        expect(
          ignored.test(spec),
          `e2e/${spec} needs a live stack (${config}) but playwright.config.ts would also collect ` +
            `it and run it against e2e/fixture-service.ts`,
        ).toBe(true);
      });
    }
  }

  const claimedByAny = new Set([...owned.values()].flat());

  for (const spec of specs.filter((spec) => !claimedByAny.has(spec))) {
    it(`${spec} belongs to no dedicated tier and so still runs in the fixture tier`, () => {
      // The quieter direction: an over-broad ignore drops a spec out of CI without going red.
      expect(
        ignored.test(spec),
        `e2e/${spec} is ignored by playwright.config.ts and claimed by no other config, so it ` +
          `runs in no tier at all`,
      ).toBe(false);
    });
  }
});
