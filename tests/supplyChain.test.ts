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

  it('audits the production closure, blocking', () => {
    // Located as a whole step rather than as a substring of the file, so the last two assertions
    // are about the step and not about the paragraph of comment above it. A gate that cannot fail
    // is the failure this one exists to avoid being: an advisory that scrolls past in a green run
    // trains everyone to stop reading it.
    const audit = ci.split(/^ {6}- /m).filter((step) => /run:\s*npm audit/.test(step));

    expect(audit, 'no step in ci.yml runs `npm audit`').toHaveLength(1);
    expect(audit[0]).toMatch(/npm audit .*--omit=dev/);
    expect(audit[0]).not.toMatch(/continue-on-error/);
  });
});
