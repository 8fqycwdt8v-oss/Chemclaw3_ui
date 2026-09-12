/**
 * Build the image and prove it serves.
 *
 *   node scripts/check-container.mjs
 *   CI_REQUIRE_CONTAINER=1 node scripts/check-container.mjs    # absent Docker is a failure
 *   SKIP_IMAGE_BUILD=1 node scripts/check-container.mjs        # assert an image built elsewhere
 *
 * The whole point of this repository is co-deployment, so a Dockerfile that no longer builds is a
 * real break even when every other check passes. Nothing else in the gate exercises the image:
 * `check:standalone` runs the bundle directly, which proves esbuild inlined `sirv` but not that
 * the multi-stage build still produces a `dist/` worth copying.
 *
 * **Absent Docker is a skip with a reason, not a silent pass.** Locally that is the common case and
 * failing there would only teach people to run the gate with this step excluded. In a pipeline it
 * is a broken agent, so `CI_REQUIRE_CONTAINER=1` turns the skip into a failure.
 *
 * **Which pipeline runs this:** the `container` job of `.github/workflows/ci.yml`, on its own
 * runner, with `CI_REQUIRE_CONTAINER=1` and `SKIP_IMAGE_BUILD=1` beside a buildx build. The Jenkins
 * pipeline does not run *this* file — it builds and publishes the image its own way and then calls
 * `scripts/check-serving.mjs` against it directly, which is the same four assertions made of the
 * artifact that actually ships. Nothing local runs it unless you ask: `npm run ci:container`, or
 * `npm run ci:all` for both halves.
 *
 * `SKIP_IMAGE_BUILD=1` is there for exactly that asymmetry: how an image is *built* legitimately
 * differs per pipeline — `.github` wants buildx with its own layer cache, Jenkins autodetects
 * buildah/podman/kaniko and may pull the result back out of a registry — while what the image must
 * then *serve* does not differ at all. The build is the knob; the assertions are not.
 */

import { spawnSync } from 'node:child_process';

const TAG = process.env.IMAGE_TAG ?? 'chemclaw3-ui:ci';
const PORT = Number(process.env.CONTAINER_PORT ?? 8080);
const NAME = process.env.CONTAINER_NAME ?? 'chemclaw3-ui-gate';
const REQUIRED = process.env.CI_REQUIRE_CONTAINER === '1';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });

/**
 * Which runtime runs the image.
 *
 * Podman first when both are present and this script does the build: it needs no daemon, and
 * neither does the check. **But under `SKIP_IMAGE_BUILD=1` the image's store was decided by
 * whoever built it, and autodetect then picks the wrong one.** `ci.yml`'s container job builds
 * with `docker/build-push-action` and `load: true`, which loads into the *Docker* daemon's store;
 * `ubuntu-latest` also ships podman, so this resolved to podman, whose store is empty, and
 * `podman run` treated the local tag as a remote reference and tried to pull it:
 *
 *     Trying to pull docker.io/library/chemclaw3-ui:ci...  requested access to the resource is denied
 *
 * So the pipeline that built the image says which runtime holds it, and autodetect remains the
 * default for the path that builds it here.
 */
const runner = (
  process.env.CONTAINER_RUNTIME ? [process.env.CONTAINER_RUNTIME] : ['podman', 'docker']
).find((candidate) => spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0);

if (!runner) {
  const why = process.env.CONTAINER_RUNTIME
    ? `CONTAINER_RUNTIME names \`${process.env.CONTAINER_RUNTIME}\`, and \`${process.env.CONTAINER_RUNTIME} version\` did not answer`
    : 'neither `podman version` nor `docker version` answered — no container runtime is available here';
  if (REQUIRED) {
    console.error(
      `\ncheck-container: ${why}, and CI_REQUIRE_CONTAINER=1 says that is a failure.\n`,
    );
    process.exit(1);
  }
  console.log(`\ncheck-container: SKIPPED — ${why}.`);
  console.log('  This step builds the image and asserts it serves. It runs in the `container` job');
  console.log(
    '  of .github/workflows/ci.yml, which sets CI_REQUIRE_CONTAINER=1 so an agent with no',
  );
  console.log('  runtime fails instead of skipping. The Jenkins pipeline makes the same four');
  console.log('  assertions of the image it publishes, by calling scripts/check-serving.mjs.\n');
  process.exit(0);
}

console.log(`\nContainer gate, using ${runner}\n`);

const cleanup = () => spawnSync(runner, ['rm', '-f', NAME], { stdio: 'ignore' });
cleanup();

if (process.env.SKIP_IMAGE_BUILD === '1') {
  console.log(
    `  · not building — SKIP_IMAGE_BUILD=1 says ${TAG} was built by this pipeline already`,
  );
} else if (run(runner, ['build', '-t', TAG, '.']).status !== 0) {
  console.error('\ncheck-container: the image did not build.\n');
  process.exit(1);
}

// ALLOW_INSECURE_AUTH because the container binds 0.0.0.0 in dev auth mode, which the BFF refuses
// to serve unless the exposure is declared. The image itself is built with the default
// ALLOW_DEV_AUTH=false, so its bundle carries no dev provider and the SPA would refuse to start a
// session. That is fine and deliberate here: every assertion is about the server, and the one
// about the SPA is that the fallback serves its HTML.
const started = run(runner, [
  'run',
  '-d',
  '--name',
  NAME,
  '-p',
  `127.0.0.1:${PORT}:8080`,
  '-e',
  'AUTH_MODE=dev',
  '-e',
  'ALLOW_INSECURE_AUTH=true',
  '-e',
  'CHEMCLAW_API_URL=http://127.0.0.1:9',
  TAG,
]);
if (started.status !== 0) {
  console.error(
    '\ncheck-container: the image is not in this runtime store, or would not start. When SKIP_IMAGE_BUILD is set the build happened elsewhere, so check that CONTAINER_RUNTIME names the runtime holding it.\n',
  );
  cleanup();
  process.exit(1);
}

const served = run(process.execPath, ['scripts/check-serving.mjs', `http://127.0.0.1:${PORT}`]);
if (served.status !== 0) {
  console.error(
    '\ncheck-container: the container is up but does not serve what it must. Its log:\n',
  );
  run(runner, ['logs', NAME]);
  cleanup();
  process.exit(1);
}

cleanup();
console.log(
  `ok: ${TAG} serves the app, its config, the SPA fallback, and blocks un-whitelisted routes\n`,
);
