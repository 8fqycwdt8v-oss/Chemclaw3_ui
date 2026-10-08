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
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

const pipeline = readFileSync('Jenkinsfile', 'utf8');
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
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

/**
 * Every step of the GitHub workflow, as `{ name, text }`.
 *
 * A step rather than the file, because the questions below are about *one* step and the file has
 * several that answer them differently. The split is on a list item at the step indent — six
 * spaces, which is where `jobs.<id>.steps` lands in this workflow — so a `path:` inside a step
 * cannot be read as another step's, and neither can a `path:` written in a comment above one.
 */
const workflowSteps = (): { name: string; text: string }[] =>
  workflow
    .split(/\n(?= {6}- )/)
    .slice(1)
    .map((text) => ({ name: /^\s*- name:\s*(.+)/m.exec(text)?.[1]?.trim() ?? '(unnamed)', text }));

/**
 * Every shell script the workflow runs, as one string per `run:` block.
 *
 * Here so `siblingCheckouts` can apply the `git clone` pattern to the workflow as well as to the
 * Jenkinsfile. Written as a scan rather than as one regular expression because a `run:` takes two
 * shapes — the rest of its own line, or a block scalar of every following line indented past the
 * key — and a single pattern that tries to cover both is how the first version of this silently
 * matched neither.
 */
const workflowShell = (): string[] => {
  const lines = workflow.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const run = /^(\s*)(?:- )?run:[ \t]*(.*)$/.exec(line);
    if (!run) continue;
    const indent = (run[1] ?? '').length;
    const collected = [(run[2] ?? '').replace(/^[|>]-?[ \t]*/, '')];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() === '') {
        collected.push('');
        continue;
      }
      if ((/^\s*/.exec(next)?.[0] ?? '').length <= indent) break;
      collected.push(next);
      i = j;
    }
    blocks.push(collected.join('\n'));
  }
  return blocks;
};

/** The workflow's checkout steps that name a repository other than this one. */
const siblingSteps = (): { name: string; text: string }[] =>
  workflowSteps().filter(
    (step) =>
      /uses:\s*actions\/checkout@/.test(step.text) && /^\s*repository:\s*\S/m.test(step.text),
  );

/**
 * Every directory inside the workspace that one of this repository's pipelines fills with another
 * repository's source, derived from the pipelines themselves.
 *
 * **Both of them, because the class is not the workflow's.** `.github/workflows/ci.yml` checks
 * Chemclaw3 out at `.chemclaw3`; `Jenkinsfile`'s `Preflight` clones the *same repository* into
 * `.jenkins-lib`, sparsely — and its sparse set includes `src/chemclaw/api`, which is where the
 * `static/app.js` that reddened the first push-lane run lives. The second was ignored by nothing
 * at all, and was latent only because `RUN_GATE` ships `false`, which this repository treats as a
 * parameter somebody may tick rather than as a decision.
 *
 * Neither tool may write outside the workspace, so in both lanes another repository's tree lands
 * where this one's globs, `git status` and `COPY . .` reach it.
 */
const siblingCheckouts = (): { where: string; dir: string }[] => {
  const found: { where: string; dir: string }[] = [];

  for (const step of siblingSteps()) {
    const dir = /^\s*path:\s*([^\s#]+)/m.exec(step.text)?.[1];
    expect(
      dir,
      `the workflow step "${step.name}" checks another repository out to no declared path, so ` +
        'nothing below can know where its source landed',
    ).toBeTruthy();
    found.push({ where: '.github/workflows/ci.yml', dir: String(dir).replace(/^\.\//, '') });
  }

  // A `git clone` writes into its last argument. Continuations are joined first, because this
  // pipeline's clone is written across two lines and a per-line read would take the URL for the
  // target.
  //
  // **Every shell either pipeline runs, not just the Jenkinsfile's.** The first version of this
  // derivation read `actions/checkout` out of the workflow and `git clone` out of the Jenkinsfile,
  // one pattern per file — so a `run: git clone` in the workflow was invisible to both halves and
  // the whole suite stayed green with an unignored sibling tree in the workspace. That is the
  // first-match-class blind spot this function was written to close, reappearing inside the
  // closing of it: the fix is not a third pattern, it is applying both patterns to both files.
  const scripts: { where: string; text: string }[] = [
    ...shellBlocks.map((text) => ({ where: 'Jenkinsfile', text })),
    ...workflowShell().map((text) => ({ where: '.github/workflows/ci.yml', text })),
  ];
  for (const { where, text: block } of scripts) {
    for (const match of block.replace(/\\\n\s*/g, ' ').matchAll(/\bgit clone\b([^\n]*)/g)) {
      const tokens = (match[1] ?? '').trim().split(/\s+/).filter(Boolean);
      const dir = tokens.at(-1) ?? '';
      expect(
        /^[.\w][\w./-]*$/.test(dir),
        `a \`git clone\` in ${where} writes to "${dir}", which this derivation cannot read ` +
          'as a workspace directory — write the target as a plain relative path, or this check ' +
          'silently stops covering it',
      ).toBe(true);
      found.push({ where, dir: dir.replace(/^\.\//, '') });
    }
  }

  return found;
};

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

  it('gives its gate a checkout to read the pinned contract from, and refuses to warn instead', () => {
    // `npm run contract:check` compares the committed contract with core's file at the pinned
    // commit. Preflight clones Chemclaw3 for the build library on every run; the check fetches the
    // pinned commit into it. REQUIRED, because a check that degrades to a warning when the
    // checkout moves is a control this stage would claim and not have.
    expect(pipeline).toContain('CHEMCLAW3_DIR = "${env.WORKSPACE}/.jenkins-lib"');
    expect(pipeline).toContain("CHEMCLAW3_REQUIRED = '1'");
    const sparse = shellBlocks.find((block) => block.includes('git sparse-checkout set')) ?? '';
    expect(sparse, 'Preflight no longer fetches the build library').toContain('deploy/jenkins/lib');
    expect(
      sparse,
      'Preflight fetches Chemclaw3 source for a contract reader that no longer exists: the contract is read with `git show` at the pinned commit',
    ).not.toContain('src/chemclaw');
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

describe('the push lane', () => {
  it('checks core out at the commit the lock pins, and refuses to warn instead', () => {
    // The commit comes from `contracts/core.lock` through `contract-check --pinned-sha`, printed in
    // its own step before the checkout that uses it, so the sha in the log is the sha read. The
    // checkout names no branch: a moving ref would make this lane's verdict a function of core's
    // `main` and not of this repository's inputs.
    const steps = workflowSteps();
    const pinAt = steps.findIndex((s) =>
      /run:\s*node scripts\/contract-check\.mjs --pinned-sha\s*$/m.test(s.text),
    );
    const checkoutAt = steps.findIndex((s) =>
      /repository:\s*8fqycwdt8v-oss\/Chemclaw3\b/.test(s.text),
    );
    expect(
      pinAt,
      'no step reads the pinned commit out of contracts/core.lock',
    ).toBeGreaterThanOrEqual(0);
    expect(checkoutAt, 'the push lane checks out no Chemclaw3').toBeGreaterThanOrEqual(0);
    expect(pinAt, 'the pinned commit is read after the checkout that needs it').toBeLessThan(
      checkoutAt,
    );
    const id = /^\s*id:\s*(\S+)/m.exec(steps[pinAt]?.text ?? '')?.[1];
    expect(id, 'the pin step has no id, so nothing can read its output').toBeTruthy();
    expect(
      steps[checkoutAt]?.text,
      'the checkout does not read the pinned sha the previous step printed',
    ).toMatch(new RegExp(`ref:\\s*\\$\\{\\{\\s*steps\\.${id}\\.outputs\\.sha\\s*\\}\\}`));
    expect(
      /CHEMCLAW3_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.chemclaw3/.test(workflow),
      'the push lane makes a Chemclaw3 checkout and does not tell the contract check where it went',
    ).toBe(true);
    expect(
      /CHEMCLAW3_REQUIRED:\s*'1'/.test(workflow),
      'the push lane leaves the contract comparison best-effort, so it degrades to a warning',
    ).toBe(true);
  });

  it('has no way to point the contract at a moving revision', () => {
    // The pin is `contracts/core.lock`; bumping it is a commit. A dispatch input or repository
    // variable naming a ref would be a second, unreviewed way to change what the gate judges.
    expect(workflow).not.toMatch(/chemclaw3_ref|CHEMCLAW3_REF/);
  });
});

describe('the sibling checkouts this repository’s pipelines make', () => {
  /**
   * The four surfaces that decide what a directory in this workspace is, and what each one costs
   * when it does not know.
   *
   * They are separate assertions rather than one, because each failure is a different, real
   * outcome and a reader of a red build should be told which one it is.
   */
  const surfaces: { file: string; covers: (dir: string) => boolean; cost: string }[] = [
    {
      file: '.gitignore',
      covers: (dir) =>
        readFileSync('.gitignore', 'utf8')
          .split('\n')
          .some((line) => line.trim() === dir || line.trim() === `${dir}/`),
      cost:
        '`git status` offers another repository’s whole tree as untracked, and a `git add -A` ' +
        'commits it',
    },
    {
      file: '.dockerignore',
      covers: (dir) =>
        readFileSync('.dockerignore', 'utf8')
          .split('\n')
          .some((line) => line.trim() === dir || line.trim() === `${dir}/`),
      cost:
        '`Dockerfile` does `COPY . .`, so an image built after that lane has run carries another ' +
        'repository’s source and re-layers on its every commit',
    },
    {
      file: '.prettierignore',
      covers: (dir) =>
        readFileSync('.prettierignore', 'utf8')
          .split('\n')
          .some((line) => line.trim() === dir),
      cost: 'the format check reports a diff in a file nobody here can edit',
    },
    {
      file: 'eslint.config.js',
      covers: (dir) => readFileSync('eslint.config.js', 'utf8').includes(`'${dir}/**'`),
      cost:
        'lint judges another repository’s source by this repository’s rules — driven, the first ' +
        'push-lane run failed on 10 `no-undef`/`no-unused-vars` errors in ' +
        '`.chemclaw3/src/chemclaw/api/static/app.js`',
    },
  ];

  it('are derived from both pipelines rather than listed here', () => {
    // Guard the guard, and it is the assertion the check this replaces did not have. That one read
    // `/path:\s*([.\w/-]+)/` over the **whole** workflow — the first `path:` anywhere in the file,
    // not the Chemclaw3 step’s — so a comment containing `path: dist` above the step, or a
    // reordered step, made it assert about `dist`, which every one of these surfaces already
    // covers. It passed, and it checked nothing. It also read only the workflow, so it could never
    // have seen `.jenkins-lib` no matter what it matched.
    const dirs = siblingCheckouts();
    expect(
      dirs.map((d) => d.where),
      'no sibling checkout was derived from one of the two pipelines, so every assertion below ' +
        'would pass for the wrong reason',
    ).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', 'Jenkinsfile']));
    // Every derived directory is inside the workspace, which is the whole reason they need
    // covering: an absolute path or a `..` would be somebody else's problem and not this check's.
    for (const { where, dir } of dirs) {
      expect(
        dir.startsWith('/') || dir.startsWith('..'),
        `${where} clones outside the workspace`,
      ).toBe(false);
    }
  });

  it.each(surfaces)('are ignored by $file', ({ file, covers, cost }) => {
    for (const { where, dir } of siblingCheckouts()) {
      expect(
        covers(dir),
        `${file} does not cover \`${dir}\`, which ${where} fills with another repository's ` +
          `source: ${cost}`,
      ).toBe(true);
    }
  });

  it('is what `git check-ignore` actually answers, not only what the file says', () => {
    // The textual check above is what a reader can follow; this is what git does. They are both
    // here because either alone is satisfiable without the other — a line in the wrong section of
    // `.gitignore`, or a global exclude that covers it on one machine and not on the runner.
    for (const { dir } of siblingCheckouts()) {
      // A path *inside* the directory, which is what git is really asked about: these are
      // checkouts, and what `git status` offers is their files. It is also the only spelling that
      // answers the same whether or not the checkout happens to exist in this working tree — a
      // bare `.jenkins-lib` against a `.jenkins-lib/` rule answers "not ignored" when the
      // directory is absent, because git cannot know a name it cannot stat is a directory, and
      // this assertion passed and failed by whether an earlier probe had left one behind.
      const seen = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', `${dir}/probe`]);
      expect(
        seen.status,
        `git does not ignore \`${dir}/\`, whatever \`.gitignore\` appears to say about it`,
      ).toBe(0);
    }
  });
});
