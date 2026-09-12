/**
 * The delivery pipeline describes this repository; these are the halves a file can check.
 *
 * `Jenkinsfile` cannot run here — there is no controller, no registry, no cluster. What can be
 * checked is every claim it makes about *this tree*: that the npm scripts it invokes exist, that
 * the script it runs against the published image is the one that is actually there, and that the
 * deploy path refuses a tag where a digest belongs.
 *
 * The last one is not a style rule. A tag is a pointer: a rollback to a re-pushed tag fetches bytes
 * nobody reviewed, and the backend stamps a build revision onto every audit record that stops being
 * answerable at the same moment (Chemclaw3's `D-2026-08-01-a-tag-is-a-pointer-not-a-build`).
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const pipeline = readFileSync('Jenkinsfile', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

describe('the Jenkins pipeline', () => {
  it('invokes only npm scripts that exist', () => {
    const invoked = [...pipeline.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1] ?? '');
    expect(invoked.length).toBeGreaterThan(0);
    const missing = invoked.filter((script) => !(script in pkg.scripts));
    expect(
      missing,
      `the pipeline calls npm scripts that do not exist: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('runs the dev-auth assertion against a script that is present', () => {
    // The check runs against the *image's* bundle rather than this workspace's dist/, because the
    // image builds its own with ALLOW_DEV_AUTH defaulting to false and only one of the two ships.
    expect(pipeline).toContain('scripts/assert-no-dev-auth.mjs');
    expect(existsSync('scripts/assert-no-dev-auth.mjs')).toBe(true);
    expect(pipeline).toContain('CLIENT_DIR=.image-dist/client');
  });

  it('proves the published image serves, rather than trusting the build', () => {
    // The four probes used to be `curl`s written out in this pipeline, and a second copy of them
    // was written out in `.github/workflows/ci.yml`. They are one file now, called from both, so
    // this follows the indirection rather than re-stating it — and asserts the file it lands in
    // really does make all four, because "the pipeline calls a script" is a shape assertion until
    // somebody checks what the script asks for.
    expect(pipeline).toContain('scripts/check-serving.mjs');
    const serving = readFileSync('scripts/check-serving.mjs', 'utf8');
    for (const probe of ['/healthz', '/config.js', '/auth/callback', '/api/metrics']) {
      expect(serving, `the image is never asked for ${probe}`).toContain(`\${base}${probe}\``);
    }
  });

  it('refuses to deploy anything but the digest the registry assigned', () => {
    expect(pipeline).toContain("startsWith('sha256:')");
    expect(pipeline).toContain('@${env.IMAGE_DIGEST}');
  });

  it('defaults DRY_RUN to true, because a first run happens against a real registry', () => {
    expect(pipeline).toContain("booleanParam(name: 'DRY_RUN', defaultValue: true");
  });
});

describe('the pipeline shell', () => {
  /**
   * Resolve a Groovy GString to the text bash is actually handed: `${...}` is interpolated by
   * Jenkins before the shell sees anything, while `\${...}` and `\$(...)` reach it verbatim —
   * that escape is how a pipeline writes a shell variable inside an interpolated string, and
   * getting it backwards is the most common way one of these files breaks.
   */
  const asShellReceivesIt = (block: string): string =>
    block
      .replace(/(?<!\\)\$\{[^}]*\}/g, 'PLACEHOLDER')
      .replaceAll('\\$', '$')
      .replaceAll('\\\\', '\\');

  const blocks = [
    ...[...pipeline.matchAll(/"""([\s\S]*?)"""/g)].map((m) => asShellReceivesIt(m[1] ?? '')),
    ...[...pipeline.matchAll(/sh '''([\s\S]*?)'''/g)].map((m) => m[1] ?? ''),
  ];

  it('has blocks to check', () => {
    // Guard the guard: a regex that matched nothing would pass every assertion below.
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it.each(blocks.map((block, index) => [index, block]))('block %i parses', (_index, block) => {
    // The only thing about a pipeline nobody here can run that can actually be executed.
    const result = spawnSync('bash', ['-n'], { input: block as string, encoding: 'utf8' });
    expect(result.stderr, `shell block does not parse: ${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });
});
