// @vitest-environment node

/**
 * One gate definition, and nothing allowed to hold a second edition of it.
 *
 * Before this, `.github/workflows/ci.yml` carried four assertions as inline shell plus a whole
 * `container` job of `curl`s, and `Jenkinsfile` carried a narrower gate of its own — no
 * `npm audit`, no contrast check, no browser suite — plus a hand-written copy of those same
 * `curl`s. Two gates over one repository is not two gates: it is one bar that nobody can state,
 * and the quieter pipeline is the one people come to believe.
 *
 * `scripts/ci.mjs` is the definition now. What this file holds is the three ways it could quietly
 * stop being the definition:
 *
 * 1. **A step that names nothing.** A renamed npm script would leave the gate green by skipping.
 * 2. **A pipeline growing its own assertion again.** Inline `curl`/`grep`/`node -e` in a YAML or
 *    Groovy file is the exact shape that was removed, and it is recognisable as text.
 * 3. **An orphaned check.** `npm run smoke` and `npm run check:openapi` existed for months wired
 *    into nothing at all — scripts with a name, a docstring and no caller, which is a control that
 *    reads as one and is not. Every assertion script must be reachable from a composer, and one
 *    that is deliberately out of the offline gate must be out *in code*, not in prose.
 *
 * The steps are read by asking `scripts/ci.mjs` (`--json`) rather than by regexing its source: a
 * basis that is re-derived rather than observed agrees with itself forever.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateSteps } from './gateSteps.ts';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/**
 * A file with its comments removed.
 *
 * Every assertion below is about what a file *runs*, and every one of these files documents in
 * prose the very thing the assertion looks for — each script opens with its own
 * `node scripts/<itself>.mjs` usage line, and both pipelines now carry comments naming the scripts
 * they call. Matching the raw text would let a comment stand in for a call, which is the failure
 * this whole file is about one level down. Measured: with comments left in, deleting
 * `check-container.mjs`'s actual invocation of `check-serving.mjs` still passed.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/|\*)/.test(line))
    .join('\n');

const STEPS = gateSteps();

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const workflow = read('.github/workflows/ci.yml');
const jenkinsfile = read('Jenkinsfile');

/**
 * The checks that need a **live Chemclaw3 service** and therefore cannot be in an offline gate.
 *
 * Both exit non-zero when they cannot reach one, deliberately — `scripts/check-openapi.mjs` argues
 * it in its own comments: "a check that reports success it did not perform is worse than no
 * check". Putting either in `npm run ci` would mean a permanently red gate, or teaching them to
 * pass when they did not run, and the second is the failure mode they exist to refuse. They are
 * `npm run check:live` instead — a named home, which is what they did not have.
 */
const NEEDS_A_LIVE_SERVICE = ['smoke', 'check:openapi'];

describe('the gate definition', () => {
  it('names an npm script that exists, for every step', () => {
    expect(STEPS.length).toBeGreaterThan(0);
    for (const step of STEPS) {
      expect(pkg.scripts, `step "${step.name}" runs \`npm run ${step.run}\``).toHaveProperty(
        step.run,
      );
    }
  });

  it('gives every step a reason, so --list is readable by somebody who did not write it', () => {
    for (const step of STEPS) expect(step.why.length, step.name).toBeGreaterThan(20);
  });
});

describe('both pipelines call the one definition', () => {
  it('has the GitHub workflow run `npm run ci` and `npm run ci:container`', () => {
    expect(workflow).toMatch(/run: npm run ci$/m);
    expect(workflow).toMatch(/run: npm run ci:container$/m);
  });

  it('has the Jenkins gate run `npm run ci`', () => {
    expect(jenkinsfile).toContain("sh 'npm run ci'");
  });

  it('has the Jenkins image stage run the same serving assertions the container job runs', () => {
    // Not a copy of them: the one file, called from both. How the image was *built* legitimately
    // differs per pipeline; what it must serve does not.
    expect(code(jenkinsfile)).toContain('scripts/check-serving.mjs');
    expect(code(read('scripts/check-container.mjs'))).toContain('scripts/check-serving.mjs');
  });
});

describe('no pipeline holds an assertion of its own', () => {
  /**
   * The shell an inline assertion is written in. `curl` and `grep` are how every removed one was
   * spelled; `node -e` is how the MSAL entry-chunk probe was; `mktemp` is how the standalone
   * server run was. A pipeline may still decide *where* a step runs — which is why `npm`, `npx`
   * and a container build are not on this list.
   */
  const ASSERTION_SHELL = [/\bcurl\b/, /\bgrep\b/, /node -e/, /\bmktemp\b/];

  for (const [file, source] of [
    ['.github/workflows/ci.yml', workflow],
    ['Jenkinsfile', jenkinsfile],
  ] as const) {
    it(`keeps assertion shell out of ${file}`, () => {
      // Comments are where the *reasoning* lives and may name anything; only what runs is checked.
      const runnable = code(source);
      for (const shape of ASSERTION_SHELL) {
        expect(
          runnable,
          `${file} runs ${shape.source} — that assertion belongs in scripts/`,
        ).not.toMatch(shape);
      }
    });
  }
});

describe('no assertion is orphaned', () => {
  /**
   * Every npm script that can be reached by running a composer, following `npm run` through the
   * composers and `scripts/*.mjs` through the files they invoke by path.
   */
  const reachableScripts = (): Set<string> => {
    const seen = new Set<string>();
    const direct = new Set<string>();
    const visit = (name: string): void => {
      if (seen.has(name) || !(name in pkg.scripts)) return;
      seen.add(name);
      const command = pkg.scripts[name] ?? '';
      for (const m of command.matchAll(/npm run (?:--silent )?([\w:-]+)/g)) visit(m[1] as string);
      for (const m of command.matchAll(/scripts\/([\w.-]+\.mjs)/g)) direct.add(m[1] as string);
      if (name === 'ci') for (const step of STEPS) visit(step.run);
    };
    for (const composer of ['ci', 'ci:container', 'check:live']) visit(composer);

    // One hop further, and only one hop of a particular kind: a file that a *reachable file*
    // invokes by path. `check-container.mjs` runs `check-serving.mjs` that way, because it has to
    // hand it a URL it minted, so `npm run check:serving` is genuinely part of the gate.
    //
    // Deliberately NOT "any npm script naming a file the gate happens to run": a second script
    // pointed at `check-bundle.mjs` would then be reachable by borrowing the first one's callers,
    // which is precisely the orphan this test exists to catch. Measured — that version of this
    // helper passed with a freshly added `"check:orphan": "node scripts/check-bundle.mjs"`.
    //
    // A file naming *itself* does not count, which is not a detail: every script here opens with a
    // `node scripts/<itself>.mjs` usage line, so without this the whole of `direct` lands in
    // `indirect` and the paragraph above stops being true. Measured — with self-references
    // counted, that same `"check:orphan"` passed again.
    const indirect = new Set(
      [...direct].flatMap((file) =>
        [...code(read(`scripts/${file}`)).matchAll(/scripts\/([\w.-]+\.mjs)/g)]
          .map((m) => m[1] as string)
          .filter((named) => named !== file),
      ),
    );
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const file of indirect) if (command.includes(`scripts/${file}`)) seen.add(name);
    }
    return seen;
  };

  it('reaches every check: script from a composer', () => {
    const reachable = reachableScripts();
    const checks = Object.keys(pkg.scripts).filter(
      (name) => name.startsWith('check:') || name === 'smoke',
    );
    expect(checks.length).toBeGreaterThan(4);
    for (const name of checks) {
      expect(
        reachable.has(name),
        `npm run ${name} is wired into nothing — put it in the gate, in check:live, or delete it`,
      ).toBe(true);
    }
  });

  it('keeps every assertion script under scripts/ named by some npm script', () => {
    const commands = Object.values(pkg.scripts).join('\n');
    const files = Object.values(pkg.scripts)
      .flatMap((command) => [...command.matchAll(/scripts\/([\w.-]+\.mjs)/g)])
      .map((m) => m[1] as string);
    const referenced = new Set([
      ...files,
      // Followed one hop, same as above.
      ...files.flatMap((file) =>
        [...code(read(`scripts/${file}`)).matchAll(/scripts\/([\w.-]+\.mjs)/g)].map(
          (m) => m[1] as string,
        ),
      ),
    ]);
    const assertions = readdirSync(new URL('scripts/', root)).filter((name) =>
      /^(check-|assert-|smoke)/.test(name),
    );
    expect(assertions.length).toBeGreaterThan(4);
    for (const file of assertions) {
      expect(
        referenced.has(file) || commands.includes(`scripts/${file}`),
        `scripts/${file} has no npm script — it can only be run by somebody who already knows it exists`,
      ).toBe(true);
    }
  });

  it('keeps the live-service checks out of the offline gate and inside check:live', () => {
    // Both halves matter. In the gate they would be red on a laptop; out of `check:live` they
    // would be orphaned again, which is where they started.
    for (const name of NEEDS_A_LIVE_SERVICE) {
      expect(pkg.scripts, name).toHaveProperty(name);
      expect(pkg.scripts['check:live'], `check:live must name ${name}`).toContain(name);
      expect(
        STEPS.some((step) => step.run === name),
        `${name} needs a live Chemclaw3 service and cannot be a step of the offline gate`,
      ).toBe(false);
    }
  });
});
