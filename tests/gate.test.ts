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
 *    Groovy file is the exact shape that was removed. For the workflow that is an allowlist of
 *    what a step may be; for the Jenkinsfile, whose shell legitimately builds and deploys, it is a
 *    blacklist of spellings plus one allowlist — `node` may only run a file under `scripts/`.
 * 3. **An orphaned check.** `npm run smoke` and `npm run check:openapi` existed for months wired
 *    into nothing at all — scripts with a name, a docstring and no caller, which is a control that
 *    reads as one and is not. Every assertion script must be reachable from a composer, and one
 *    that is deliberately out of the offline gate must be out *in code*, not in prose. What
 *    reachability from `check:live` does and does not mean is written at `OPERATOR_COMPOSERS`:
 *    it is a named home a person can type, not a schedule anything runs on.
 *
 * The steps are read by asking `scripts/ci.mjs` (`--json`) rather than by regexing its source: a
 * basis that is re-derived rather than observed agrees with itself forever.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateSteps } from './gateSteps.ts';
import { invokedScripts } from './scriptInvocations.ts';

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
 *
 * **Stripping comments was not enough, and the sentence above used to be written as though it
 * were.** A string literal is not a comment: `check-container.mjs` *prints* the name of the script
 * it calls in its skip branch, so the same deletion still passed on `11a2771` with this helper
 * applied. Comment-stripping is therefore the right treatment for the two **pipelines** — YAML and
 * Groovy, where the thing that runs is a command line and there is no parser here to ask — and it
 * is *not* the treatment for a JavaScript file. Those go through `invokedScripts`
 * (`tests/scriptInvocations.ts`), which asks the TypeScript parser which names are arguments of a
 * call rather than which names are present.
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

/** The composers a pipeline runs. Everything in the gate is reachable from one of these. */
const GATE_COMPOSERS = ['ci', 'ci:container'];

/**
 * The composers an **operator** runs, by hand, against a live service.
 *
 * `check:live` is the only one, and it is deliberately called by no pipeline: a push runner has no
 * Chemclaw3 service to point it at, and the two scripts inside it exit non-zero rather than report
 * a pass they did not perform. So reachability from here means *"has a named home a person can
 * type"* and nothing more — it does not mean the script runs on any schedule, and the test below
 * pins that difference rather than leaving it to prose, because prose about it was written in the
 * present tense as though the wiring question were closed.
 */
const OPERATOR_COMPOSERS = ['check:live'];

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

  it('never builds the dev-auth bundle over the one `npm start` serves, and says so at the end', () => {
    // Driven before this: a green `npm run ci` left `dist/client/assets/devAuth-*.js` in place,
    // because `dev-auth-build` wrote over `dist/client` and no later step rebuilt it — and
    // `npm start` is `node dist/server.js` with `CLIENT_DIR` defaulting to that directory. The
    // browser suite legitimately needs that bundle; nothing needs it *there*.
    //
    // Two halves, because either alone comes back: no build step that opts into dev auth may write
    // to the production directory, and the gate's own last act is to assert that directory is
    // clean — which is the step that would have failed the day this was introduced.
    const builds = STEPS.filter(
      (step) => step.env?.ALLOW_DEV_AUTH === 'true' && step.run.startsWith('build'),
    );
    expect(builds.length).toBeGreaterThan(0);
    for (const step of builds) {
      expect(
        step.env?.CLIENT_OUT_DIR,
        `${step.name} must build somewhere other than dist/client`,
      ).toBeDefined();
      expect(step.env?.CLIENT_OUT_DIR).not.toBe('dist/client');
    }

    const last = STEPS[STEPS.length - 1];
    expect(last?.run).toBe('check:no-dev-auth');
    expect(last?.env?.ALLOW_DEV_AUTH, 'the last step reads the production bundle').toBeUndefined();
    expect(last?.env?.CLIENT_DIR, 'the last step reads the default client dir').toBeUndefined();
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
    //
    // Both halves pin an **invocation** rather than a mention, and the two have to be asked
    // differently. The Jenkinsfile's is a shell line, so it is pinned as one — a command whose
    // head is `node` running that file, which neither a comment nor an `echo` naming it can
    // satisfy. The script's is JavaScript, so the parser is asked: measured on `11a2771`, a
    // `toContain` over this file stayed green with the real
    // `run(process.execPath, ['scripts/check-serving.mjs', …])` replaced by `{ status: 0 }`,
    // because the skip branch *prints* the name.
    expect(code(jenkinsfile)).toMatch(/^\s*(?:\w+=\S+\s+)*node scripts\/check-serving\.mjs\b/m);
    expect([...invokedScripts(read('scripts/check-container.mjs'))]).toContain('check-serving.mjs');
  });

  it('tells a print of a script name apart from a call of it', () => {
    // Guard the guard. The assertion above is worth exactly as much as this distinction, and the
    // helper it replaced could not make it.
    expect([...invokedScripts("run(process.execPath, ['scripts/x.mjs', url]);")]).toEqual([
      'x.mjs',
    ]);
    expect([...invokedScripts("console.log('by calling scripts/x.mjs');")]).toEqual([]);
  });

  it('names the runtime that holds the image when the build happened elsewhere', () => {
    // CI's container job builds with `docker/build-push-action` + `load: true`, which loads into
    // the **Docker** daemon's store. `ubuntu-latest` also ships podman, and the script preferred
    // podman — so under SKIP_IMAGE_BUILD it looked in an empty store and tried to *pull* the local
    // tag from a registry:
    //
    //     Trying to pull docker.io/library/chemclaw3-ui:ci... requested access to the resource is denied
    //
    // The autodetect is right for the path that builds the image here and wrong for the path that
    // does not, so the pipeline that built it says which runtime holds it. This pins both halves,
    // because either alone leaves the divergence that produced the failure.
    // Sliced to the `runner` resolution itself rather than grepped over the whole file: the
    // refusal message names `CONTAINER_RUNTIME` too, so a file-wide `toContain` stays green with
    // the autodetect put back — an assertion about a diagnostic standing in for one about which
    // store gets looked in.
    const script = code(read('scripts/check-container.mjs'));
    const runnerDecl = script.slice(
      script.indexOf('const runner ='),
      script.indexOf('if (!runner)'),
    );
    expect(runnerDecl).toContain('CONTAINER_RUNTIME');

    const workflow = read('.github/workflows/ci.yml');
    const containerStep = workflow.slice(workflow.indexOf('npm run ci:container') - 600);
    expect(containerStep).toMatch(/CONTAINER_RUNTIME:\s*docker/);

    // And the variable in the same env block that *arms* the job, which is the one that decides
    // whether anything is asserted at all: without it, a runner whose container runtime does not
    // answer skips the whole step and exits 0. Measured on `11a2771` — deleting this line from the
    // workflow left every meta-test green, while this test pinned the cosmetic half of the block
    // beside it, which made the omission read as deliberate.
    expect(containerStep).toMatch(/CI_REQUIRE_CONTAINER:\s*'1'/);
  });
});

describe('no pipeline holds an assertion of its own', () => {
  /**
   * What a step of `.github/workflows/ci.yml` is allowed to be.
   *
   * An allowlist, not a list of forbidden spellings, and that is the whole change: every step in
   * this file is of one shape — install something, or run a named script — so the permitted set
   * can be written down, and anything else is red until somebody argues for it here. A blacklist
   * fails *open* on the spelling nobody thought of, and this one did. Measured against the four it
   * knew (`curl`, `grep`, `node -e`, `mktemp`): `wget -qO- … | tee`, `node --eval "…"` and
   * `test -f dist/client/index.html || exit 1` all passed. `node --eval` is the same mechanism as
   * the `node -e` MSAL probe the rule was written for, three characters apart.
   */
  const PERMITTED_GITHUB_STEP = [/^npm\s/, /^npx\s/, /^node scripts\/[\w.-]+\.mjs\b/];

  /**
   * Every command line a `run:` step hands to the shell, block scalars included.
   *
   * The block form matters even though nothing uses it today: `run: |` is exactly where a
   * multi-line assertion would go, and a reader of single-line `run:` values would not see it.
   */
  const githubRunCommands = (): string[] => {
    const lines = workflow.split('\n');
    const commands: string[] = [];
    for (const [index, line] of lines.entries()) {
      const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
      if (!match) continue;
      const indent = (match[1] ?? '').length;
      const value = (match[2] ?? '').trim();
      if (!/^[|>]/.test(value)) {
        if (value) commands.push(value);
        continue;
      }
      for (const next of lines.slice(index + 1)) {
        if (next.trim() === '') continue;
        if (next.search(/\S/) <= indent) break;
        commands.push(next.trim());
      }
    }
    return commands;
  };

  it('lets a GitHub step install something or run a named script, and nothing else', () => {
    const commands = githubRunCommands();
    // Guard the guard: a parser that found nothing would pass for ever.
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      expect(
        PERMITTED_GITHUB_STEP.some((shape) => shape.test(command)),
        `.github/workflows/ci.yml runs \`${command}\` — a step may install or run a named script; an assertion belongs in scripts/`,
      ).toBe(true);
    }
  });

  /**
   * The shell an inline assertion is written in, for the file where an allowlist is not available.
   *
   * The Jenkinsfile's shell legitimately builds an image, logs into a registry, copies a bundle
   * out of a container and rolls out a Deployment — there is no small set of permitted command
   * heads there, and writing one would mean re-approving the list on every delivery change, which
   * is how an allowlist becomes a rubber stamp. So this half stays a blacklist, and stays honest
   * about what that means: **it catches spellings, not intent.** `curl` and `grep` are how every
   * removed assertion was spelled, `mktemp` is how the standalone-server run was, and `wget` and
   * the file tests are the two spellings measured as walking past the original four.
   *
   * The one allowlist that does carry into both files is the `node` rule below, because the
   * interpreter this repository actually uses is the one an assertion would most naturally be
   * smuggled through.
   */
  const ASSERTION_SHELL = [
    /\bcurl\b/,
    /\bwget\b/,
    /\bgrep\b/,
    /\bmktemp\b/,
    /\btest\s+-[a-z]\b/,
    /\[\s+-[a-z]\s/,
  ];

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

    it(`lets ${file} run node only as \`node scripts/<file>.mjs\``, () => {
      // `node -e`, `node --eval` and `node -p` are one flag apart from each other and from the
      // legitimate form, so the target is pinned rather than the flags enumerated. A pipeline that
      // needs a new script writes the script.
      const runs = [...code(source).matchAll(/(?:^|[\s;&|(])node\s+(\S+)/g)];
      for (const run of runs) {
        expect(run[1], `${file} runs \`node ${run[1]}\``).toMatch(/^scripts\/[\w.-]+\.mjs$/);
      }
    });
  }
});

/**
 * The scripts under `scripts/` that are tooling rather than assertions.
 *
 * Named as an exception list rather than derived from a naming convention, so that the rule below
 * fails *toward* catching: a new `scripts/*.mjs` is an assertion until somebody writes it in here,
 * and writing it in here is a line in a diff a reviewer sees. The guard this replaced keyed on the
 * `check-`/`assert-`/`smoke` prefixes and on the `check:` npm-script prefix, so — measured —
 * an unreachable `"verify:thing": "node scripts/verify-thing.mjs"` was invisible to it while an
 * unreachable `check:`-prefixed one was caught. An author naming the next assertion `verify-*` got
 * no guard at all.
 */
const TOOLING = new Set([
  'ci.mjs',
  'dev.mjs',
  'build-server.mjs',
  'compress-assets.mjs',
  // Measurement, not assertion: it prints a table and exits 0 whatever the numbers are. It is in
  // this list rather than in the gate for the reason `check:live` is outside it — it needs a real
  // Chromium and a dev server and takes minutes — and it is an npm script at all so that the
  // figures W28.7 published can be re-run by somebody who does not already know it exists.
  'measure-rdkit-placement.mjs',
  // The same, for the defect rather than for the cost: it sweeps lengths across fresh pages and
  // prints where the seam stops agreeing with the engine under it (`ISSUES.md` Issue 11). Also a
  // measurement — the behaviour it found is held by `tests/rdkitTooComplex.test.tsx`, which is in
  // the gate, and this prints a table and exits 0.
  'measure-rdkit-rangeerror.mjs',
]);

/** Every `scripts/*.mjs` an npm script's command line names. */
const scriptsNamedBy = (command: string): string[] =>
  [...command.matchAll(/scripts\/([\w.-]+\.mjs)/g)].map((m) => m[1] as string);

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
    for (const composer of [...GATE_COMPOSERS, ...OPERATOR_COMPOSERS]) visit(composer);

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
        [...invokedScripts(read(`scripts/${file}`), file)].filter((named) => named !== file),
      ),
    );
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const file of indirect) if (command.includes(`scripts/${file}`)) seen.add(name);
    }
    return seen;
  };

  it('reaches every assertion script from a composer', () => {
    const reachable = reachableScripts();
    // The union of the two ways an npm script can be an assertion: it is named like one, or it
    // runs a file under `scripts/` that is not tooling. The second arm is what makes this a rule
    // about shape rather than about the `check:` prefix — `npm run check:audit` is only in the set
    // by the first, and an unreachable `verify:thing` is only caught by the second.
    const checks = Object.keys(pkg.scripts).filter(
      (name) =>
        name.startsWith('check:') ||
        name === 'smoke' ||
        scriptsNamedBy(pkg.scripts[name] ?? '').some((file) => !TOOLING.has(file)),
    );
    expect(checks.length).toBeGreaterThan(4);
    for (const name of checks) {
      expect(
        reachable.has(name),
        `npm run ${name} is wired into nothing — put it in the gate, in check:live, or delete it`,
      ).toBe(true);
    }
  });

  it('keeps every script under scripts/ named by some npm script', () => {
    const commands = Object.values(pkg.scripts).join('\n');
    const files = Object.values(pkg.scripts).flatMap((command) => scriptsNamedBy(command));
    const referenced = new Set([
      ...files,
      // Followed one hop, same as above — and by invocation rather than by mention, so a file that
      // is merely *printed* by a reachable script does not count as named.
      ...files.flatMap((file) => [...invokedScripts(read(`scripts/${file}`), file)]),
    ]);
    // Every `.mjs` in the directory, with no prefix convention in the way: a file nobody can run
    // by name is a file that can only be run by somebody who already knows it exists, and that is
    // as true of `verify-thing.mjs` as of `check-thing.mjs`.
    const assertions = readdirSync(new URL('scripts/', root)).filter((name) =>
      name.endsWith('.mjs'),
    );
    expect(assertions.length).toBeGreaterThan(4);
    for (const file of assertions) {
      expect(
        referenced.has(file) || commands.includes(`scripts/${file}`),
        `scripts/${file} has no npm script — it can only be run by somebody who already knows it exists`,
      ).toBe(true);
    }
  });

  it('keeps the operator composers out of both pipelines, which is what makes them operator-run', () => {
    // The claim "check:live is where these live" is worth only what it costs to check. If somebody
    // wires it into a pipeline, this fails and points at the sentence in README.md and ISSUES.md
    // that would have to change with it — the two places that describe the orphan as solved.
    for (const composer of OPERATOR_COMPOSERS) {
      expect(pkg.scripts, composer).toHaveProperty(composer);
      for (const [file, source] of [
        ['.github/workflows/ci.yml', workflow],
        ['Jenkinsfile', jenkinsfile],
      ] as const) {
        expect(
          code(source).includes(`npm run ${composer}`),
          `${file} runs npm run ${composer} — it is documented as operator-run and is not part of any gate`,
        ).toBe(false);
      }
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
