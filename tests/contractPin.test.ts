// @vitest-environment node

/**
 * `npm run contract:check`, driven as CI runs it, against a throwaway "core" repository.
 *
 * The check exists to fail: a copy edited by hand, a lock bumped without it, a pin core no longer
 * has. Each is built here and must be refused; the two that are not failures (a developer with no
 * core beside them, a core whose `main` has moved on past the pin) must not be. The script is
 * copied into a scratch tree because it locates the lock relative to itself.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sha256 = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const DOCUMENT = JSON.stringify(
  { openapi: '3.1.0', info: { title: 't', version: '1.2.3' } },
  null,
  2,
);

let scratch: string;
let core: string;
let pinned: string;

/** A tree with the scripts, a copy of `document` and a lock for `commit`; returns its root. */
async function tree(options: {
  document?: string;
  lockHashOf?: string;
  commit?: string;
  version?: string;
}): Promise<string> {
  const root = mkdtempSync(join(scratch, 'ui-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'contracts'));
  copyFileSync('scripts/contract-check.mjs', join(root, 'scripts', 'contract-check.mjs'));
  copyFileSync('scripts/lib/contractLock.mjs', join(root, 'scripts', 'lib', 'contractLock.mjs'));
  const document = options.document ?? DOCUMENT;
  writeFileSync(join(root, 'contracts', 'core-openapi.json'), document);
  writeFileSync(
    join(root, 'contracts', 'core.lock'),
    JSON.stringify({
      repository: 'example/core',
      path: 'schema/api/openapi.json',
      commit: options.commit ?? pinned,
      contract_version: options.version ?? '1.2.3',
      sha256: await sha256(options.lockHashOf ?? document),
    }),
  );
  return root;
}

const run = (
  root: string,
  env: Record<string, string> = {},
  ...args: string[]
): { status: number | null; out: string } => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'contract-check.mjs'), ...args],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'contract-pin-'));
  core = join(scratch, 'core');
  mkdirSync(join(core, 'schema', 'api'), { recursive: true });
  git(core, 'init', '-q');
  writeFileSync(join(core, 'schema', 'api', 'openapi.json'), DOCUMENT);
  git(core, 'add', '.');
  git(core, 'commit', '-q', '-m', 'the pinned contract');
  pinned = git(core, 'rev-parse', 'HEAD');
  // Core moves on: its working tree and HEAD no longer hold the pinned file.
  writeFileSync(join(core, 'schema', 'api', 'openapi.json'), DOCUMENT.replace('1.2.3', '2.0.0'));
  git(core, 'commit', '-q', '-am', 'a later contract');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('contract:check', { timeout: 30_000 }, () => {
  it('passes, and says it compared, when the copy is core’s file at the pinned commit', async () => {
    const result = run(await tree({}), { CHEMCLAW3_DIR: core, CHEMCLAW3_REQUIRED: '1' });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('core at the pinned commit');
  });

  it('reads the pinned commit, not core’s HEAD', async () => {
    // Core’s HEAD holds version 2.0.0 by now; the pin still reads 1.2.3.
    expect(readFileSync(join(core, 'schema', 'api', 'openapi.json'), 'utf8')).toContain('2.0.0');
    const result = run(await tree({}), { CHEMCLAW3_DIR: core, CHEMCLAW3_REQUIRED: '1' });
    expect(result.status, result.out).toBe(0);
  });

  it('refuses a copy that is not what core had at the pinned commit, even with a matching lock', async () => {
    const edited = DOCUMENT.replace('"t"', '"edited"');
    const result = run(await tree({ document: edited }), {
      CHEMCLAW3_DIR: core,
      CHEMCLAW3_REQUIRED: '1',
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("is not core's schema/api/openapi.json");
  });

  it('refuses a copy edited after the lock was written', async () => {
    const result = run(await tree({ document: DOCUMENT + '\n', lockHashOf: DOCUMENT }), {
      CHEMCLAW3_DIR: core,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain('hashes to');
  });

  it('refuses a lock whose version is not the one the copy declares', async () => {
    const result = run(await tree({ version: '1.2.4' }), { CHEMCLAW3_DIR: core });
    expect(result.status).toBe(1);
    expect(result.out).toContain('info.version');
  });

  it('fails, never passes silently, when the pinned commit is unreachable and a check is required', async () => {
    const result = run(await tree({ commit: 'f'.repeat(40) }), {
      CHEMCLAW3_DIR: core,
      CHEMCLAW3_REQUIRED: '1',
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain('not reachable');
  });

  it('fails when a check is required and there is no checkout at all', async () => {
    const result = run(await tree({}), {
      CHEMCLAW3_DIR: join(scratch, 'nowhere'),
      CHEMCLAW3_REQUIRED: '1',
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain('cannot compare the copy with core');
  });

  it('skips out loud, and still checks the lock, when nothing is required', async () => {
    const result = run(await tree({}), { CHEMCLAW3_DIR: join(scratch, 'nowhere') });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('SKIPPED');
    expect(result.out).toContain('core NOT compared');

    const tampered = run(await tree({ document: DOCUMENT + '\n', lockHashOf: DOCUMENT }), {
      CHEMCLAW3_DIR: join(scratch, 'nowhere'),
    });
    expect(tampered.status, 'a skipped comparison must not skip the lock').toBe(1);
  });

  it('prints the pinned commit for the workflow’s checkout, and writes it as an output', async () => {
    const output = join(scratch, 'github-output');
    writeFileSync(output, '');
    const result = run(await tree({}), { GITHUB_OUTPUT: output }, '--pinned-sha');
    expect(result.status).toBe(0);
    expect(result.out.trim()).toBe(pinned);
    expect(readFileSync(output, 'utf8')).toBe(`sha=${pinned}\n`);
  });
});

describe('the committed pin', () => {
  it('is a full commit sha and a hash of the file next to it', () => {
    const lock = JSON.parse(readFileSync('contracts/core.lock', 'utf8')) as Record<string, string>;
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.contract_version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('generate:check', { timeout: 60_000 }, () => {
  /** The generator, the pin and the generated files, in a scratch tree that can be damaged. */
  const copy = (): string => {
    const root = mkdtempSync(join(scratch, 'gen-'));
    mkdirSync(join(root, 'scripts'));
    cpSync('scripts/lib', join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync('scripts/generate-api.mjs', join(root, 'scripts', 'generate-api.mjs'));
    cpSync('contracts', join(root, 'contracts'), { recursive: true });
    cpSync('shared/generated', join(root, 'shared', 'generated'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    return root;
  };
  const check = (root: string): { status: number | null; out: string } => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'generate-api.mjs'), '--check'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  it('passes on the committed files', () => {
    const result = check(copy());
    expect(result.status, result.out).toBe(0);
  });

  it('fails, naming the file, when a generated file is stale', () => {
    const root = copy();
    const events = join(root, 'shared', 'generated', 'events.ts');
    writeFileSync(events, readFileSync(events, 'utf8').replace("'tool_call'", "'tool_called'"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.out).toContain('shared/generated/events.ts');
  });

  it('fails when the document moved and the files did not', () => {
    const root = copy();
    const documentPath = join(root, 'contracts', 'core-openapi.json');
    const document = JSON.parse(readFileSync(documentPath, 'utf8')) as {
      info: { version: string };
    };
    document.info.version = '1.0.1';
    writeFileSync(documentPath, JSON.stringify(document, null, 2));
    const result = check(root);
    // Refused outright: the copy no longer matches its lock, so nothing is generated from it.
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('core.lock');
  });
});
