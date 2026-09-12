/**
 * The gate's steps, asked of the gate.
 *
 * `scripts/ci.mjs` answers `--json` with the step list it is about to run, so a test learns what
 * the gate *is* by running it rather than by regexing `STEPS` back out of its source. Two test
 * files need that — `gate.test.ts`, which checks the pipelines against it, and
 * `supplyChain.test.ts`, which checks that the vulnerability audit is one of the steps and is
 * blocking — and a second transcription of the list would be a second thing to keep true.
 */

import { execFileSync } from 'node:child_process';

export interface GateStep {
  name: string;
  /** The npm script this step runs. */
  run: string;
  env?: Record<string, string>;
  why: string;
}

export const gateSteps = (): GateStep[] =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/ci.mjs', '--json'], { encoding: 'utf8' }),
  ) as GateStep[];
