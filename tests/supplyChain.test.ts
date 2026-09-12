// @vitest-environment node

/**
 * The two halves of a dependency supply chain, and the fact that each is worthless alone.
 *
 * A floating action tag (`actions/checkout@v4`) is a mutable pointer into somebody else's
 * repository: whoever can move that tag runs arbitrary code in this repository's CI, with its
 * token. Pinning the digest closes that — and immediately opens the other failure, because a pinned
 * digest never floats to a fix either. So the pin and the updater that rewrites it are one control
 * with two files, and this test refuses to let either half exist without the other.
 *
 * The audit step is asserted for the same reason rather than for its own: `.github/dependabot.yml`
 * says in prose that the gate is scoped to production *because* Dependabot's security updates cover
 * the dev tree. Delete the step and that paragraph becomes a description of a control nobody runs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateSteps } from './gateSteps.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const WORKFLOWS = readdirSync(new URL('../.github/workflows', import.meta.url)).filter((f) =>
  /\.ya?ml$/.test(f),
);

describe('the GitHub Actions this repository runs', () => {
  it('has at least one workflow to check', () => {
    // Or every assertion below passes over an empty list, which is the shape of a test that cannot
    // fail.
    expect(WORKFLOWS.length).toBeGreaterThan(0);
  });

  for (const file of WORKFLOWS) {
    it(`pins every action to a digest, with the version it names, in ${file}`, () => {
      const uses = [
        ...read(`.github/workflows/${file}`).matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm),
      ].map((m) => (m[1] ?? '').trim());
      expect(uses.length).toBeGreaterThan(0);

      for (const line of uses) {
        // `owner/repo@<40 hex> # vX.Y.Z`. The comment is not decoration: a bare digest tells a
        // reviewer nothing about what it is, and Dependabot rewrites the two together.
        expect(line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    });
  }
});

describe('the updater that keeps those pins from going stale', () => {
  const dependabot = read('.github/dependabot.yml');

  for (const ecosystem of ['github-actions', 'npm']) {
    it(`covers the ${ecosystem} ecosystem`, () => {
      expect(dependabot).toMatch(
        new RegExp(`^\\s*- package-ecosystem: ["']?${ecosystem}["']?$`, 'm'),
      );
    });
  }
});

describe('the vulnerability gate', () => {
  const ci = read('.github/workflows/ci.yml');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('audits the production closure, blocking', () => {
    // This used to locate a whole `- run: npm audit` step inside ci.yml. That step no longer
    // exists there and the audit did not go anywhere: the gate is one definition now
    // (`scripts/ci.mjs`), which both pipelines call, so the question "does the gate audit" is asked
    // of the gate. Asking the workflow would have gone on being answerable only for as long as the
    // workflow was the gate — and would have said "no audit" the moment it stopped being one,
    // which is the wrong answer in the alarming direction.
    const audit = gateSteps().filter((step) => /^npm audit\b/.test(pkg.scripts[step.run] ?? ''));

    expect(audit, 'no step of the gate runs `npm audit`').toHaveLength(1);
    expect(pkg.scripts[audit[0]?.run ?? '']).toMatch(/npm audit .*--omit=dev/);
  });

  it('cannot be waved through in the workflow that runs it', () => {
    // A gate that cannot fail is the failure this one exists to avoid being: an advisory that
    // scrolls past in a green run trains everyone to stop reading it. `continue-on-error` on the
    // step that runs the gate would do exactly that to all thirteen steps at once, which is a
    // larger version of the same defect than the one this assertion originally guarded.
    const gate = ci
      .split(/^ {6}- /m)
      .filter((step) => /run: npm run ci(:container)?\s*$/m.test(step));
    expect(gate, 'no step in ci.yml runs the gate').toHaveLength(2);
    for (const step of gate) expect(step).not.toMatch(/continue-on-error/);
  });
});
