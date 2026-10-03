/**
 * Give a Chemclaw3_mock checkout the `.venv` that `playwright.oidc-mock.config.ts` runs it from.
 *
 *   MOCK_DIR=../Chemclaw3_mock npm run provision:mock-tenant
 *
 * The OIDC lane (`npm run test:e2e:oidc-mock`) starts the stand-in Entra tenant as
 * `$MOCK_DIR/.venv/bin/python -m uvicorn app.main:app`, the same `.venv` path the mock's own
 * `start.sh` hardcodes. A fresh checkout has no such directory, so this creates it and installs the
 * mock the way its README says to (`pip install -e .`). An existing `.venv` is reused, and the
 * install re-run over it, so a local checkout that already has one is not rebuilt from scratch.
 *
 * Tooling rather than an assertion (`tests/gate.test.ts` lists it as such): it provisions and
 * asserts nothing. It is a file rather than inline shell in `.github/workflows/ci.yml` because a
 * workflow step there may only install with `npm`/`npx` or run `node scripts/<file>.mjs`.
 *
 * Environment:
 *   MOCK_DIR  the Chemclaw3_mock checkout (default `../Chemclaw3_mock`, as the config's)
 *   PYTHON    the interpreter that creates the venv (default `python3`; the mock needs >= 3.11)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env, exit } from 'node:process';

const mockDir = resolve(env.MOCK_DIR ?? '../Chemclaw3_mock');
const python = env.PYTHON ?? 'python3';

if (!existsSync(join(mockDir, 'pyproject.toml'))) {
  console.error(`provision-mock-tenant: ${mockDir} is not a Chemclaw3_mock checkout`);
  exit(1);
}

const run = (command, args) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: mockDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`provision-mock-tenant: \`${command}\` exited ${result.status ?? result.signal}`);
    exit(1);
  }
};

const venvPython = join(mockDir, '.venv', 'bin', 'python');
if (!existsSync(venvPython)) run(python, ['-m', 'venv', '.venv']);
run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '--quiet', '-e', '.']);
console.log(`provision-mock-tenant: ${venvPython} is ready`);
