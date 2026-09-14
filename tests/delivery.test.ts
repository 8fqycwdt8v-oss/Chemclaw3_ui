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
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

const pipeline = readFileSync('Jenkinsfile', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

/**
 * Resolve a Groovy GString to the text bash is actually handed.
 *
 * `${...}` is interpolated by Jenkins before the shell sees anything, while `\${...}` and `\$(...)`
 * reach it verbatim — that escape is how a pipeline writes a shell variable inside an interpolated
 * string, and getting it backwards is the most common way one of these files breaks.
 */
const asShellReceivesIt = (block: string): string =>
  block
    .replace(/(?<!\\)\$\{[^}]*\}/g, 'PLACEHOLDER')
    .replaceAll('\\$', '$')
    .replaceAll('\\\\', '\\');

/** Every shell block the pipeline runs, as bash receives it. */
const shellBlocks = [
  ...[...pipeline.matchAll(/"""([\s\S]*?)"""/g)].map((m) => asShellReceivesIt(m[1] ?? '')),
  ...[...pipeline.matchAll(/sh '''([\s\S]*?)'''/g)].map((m) => m[1] ?? ''),
];

/** The reader, as text: the two files that open a Chemclaw3 checkout. */
const contractReader = (): string =>
  ['tests/backendContract.ts', 'tests/backendContract.test.ts']
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

/**
 * Every `src/chemclaw/<dir>` the cross-repository contract reader opens in a Chemclaw3 checkout.
 *
 * Read off the reader rather than written down here, because the pipeline's sparse checkout has to
 * follow it and the failure of a transcribed list is silent in the direction that matters: a new
 * read, a path that is not fetched, and a lane that goes back to warning instead of checking.
 *
 * Two shapes, because the reader writes two: a relative path handed to `readPy`/`literal`, and an
 * explicit `join(root, 'src', 'chemclaw', …)`. Takes its sources as an argument so the derivation
 * can be driven over text written to contain each of them — the second loop's answer is a *subset*
 * of the first's today (`api`, which `readPy` already reaches), so deleting it leaves this file
 * green while removing the only thing that sees a `join()` read of a directory nothing else opens.
 */
const contractSourceDirs = (sources: string = contractReader()): string[] => {
  const dirs = new Set<string>();
  for (const match of sources.matchAll(/(?:readPy\(root, |literal\()'([a-z_]+)\//g)) {
    if (match[1]) dirs.add(match[1]);
  }
  for (const match of sources.matchAll(/'src', 'chemclaw', '([a-z_]+)'/g)) {
    if (match[1]) dirs.add(match[1]);
  }
  return [...dirs].sort();
};

/**
 * Whether the `Gate` stage runs unless somebody asks for it, read off the pipeline.
 *
 * `null` when the parameter is gone, which is a failure below rather than a quietly skipped
 * assertion — a regex that stops matching is the way a check of this shape dies.
 */
const runGateDefault = (): string | null =>
  /booleanParam\(name: 'RUN_GATE', defaultValue: (true|false)/.exec(pipeline)?.[1] ?? null;

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
    // this follows the indirection rather than re-stating it.
    //
    // A **run** line, not a mention: this pipeline's own comments name that script twice (lines 8
    // and 142), so `toContain` over the raw file was satisfied by the prose. Measured on
    // `11a2771` — deleting the real invocation left this file green, and only `gate.test.ts`
    // caught it, in a PR whose thesis is that a second edition of an assertion is the defect.
    expect(
      shellBlocks.some((block) =>
        /^\s*(?:\w+=\S+\s+)*node scripts\/check-serving\.mjs\b/m.test(block),
      ),
      'no shell block of the pipeline runs `node scripts/check-serving.mjs`',
    ).toBe(true);
    expect(existsSync('scripts/check-serving.mjs')).toBe(true);
  });

  it('refuses to deploy anything but the digest the registry assigned', () => {
    expect(pipeline).toContain("startsWith('sha256:')");
    expect(pipeline).toContain('@${env.IMAGE_DIGEST}');
  });

  it('defaults DRY_RUN to true, because a first run happens against a real registry', () => {
    expect(pipeline).toContain("booleanParam(name: 'DRY_RUN', defaultValue: true");
  });

  it('gives its gate the Chemclaw3 checkout the contract reader needs', () => {
    // `tests/backendContract.test.ts` verifies nothing without a Chemclaw3 checkout, and this is
    // the one lane that already makes one — Preflight clones that repository on every run for the
    // build library. The sparse paths are *derived* from what the reader opens rather than
    // transcribed, so a reader that grows a fourth source directory fails here instead of
    // silently reducing the gate to a warning in the lane that has the credential.
    const dirs = contractSourceDirs();
    expect(dirs.length, 'found no Chemclaw3 source the contract reader opens').toBeGreaterThan(1);

    const sparse = shellBlocks.find((block) => block.includes('git sparse-checkout set')) ?? '';
    for (const dir of dirs) {
      expect(
        sparse,
        `Preflight's sparse checkout omits src/chemclaw/${dir}, which the contract reader opens`,
      ).toContain(`src/chemclaw/${dir}`);
    }

    // And the gate stage has to say where it went, and refuse to pass when it is not there.
    expect(pipeline).toContain('CHEMCLAW3_DIR = "${env.WORKSPACE}/.jenkins-lib"');
    expect(pipeline).toContain("CHEMCLAW3_REQUIRED = '1'");
  });

  it('derives a source directory from either shape the reader opens one with', () => {
    // Driven, before this: deleting the `join(root, 'src', 'chemclaw', …)` loop is a 0/3 diff and
    // leaves this file green, which reads as "the loop is dead". It is not — it is subsumed. Each
    // loop sees a shape the other cannot, and the reader writes both, so a new read in the shape
    // only one of them sees is exactly the silent failure this derivation exists to prevent.
    expect(contractSourceDirs("readPy(root, 'kg/notes.py')")).toEqual(['kg']);
    expect(contractSourceDirs("literal('memory/tiers.py')")).toEqual(['memory']);
    expect(contractSourceDirs("join(root, 'src', 'chemclaw', 'durable', 'retention.py')")).toEqual([
      'durable',
    ]);
    // And it derives nothing from text that opens nothing, so the assertion above is about the
    // shapes rather than about the regexes matching anything they are handed.
    expect(contractSourceDirs('this text opens no file at all')).toEqual([]);
  });

  it('is described by the record with the RUN_GATE default it actually declares', () => {
    // The stage above is the only lane with a Chemclaw3 checkout, so it is the only lane where the
    // cross-repository contract check can gate — and it is behind `RUN_GATE`, which ships off. Two
    // documents described that stage as a gate for a day, which is the failure mode this whole
    // record exists to end: a control that is believed because it was written down. Rather than
    // asking each document for a phrase, both are held to the parameter's own value, so flipping
    // the default is a decision that cannot be taken in the pipeline alone.
    const declared = runGateDefault();
    expect(declared, 'the Jenkinsfile no longer declares a RUN_GATE boolean parameter').not.toBe(
      null,
    );
    const claim = `\`RUN_GATE\` defaults to \`${declared}\``;
    for (const doc of ['docs/production-readiness.md', 'ISSUES.md']) {
      expect(
        readFileSync(doc, 'utf8').includes(claim),
        `${doc} does not say ${claim}, which is what the pipeline declares — the two lanes this ` +
          'check runs in are what those documents are about, so a flipped default rewrites them',
      ).toBe(true);
    }
  });
});

describe('the pipeline shell', () => {
  const blocks = shellBlocks;

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

/**
 * What `scripts/check-serving.mjs` asserts, driven rather than read.
 *
 * "The pipeline calls a script" is a shape assertion until somebody checks what the script asks
 * for — and the check that used to stand here read the script's *text* for `${base}/healthz` and
 * three siblings, which is a weaker thing than it looks in two measured ways. `${base}/healthz`
 * occurs twice in that file: once in the wait-for-it-to-come-up loop and once in assertion §1, so
 * deleting §1 outright left this file green (`/api/metrics`, which occurs once, was caught — which
 * is what identifies the mechanism). And no text-presence test can see a *neutered* assertion:
 * turning `if (res.status === 404)` into `if (true)` keeps every string in place.
 *
 * So the script is run against a server that answers correctly, and then against four servers each
 * of which breaks exactly one of the four promises. A deleted or neutered assertion shows up as
 * the run that should have failed and did not.
 */
describe('the four promises, driven against scripts/check-serving.mjs', () => {
  /** A server answering every probe the way a healthy UI does, with one promise overridden. */
  const serveWith = async (
    broken: Record<string, { status?: number; body?: string }> = {},
  ): Promise<{ status: number | null; output: string }> => {
    const healthy: Record<string, { status: number; body: string }> = {
      '/healthz': { status: 200, body: '{"status":"ok"}' },
      '/config.js': { status: 200, body: 'window.__CHEMCLAW_CONFIG__ = {};' },
      '/auth/callback': { status: 200, body: '<!doctype html><title>ChemClaw3</title>' },
      '/api/metrics': { status: 404, body: 'not found' },
    };

    const server: Server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const answer = { ...(healthy[path] ?? { status: 404, body: 'not found' }), ...broken[path] };
      res.writeHead(answer.status ?? 200, { 'content-type': 'text/plain' });
      res.end(answer.body ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // `spawn`, deliberately not `spawnSync`: the server being probed is in *this* process, and a
      // synchronous spawn blocks the event loop that would have to answer it. That is not a style
      // preference — driven first with `spawnSync`, every probe timed out against a server that
      // was listening and could not be reached.
      return await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ['scripts/check-serving.mjs', `http://127.0.0.1:${port}`],
          {
            env: { ...process.env, READY_TIMEOUT_MS: '5000' },
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        child.on('close', (status) => resolve({ status, output }));
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('passes against a server that keeps all four', async () => {
    // Guard the guard: if this failed, every assertion below would pass for the wrong reason.
    const { status, output } = await serveWith();
    expect(status, output).toBe(0);
  });

  it.each([
    // `/healthz` answers 200 — so the readiness loop is satisfied — with a body that does not say
    // ok. This is the case the text-presence check could not see, because the string it matched
    // lives in the loop as well as in the assertion.
    ['/healthz', { '/healthz': { body: '{"status":"broken"}' } }],
    ['/config.js', { '/config.js': { body: 'window.SOMETHING_ELSE = {};' } }],
    ['SPA fallback', { '/auth/callback': { status: 404, body: 'not found' } }],
    ['the proxy whitelist', { '/api/metrics': { status: 200, body: '# HELP anything' } }],
  ])('fails when the image stops keeping %s', async (label, broken) => {
    const { status, output } = await serveWith(
      broken as Record<string, { status?: number; body?: string }>,
    );
    expect(
      status,
      `check-serving.mjs passed a server that does not keep ${label}:\n${output}`,
    ).toBe(1);
    expect(output).toContain('✗');
  });
});
