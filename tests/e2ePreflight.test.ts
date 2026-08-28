// @vitest-environment node

/**
 * The fixture tier refuses to start against a client it cannot sign into.
 *
 * `npm run test:e2e` serves `dist/client` through the real BFF with `AUTH_MODE=dev`. A bare
 * `npm run build` sets `ALLOW_DEV_AUTH=false`, which makes `createAuthProvider` throw
 * "AUTH_MODE=dev is not permitted in this production build" — and every test needing an
 * authenticated view then died on a 30s `locator.click` timeout. Measured on the 2026-08-28
 * campaign: **40 timeouts**, ~20 minutes, with the actual cause reaching the log only as a
 * browser-side `unhandled.rejection` nobody reads until the third hypothesis. `start.sh` passes
 * the flag; the Playwright config did not check for it.
 *
 * So the check is a `globalSetup`, which runs before the web server and whose failure IS the whole
 * output. This proves the predicate rather than the wiring: given a directory, does it name the
 * right thing to do?
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflightProblems } from '../e2e/preflight.ts';
import { createDevAuth } from '../src/auth/devAuth.ts';

/** A throwaway `dist/` whose client chunk carries whatever `chunk` says. */
function fakeDist(chunk: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'chemclaw-preflight-'));
  writeFileSync(join(root, 'server.js'), '// the bundled BFF');
  if (chunk !== null) {
    mkdirSync(join(root, 'client', 'assets'), { recursive: true });
    writeFileSync(join(root, 'client', 'assets', 'index-abc.js'), chunk);
  }
  return root;
}

const DEV_BUNDLE = `console.log(${JSON.stringify(createDevAuth().account?.username)});`;

describe('the fixture tier’s preflight', () => {
  it('passes a client built with ALLOW_DEV_AUTH=true', () => {
    const root = fakeDist(DEV_BUNDLE);
    expect(preflightProblems(join(root, 'client'), join(root, 'server.js'))).toEqual([]);
  });

  it('names the rebuild when the client has no dev auth provider in it', () => {
    // The exact 40-timeout case: a real, complete, correct production bundle — that this tier
    // cannot sign into.
    const root = fakeDist('console.log("a perfectly good production bundle");');
    const problems = preflightProblems(join(root, 'client'), join(root, 'server.js'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ALLOW_DEV_AUTH=true');
    // And it must say what the symptom looks like, because that is the string somebody greps for
    // when they meet it before they meet this check.
    expect(problems[0]).toContain('AUTH_MODE=dev is not permitted in this production build');
  });

  it('names the build when there is no client at all', () => {
    const root = fakeDist(null);
    const problems = preflightProblems(join(root, 'client'), join(root, 'server.js'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('npm run build');
  });

  it('names the server bundle when only that is missing', () => {
    const root = fakeDist(DEV_BUNDLE);
    const problems = preflightProblems(join(root, 'client'), join(root, 'nope.js'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('build:server');
  });
});
