/**
 * Which Chemclaw3 revision this run's contract check reads, and where that choice came from.
 *
 *   node scripts/chemclaw3-ref.mjs                          # resolve, print, and hand it on
 *   node scripts/chemclaw3-ref.mjs --checked-out .chemclaw3 # print the commit that landed
 *
 * ## Why this exists
 *
 * `.github/workflows/ci.yml` used to resolve the sibling checkout's ref inline, as
 * `${{ inputs.chemclaw3_ref || vars.CHEMCLAW3_REF || 'main' }}`, and nothing said which of the
 * three arms a run had taken. That mattered for exactly one open question (`ISSUES.md`, "a
 * maintainer's `CHEMCLAW3_REF` pin may not survive a fork PR"): if `vars` is not populated on a
 * pull request from a fork, a pinned run silently falls through to `main`, and the log looked the
 * same either way. Now the resolution happens here, once, is printed with its source, and is handed
 * to the checkout step as an output — so the value printed *is* the value used, rather than a
 * second evaluation of the same expression that could drift from the first.
 *
 * Tooling rather than an assertion (`tests/gate.test.ts` lists it as such): it reports and passes
 * a value on. The one way it fails is a ref that could not be a git ref at all — a newline in a
 * value written to `$GITHUB_OUTPUT` would be read as a second output, so that is refused rather
 * than written.
 *
 * ## What it can and cannot say
 *
 * It can say which arm was taken, whether the run is a pull request from a fork, and — after the
 * checkout — which commit that ref named at that moment. It **cannot** tell a variable nobody set
 * from a variable GitHub withheld: both arrive as the empty string. That is why it prints the fork
 * status beside the source. A fork pull request that reports "variable unset" while the
 * repository's settings show `CHEMCLAW3_REF` set is the observation that answers the issue.
 *
 * Environment (all optional; `ci.yml` passes them):
 *   CHEMCLAW3_REF_INPUT     `inputs.chemclaw3_ref` (workflow_dispatch only)
 *   CHEMCLAW3_REF_VARIABLE  `vars.CHEMCLAW3_REF`
 *   PR_HEAD_REPOSITORY      `github.event.pull_request.head.repo.full_name`
 *   GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY — set by Actions.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/** The fallback when neither the dispatch input nor the repository variable names a revision. */
export const DEFAULT_REF = 'main';

/**
 * A branch, a tag or a SHA — and nothing that could break out of a `name=value` line. Stricter
 * than `git check-ref-format`, deliberately: every ref this family uses fits, and anything that
 * does not is more likely a paste accident than a revision.
 */
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The same precedence the workflow expression had: the dispatch input, then the repository
 * variable, then `main`. A value that is empty *or only whitespace* counts as unset — GitHub's `||`
 * treated only `''` as falsy, so a variable saved as a single space used to be passed to
 * `actions/checkout` as a ref.
 *
 * @param {{ input?: string, variable?: string }} given
 * @returns {{ ref: string, source: 'workflow_dispatch input' | 'repository variable' | 'default' }}
 */
export function resolveChemclaw3Ref({ input, variable }) {
  const fromInput = (input ?? '').trim();
  if (fromInput) return { ref: fromInput, source: 'workflow_dispatch input' };
  const fromVariable = (variable ?? '').trim();
  if (fromVariable) return { ref: fromVariable, source: 'repository variable' };
  return { ref: DEFAULT_REF, source: 'default' };
}

/** @param {string} ref */
export function isPlausibleRef(ref) {
  return REF_SHAPE.test(ref) && !ref.includes('..');
}

/**
 * Whether this run is a pull request whose head lives in another repository — the case the open
 * question is about. `null` when the run is not a pull request at all.
 *
 * @param {{ event?: string, headRepository?: string, repository?: string }} run
 * @returns {boolean | null}
 */
export function isForkPullRequest({ event, headRepository, repository }) {
  if (event !== 'pull_request') return null;
  return Boolean(headRepository) && headRepository !== repository;
}

/** @param {string} text */
function summary(text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function resolve() {
  const variable = env.CHEMCLAW3_REF_VARIABLE ?? '';
  const { ref, source } = resolveChemclaw3Ref({ input: env.CHEMCLAW3_REF_INPUT, variable });
  if (!isPlausibleRef(ref)) {
    console.error(
      `chemclaw3-ref: ${JSON.stringify(ref)} (from the ${source}) is not a branch, tag or SHA.`,
    );
    exit(1);
  }
  const fork = isForkPullRequest({
    event: env.GITHUB_EVENT_NAME,
    headRepository: env.PR_HEAD_REPOSITORY,
    repository: env.GITHUB_REPOSITORY,
  });

  const lines = [
    `Chemclaw3 ref: ${ref}`,
    `  from:        ${source}`,
    `  variable:    ${variable.trim() ? `CHEMCLAW3_REF=${variable.trim()}` : 'CHEMCLAW3_REF unset or not passed to this run'}`,
    `  event:       ${env.GITHUB_EVENT_NAME ?? '(not on Actions)'}${
      fork === null
        ? ''
        : fork
          ? ` from a fork (${env.PR_HEAD_REPOSITORY})`
          : ' from this repository'
    }`,
  ];
  console.log(lines.join('\n'));
  if (fork && source === 'default') {
    // Not a failure: an unset variable is the ordinary state. It is the one line that answers the
    // open question, so it is said rather than left to be inferred.
    console.log(
      '  note:        a fork pull request fell through to the default. If CHEMCLAW3_REF is set in ' +
        "this repository's settings, GitHub did not pass it to this run.",
    );
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `ref=${ref}\nsource=${source}\n`);
  }
  summary(`### Chemclaw3 revision\n\n- ref: \`${ref}\` (${source})`);
}

/** @param {string} dir */
function checkedOut(dir) {
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    console.error(`chemclaw3-ref: no git checkout at ${dir}: ${head.stderr.trim()}`);
    exit(1);
  }
  const commit = head.stdout.trim();
  console.log(`Chemclaw3 checked out at ${commit}`);
  summary(`- commit: \`${commit}\``);
}

function main() {
  const at = argv.indexOf('--checked-out');
  if (at === -1) return resolve();
  const dir = argv[at + 1];
  if (!dir) {
    console.error('chemclaw3-ref: --checked-out needs the checkout directory');
    exit(2);
  }
  return checkedOut(dir);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) main();
