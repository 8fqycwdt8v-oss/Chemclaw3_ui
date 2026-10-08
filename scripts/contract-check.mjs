/**
 * Is the committed API contract what core published at the commit this repository pins?
 *
 *   node scripts/contract-check.mjs               # the check          (npm run contract:check)
 *   node scripts/contract-check.mjs --pinned-sha  # print the pinned commit; for CI's checkout
 *
 * Two questions, asked in order:
 *
 *  1. **Is the copy what the lock says?** The sha256 and `info.version` in `contracts/core.lock`
 *     must match `contracts/core-openapi.json`. Needs nothing but this tree, so it always runs: an
 *     edited copy or a hand-edited lock fails here.
 *  2. **Is the copy what core had at the pinned commit?** Reads `schema/api/openapi.json` out of
 *     a Chemclaw3 checkout at *that commit* — `git show <sha>:<path>`, never the checkout's
 *     working tree or its `main`, so a core that has moved on cannot red this repository.
 *
 * The checkout is `CHEMCLAW3_DIR`, else a sibling `../Chemclaw3`. A `CHEMCLAW3_DIR` checkout that
 * lacks the pinned commit is fetched into (`git fetch --depth 1 origin <sha>`) when
 * `CHEMCLAW3_REQUIRED=1`, which is the CI setting; the implicit sibling is never written to.
 *
 * With `CHEMCLAW3_REQUIRED=1` the second question must be answered: no checkout, an unreachable
 * commit or a missing file is a failure, never a pass. Without it the second question is skipped
 * *out loud* and the exit code is 0, because a developer without core beside them is not broken.
 *
 * Bumping the contract is a change to the copy and the lock together; `docs/api-contract.md` has
 * the steps.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ROOT, readCopy, readLock, sha256 } from './lib/contractLock.mjs';

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The checkout to read, or `null`: the variable a lane sets, else a sibling directory. Only the
 * named one may be fetched into — a developer's own sibling checkout is read, never written to.
 */
function checkoutDir() {
  const named = (env.CHEMCLAW3_DIR ?? '').trim();
  if (named) return { dir: resolve(process.cwd(), named), from: 'CHEMCLAW3_DIR', fetchable: true };
  const sibling = resolve(ROOT, '..', 'Chemclaw3');
  return existsSync(sibling)
    ? { dir: sibling, from: 'the sibling ../Chemclaw3', fetchable: false }
    : null;
}

/**
 * A file of core as it was at the locked commit, or `{ problem }` when it cannot be read at all.
 * Never core's `main`: the blob is read with `git show <sha>:<path>`.
 *
 * @param {ReturnType<typeof readLock>} lock
 * @param {boolean} required
 * @param {string} [path] defaults to the contract document
 */
export function coreFileAtPin(lock, required, path = lock.path) {
  const found = checkoutDir();
  if (!found) {
    return {
      problem: 'no Chemclaw3 checkout: set CHEMCLAW3_DIR to one (or put it at ../Chemclaw3)',
    };
  }
  const { dir, from, fetchable } = found;
  const has = () => git(['cat-file', '-e', `${lock.commit}^{commit}`], dir).status === 0;
  if (git(['rev-parse', '--git-dir'], dir).status !== 0) {
    return { problem: `${from} (${dir}) is not a git checkout` };
  }
  if (!has()) {
    if (!required || !fetchable) {
      return {
        problem:
          `${from} (${dir}) does not contain ${lock.commit}; a checkout is fetched into only ` +
          'when CHEMCLAW3_DIR names it and CHEMCLAW3_REQUIRED=1',
      };
    }
    const fetched = git(['fetch', '--depth', '1', 'origin', lock.commit], dir);
    if (fetched.status !== 0 || !has()) {
      return {
        problem:
          `the pinned commit ${lock.commit} is not reachable from ${from} (${dir}): ` +
          (fetched.stderr || '').trim().split('\n').slice(-2).join(' '),
      };
    }
  }
  const shown = git(['show', `${lock.commit}:${path}`], dir);
  if (shown.status !== 0) {
    return {
      problem: `${path} does not exist at ${lock.commit}: ${(shown.stderr || '').trim()}`,
    };
  }
  return { text: shown.stdout, where: `${from} (${dir})` };
}

function main() {
  const lock = readLock();

  if (argv.includes('--pinned-sha')) {
    console.log(lock.commit);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha=${lock.commit}\n`);
    return;
  }

  const { bytes, document } = readCopy();
  const failures = [];

  const actual = sha256(bytes);
  if (actual !== lock.sha256) {
    failures.push(
      `contracts/core-openapi.json hashes to ${actual}, but contracts/core.lock says ${lock.sha256}. ` +
        'The copy was edited, or the lock was bumped without it — change both together.',
    );
  }
  const version = document?.info?.version;
  if (version !== lock.contract_version) {
    failures.push(
      `the copy declares info.version ${version}, but contracts/core.lock says ${lock.contract_version}.`,
    );
  }

  const required = env.CHEMCLAW3_REQUIRED === '1';
  const core = coreFileAtPin(lock, required);
  let compared = false;
  if ('problem' in core) {
    if (required) {
      failures.push(`cannot compare the copy with core at ${lock.commit}: ${core.problem}`);
    } else {
      console.warn(
        `contract:check SKIPPED the comparison with core — ${core.problem}.\n` +
          `  The copy was verified against its lock only. CHEMCLAW3_REQUIRED=1 makes this a failure.`,
      );
    }
  } else {
    compared = true;
    if (sha256(core.text) !== lock.sha256) {
      failures.push(
        `contracts/core-openapi.json is not core's ${lock.path} at ${lock.commit} (read from ${core.where}): ` +
          `core's file hashes to ${sha256(core.text)}, the lock says ${lock.sha256}.`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`contract:check FAILED — ${failure}`);
    exit(1);
  }
  console.log(
    `contract:check ok — API contract ${lock.contract_version} (${lock.repository}@${lock.commit.slice(0, 12)}), ` +
      `copy matches its lock${compared ? ' and core at the pinned commit' : '; core NOT compared'}.`,
  );
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) main();
