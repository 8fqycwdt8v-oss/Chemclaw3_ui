/**
 * The gate, once, so that no pipeline has to describe it.
 *
 *   node scripts/ci.mjs                 # every step, in order        (npm run ci)
 *   node scripts/ci.mjs --list          # what the steps are and why
 *   node scripts/ci.mjs --json          # the same, for `tests/gate.test.ts`
 *   node scripts/ci.mjs bundle e2e      # just those, by name
 *
 * ## Why this file exists
 *
 * `.github/workflows/ci.yml` used to carry four assertions as inline shell — the `/config.js`
 * reference, the MSAL entry-chunk probe with its positive control, and running `dist/server.js`
 * from an empty temp directory — plus a whole `container` job of `curl`s. None of them had a name
 * a contributor could type. The only way to run them was to copy YAML into a terminal, which in
 * practice means they were run by the pipeline and by nobody else.
 *
 * `Jenkinsfile` was a second, narrower gate over the same repository: typecheck, lint,
 * format:check, test and build, with no `npm audit`, no contrast check and no browser suite. Two
 * gates that disagree drift, and the direction of the drift is always the same — the quieter one
 * becomes what people believe the bar is.
 *
 * So the steps live here, each one a named npm script, and both pipelines call this. A pipeline
 * may still decide *where* a step runs (GitHub splits the container work onto its own runner for
 * the parallelism and the layer cache) but it may no longer decide *what* the step asserts.
 *
 * ## What is deliberately not here
 *
 * `npm run smoke` and `npm run check:openapi` both require a **live Chemclaw3 service** and both
 * exit non-zero when they cannot reach one — deliberately, and `check-openapi.mjs` says so in its
 * own comments: "a check that reports success it did not perform is worse than no check". Putting
 * either in an offline gate would mean either a permanently red gate or teaching them to pass when
 * they did not run, and the second is the failure mode they were written to refuse. They are
 * `npm run check:live` instead, which is the named home they did not have.
 *
 * ## What the container step does
 *
 * `npm run ci:container` is the other half of the definition and is not in the list below, because
 * it needs a container runtime and GitHub runs it on a second runner. It **skips with a reason**
 * where there is none, and `CI_REQUIRE_CONTAINER=1` turns that skip into a failure — which is what
 * both pipelines set. `npm run ci:all` is the local one-command form of "everything".
 */

import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The gate, in order. `run` is an npm script name, so `package.json` stays the single registry of
 * what each step *is* and this file holds only the order and the environment it needs.
 */
export const STEPS = [
  {
    name: 'audit',
    run: 'check:audit',
    why: 'the production dependency closure, which is what a chemist’s browser executes',
  },
  {
    name: 'typecheck',
    run: 'typecheck',
    why: 'tsc -b, strict and noUncheckedIndexedAccess, over every project',
  },
  {
    name: 'lint',
    run: 'lint',
    why: 'exhaustive-deps above all: a stale closure fails intermittently',
  },
  { name: 'format', run: 'format:check', why: 'prettier, so a diff is about the change' },
  { name: 'test', run: 'test', why: 'the vitest suite — everything that is a fact about a module' },
  {
    name: 'contrast',
    run: 'check:contrast',
    why: 'a token pair that reads fine and measures 2:1 is invisible in review',
  },
  {
    name: 'build',
    run: 'build',
    why: 'the client bundle and the esbuild server bundle the image copies',
  },
  {
    name: 'bundle',
    run: 'check:bundle',
    why: 'facts about the emitted chunks: /config.js survives, MSAL stays lazy',
  },
  {
    name: 'standalone',
    run: 'check:standalone',
    why: 'dist/server.js runs with no node_modules, as the image expects',
  },
  {
    name: 'no-dev-auth',
    run: 'check:no-dev-auth',
    why: 'no unauthenticated auth provider in a default production bundle',
  },
  {
    name: 'dev-auth-build',
    run: 'build:client',
    env: { ALLOW_DEV_AUTH: 'true' },
    why: 'the browser suite drives a production build unauthenticated, so it needs the opt-in one',
  },
  {
    name: 'dev-auth-present',
    run: 'check:no-dev-auth',
    env: { ALLOW_DEV_AUTH: 'true' },
    why: 'the other direction: a marker string that went stale fails here rather than passing quietly',
  },
  {
    name: 'e2e',
    run: 'test:e2e',
    why: 'the browser suite, against the bundle the two steps above just built',
  },
];

/** Run the gate. A function rather than top-level code so that `--json` below can be asked for the
 *  steps without running any of them. */
function main() {
  const args = process.argv.slice(2);

  // `--json` is how `tests/gate.test.ts` learns what the gate is: it asks this file and parses
  // the answer, rather than regexing STEPS back out of the source. A basis that is re-derived
  // rather than observed agrees with itself forever.
  if (args.includes('--json')) {
    console.log(JSON.stringify(STEPS));
    exit(0);
  }

  if (args.includes('--list') || args.includes('-l')) {
    console.log('\nSteps, in order:\n');
    for (const step of STEPS) {
      const env = step.env
        ? ` [${Object.entries(step.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}]`
        : '';
      console.log(`  ${step.name.padEnd(16)} npm run ${step.run}${env}`);
      console.log(`  ${''.padEnd(16)} ${step.why}\n`);
    }
    console.log('  Not in the list, and why:');
    console.log('    ci:container    needs a container runtime; skips with a reason without one.');
    console.log(
      '    check:live      smoke + check:openapi, which need a live Chemclaw3 service.\n',
    );
    exit(0);
  }

  const selected = args.length > 0 ? STEPS.filter((step) => args.includes(step.name)) : STEPS;
  const unknown = args.filter((arg) => !STEPS.some((step) => step.name === arg));
  if (unknown.length > 0) {
    console.error(`ci: no such step: ${unknown.join(', ')}. Try --list.`);
    exit(2);
  }

  const started = Date.now();
  const durations = [];

  for (const [index, step] of selected.entries()) {
    const label = `[${index + 1}/${selected.length}] ${step.name}`;
    console.log(`\n── ${label} ── npm run ${step.run}`);
    const at = Date.now();
    const result = spawnSync('npm', ['run', '--silent', step.run], {
      stdio: 'inherit',
      env: { ...process.env, ...step.env },
      shell: process.platform === 'win32',
    });
    const seconds = ((Date.now() - at) / 1000).toFixed(1);
    if (result.status !== 0) {
      console.error(`\n✗ ${step.name} failed after ${seconds}s — ${step.why}`);
      console.error(`  Reproduce with: npm run ci -- ${step.name}\n`);
      exit(result.status ?? 1);
    }
    durations.push([step.name, seconds]);
  }

  const total = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n── gate green — ${selected.length} step(s) in ${total}s\n`);
  for (const [name, seconds] of durations) console.log(`  ${name.padEnd(16)} ${seconds}s`);
  console.log('');
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) main();
