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
    for (const probe of ['/healthz', '/config.js', '/auth/callback', '/api/metrics']) {
      expect(pipeline, `the image is never asked for ${probe}`).toContain(probe);
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
