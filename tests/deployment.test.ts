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

    it(`does not bake the dev auth provider into every image in ${file}`, () => {
      // `ALLOW_DEV_AUTH` is a build arg, not a runtime env, so a `${ALLOW_DEV_AUTH:-true}` default
      // in compose compiles the no-token provider into an image built with AUTH_MODE=msal too —
      // the vulnerability was exactly that. The launcher may still turn it on *conditionally*
      // (start.sh does, but only inside `if AUTH_MODE = dev`), so the thing forbidden is the
      // unconditional shell default-substitution to true, not the token `true` itself.
      const lines = read(file)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));

      for (const line of lines) {
        if (!line.includes('ALLOW_DEV_AUTH')) continue;
        // `${ALLOW_DEV_AUTH:-true}` / `${ALLOW_DEV_AUTH:=true}` — the repository deciding it on.
        expect(line).not.toMatch(/ALLOW_DEV_AUTH:[-=]\s*true/);
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

describe('the production server build', () => {
  it('does not emit a source map into the image', () => {
    // `dist/server.js.map` carries the whole BFF source — the route whitelist, the header logic —
    // and the Dockerfile copies `dist/` whole, so any image-puller would get it. The build script
    // is read as text (running esbuild in a unit test would be a real filesystem write), and the
    // property is that `sourcemap` is off.
    const script = read('scripts/build-server.mjs')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    expect(script).toMatch(/sourcemap:\s*false/);
    expect(script).not.toMatch(/sourcemap:\s*(true|'.*'|".*")/);
  });
});
