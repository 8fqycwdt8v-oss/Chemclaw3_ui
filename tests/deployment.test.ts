// @vitest-environment node

/**
 * Two things this repository ships that decide the posture of a deployment nobody configured.
 *
 * `validateConfig` refuses to serve `AUTH_MODE=dev` on a non-loopback bind unless somebody writes
 * the exposure down — a genuinely good control, and both shipped ways of starting the app wrote it
 * down *for* the operator, as a default. `ALLOW_INSECURE_AUTH=true` in `start.sh` and in
 * `docker-compose.yml` turned a deliberate refusal into a default-on opt-out, which is the whole
 * argument the comment beside `allowInsecureAuth` makes against itself.
 *
 * And `sourcemap: 'hidden'` suppresses the `//# sourceMappingURL=` comment; it does not stop the
 * `.map` files being written into `dist/client`, which the Dockerfile copies whole and `sirv`
 * serves. `GET /assets/index-<hash>.js.map` returned the TypeScript of the whole SPA with
 * `sourcesContent` inlined — including, per `scripts/assert-no-dev-auth.mjs`, modules the build
 * deliberately dropped.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the launchers this repository ships', () => {
  for (const file of ['start.sh', 'docker-compose.yml']) {
    it(`does not decide ALLOW_INSECURE_AUTH for the operator in ${file}`, () => {
      // Comments stripped: both files now *document* `ALLOW_INSECURE_AUTH=true` as the thing an
      // operator types, which is the opposite of the defect and must not read as one.
      const lines = read(file)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));

      // Any shape of "default it to true": `${ALLOW_INSECURE_AUTH:-true}` or a bare assignment.
      for (const line of lines) {
        if (!line.includes('ALLOW_INSECURE_AUTH')) continue;
        expect(line).not.toMatch(/true/);
      }
    });
  }
});

describe('the production client build', () => {
  it('does not emit source maps into the directory the BFF serves', async () => {
    const config = (await import('../vite.config.ts')).default as {
      build?: { sourcemap?: boolean | string };
    };

    expect(config.build?.sourcemap ?? false).toBe(false);
  });
});
