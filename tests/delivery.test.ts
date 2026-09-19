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
import { readFileSync, readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { CHECKOUT_VARS, DEFAULT_CHECKOUT, checkoutRoots } from './backendContract.ts';

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
 * This file, which is the one source in the suite the derivations below must not read.
 *
 * Not tidiness and not a hole: the probes further down hand those derivations text built to
 * contain every shape they claim to see (`readPy(root, 'kg/…')`, a `join(root, 'src', 'chemclaw',
 * 'durable', …)`, a `/src/chemclaw/publish/` URL), and a scan that read its own fixtures would
 * demand the pipeline fetch four directories nothing opens. What stops a real read hiding behind
 * the exclusion is the last assertion in this describe, which holds *every* file in the suite —
 * this one included — to resolving a checkout through one function rather than an environment
 * variable of its own.
 */
const DERIVATION_OWNER = 'tests/delivery.test.ts';

/** Every TypeScript source in this suite, as `{ path, text }`. */
const suiteSources = (): { path: string; text: string }[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  return [...walk('tests'), ...walk('e2e')]
    .filter((path) => path !== DERIVATION_OWNER)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
};

/**
 * The cross-repository readers, derived rather than named: a file this suite holds that opens
 * something out of a Chemclaw3 checkout.
 *
 * The list used to be three filenames written here, under a docstring saying the *directories*
 * were derived rather than transcribed — true of the directories and false of the readers, which
 * is the same sentence being right about somebody else. Driven on `0fca446`: a fourth reader
 * opening `src/chemclaw/memory/tiers.py` left this file green at 20 passed while the Gate stage's
 * sparse checkout fetched no `memory/`, which is the silent demotion to a warning that the
 * derivation exists to prevent, arriving by the one route it could not see.
 */
const contractReaders = (
  files: { path: string; text: string }[] = suiteSources(),
): { path: string; text: string }[] =>
  files.filter((file) => contractSourceDirs(file.text).length > 0);

/** The one file allowed to answer "where is the Chemclaw3 checkout". */
const RESOLVER = 'tests/backendContract.ts';

/**
 * The file the three documents' sentences about the checkout resolution are *about*.
 *
 * Transcribed rather than derived, because no derivation in this file produces it — and asserted
 * to exist where it is used, so a rename cannot leave it naming nothing while the region check it
 * anchors quietly matches no block at all. That is the whole cost of binding a phrase to a region
 * rather than to a file, and it is one path rather than three sentences.
 */
const CONTRACT_READER = 'tests/backendContract.test.ts';

/**
 * The files that ask `tests/backendContract.ts` where the checkout is.
 *
 * The second derivation of the same population, and it has to be a different question from the
 * first or the agreement below would be an identity. This one reads the *import*; the other reads
 * the *path*. A file in one and not the other is a defect in whichever direction it is missing
 * from, and both directions have happened in this repository.
 *
 * The named functions rather than the module: `tests/eventContract.test.ts` imports
 * `clientEventTypes` from it and opens no checkout at all, so a predicate about the *module* put
 * it in this set and failed it for a read it does not make — driven, before this. And the *import
 * clause* rather than a window of characters before the `from`: the first edition allowed 200 of
 * them, and adding three parser names to `tests/backendContract.test.ts`'s import list pushed
 * `backendCheckout` out of the window, failing the file that owns this axis for having grown.
 *
 * And the whole specifier rather than `[./]*backendContract.ts`: `suiteSources()` walks `e2e/` as
 * well as `tests/`, and a file there must write `'../tests/backendContract.ts'`, which that form
 * never matches. Both halves of that were wrong and the second is the one that matters — an `e2e/`
 * reader that asks and then opens opaquely fell into *neither* population, so nothing fired and
 * the sparse checkout did not fetch what it read, which is precisely the silent demotion this pair
 * of derivations exists to prevent, one directory over. The other half failed a file that does ask
 * with a message telling it to ask, which is a red with no edit that clears it. The probe below
 * drives both shapes from `e2e/`.
 */
const RESOLVER_FUNCTIONS = ['backendCheckout', 'backendSearchPath', 'checkoutRoots'];

const resolverUsers = (
  files: { path: string; text: string }[] = suiteSources(),
): { path: string; text: string }[] =>
  files.filter(
    (file) =>
      file.path === RESOLVER ||
      [...file.text.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'[^']*backendContract\.ts'/g)].some(
        (match) =>
          RESOLVER_FUNCTIONS.some((name) => new RegExp(`\\b${name}\\b`).test(match[1] ?? '')),
      ),
  );

/** The readers, as one text, for the directory derivation the sparse checkout follows. */
const contractReader = (): string =>
  contractReaders()
    .map((file) => file.text)
    .join('\n');

/**
 * Every `src/chemclaw/<dir>` a cross-repository reader in this suite opens in a Chemclaw3 checkout.
 *
 * Read off the readers rather than written down here, because the pipeline's sparse checkout has to
 * follow it and the failure of a transcribed list is silent in the direction that matters: a new
 * read, a path that is not fetched, and a lane that goes back to warning instead of checking.
 *
 * Three shapes, because the readers write three: a relative path handed to `readPy`/`literal`, an
 * explicit `join(root, 'src', 'chemclaw', …)`, and a `…/src/chemclaw/<dir>/…` path built into a
 * URL. Takes its sources as an argument so the derivation can be driven over text written to
 * contain each of them — the second loop's answer is a *subset* of the first's today (`api`, which
 * `readPy` already reaches), so deleting it leaves this file green while removing the only thing
 * that sees a `join()` read of a directory nothing else opens.
 *
 * The boundary, stated because a derivation that looks exhaustive is read as one: all three shapes
 * match a *literal* first path segment. A reader that builds the directory name — holding it in a
 * constant, or joining a variable — is invisible here exactly as it is to the path-encoding rule,
 * and the remedy is the same one: write the read in a shape this can see.
 */
const contractSourceDirs = (sources: string = contractReader()): string[] => {
  const dirs = new Set<string>();
  for (const match of sources.matchAll(/(?:readPy\(root, |literal\()'([a-z_]+)\//g)) {
    if (match[1]) dirs.add(match[1]);
  }
  for (const match of sources.matchAll(/'src', 'chemclaw', '([a-z_]+)'/g)) {
    if (match[1]) dirs.add(match[1]);
  }
  for (const match of sources.matchAll(/\/src\/chemclaw\/([a-z_]+)\//g)) {
    if (match[1]) dirs.add(match[1]);
  }
  return [...dirs].sort();
};

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

  it('derives the readers themselves, rather than being handed a list of them', () => {
    // Two derivations of one population, over inputs built to disagree with each other. The set is
    // normally three files that already agree, so a filter over it answers the same thing whatever
    // its predicate does — this is what makes the assertion below about the predicates.
    const probe = [
      // Opens a checkout path and never asks where the checkout is: the shape that grew a fourth
      // reader outside the sparse list.
      { path: 'tests/rogue.test.ts', text: "readPy(root, 'memory/tiers.py')" },
      // Asks where the checkout is and opens it in a shape no derivation can follow: the boundary
      // the directory derivation's own docstring states and nothing used to enforce.
      {
        path: 'tests/opaque.test.ts',
        text: "import { backendCheckout } from './backendContract.ts';\nreadFileSync(join(root, DIR))",
      },
      // Names a path in prose and opens nothing. In neither set, and that is the point: a mention
      // is not a read, and a derivation that counted one would make the pipeline fetch prose.
      { path: 'tests/prose.test.ts', text: 'transcribed from src/chemclaw/api/events.py' },
      // Both, which is what every real reader is.
      {
        path: 'tests/honest.test.ts',
        text: "import { backendCheckout } from './backendContract.ts';\nreadPy(root, 'api/events.py')",
      },
      // The same two shapes from `e2e/`, which `suiteSources()` walks and which has to reach the
      // resolver as `'../tests/backendContract.ts'`. Driven: the import derivation used to require
      // the specifier be dots and slashes only, so neither of these was a resolver user — the
      // opaque one was in no set at all and fired nothing, and the honest one was reported as
      // opening a checkout "without asking" while its first line asks.
      {
        path: 'e2e/opaque.spec.ts',
        text: "import { backendCheckout } from '../tests/backendContract.ts';\nreadFileSync(join(root, DIR))",
      },
      {
        path: 'e2e/honest.spec.ts',
        text: "import { backendCheckout } from '../tests/backendContract.ts';\nreadPy(root, 'api/events.py')",
      },
    ];
    expect(contractReaders(probe).map((file) => file.path)).toEqual([
      'tests/rogue.test.ts',
      'tests/honest.test.ts',
      'e2e/honest.spec.ts',
    ]);
    expect(resolverUsers(probe).map((file) => file.path)).toEqual([
      'tests/opaque.test.ts',
      'tests/honest.test.ts',
      'e2e/opaque.spec.ts',
      'e2e/honest.spec.ts',
    ]);
  });

  it('holds every cross-repository reader to the one resolution of where the checkout is', () => {
    const opens = contractReaders().map((file) => file.path);
    const asks = resolverUsers().map((file) => file.path);
    // A floor, because both derivations answer `[]` for a regex that has stopped matching, and
    // that is how a check of this shape dies. Two is the smallest population that can disagree.
    expect(opens.length, 'no file in this suite opens a Chemclaw3 checkout').toBeGreaterThan(1);

    expect(
      opens.filter((path) => !asks.includes(path)),
      'these open a Chemclaw3 checkout without asking `tests/backendContract.ts` where it is — ' +
        'a second resolution is how one reader ends up checking and another silently warning in ' +
        'the same run',
    ).toEqual([]);
    expect(
      asks.filter((path) => !opens.includes(path)),
      'these resolve a checkout and then open it in a shape the directory derivation cannot ' +
        'follow, so the pipeline will not fetch what they read — write the read as a literal ' +
        'first path segment',
    ).toEqual([]);
  });

  it('leaves the checkout variables to that one file, everywhere in the suite', () => {
    // The invariant behind the two above: `tests/protocolStatusTransitions.test.ts` read
    // `CHEMCLAW_REPO`, which the contract reader did not, so a developer following `README.md`'s
    // documented override ran the drift check and not the contract check. Driven on `0fca446`:
    // `CHEMCLAW_REPO=…` with no sibling at the default path gave 8 tests against the service in
    // the same run that printed "backend contract NOT CHECKED".
    //
    // This one reads the whole suite including the file it is written in, which is why the
    // exclusion above is not a hole: a read hidden from the derivations still cannot say where to
    // read from.
    const names = [...CHECKOUT_VARS, 'CHEMCLAW3_REQUIRED'];
    // Two shapes, because there are two ways to read one of these and the scan held only one: a
    // *destructuring binding* passed at 24 passed, where the same name read off `process.env` as a
    // property already reds. Driven at `b35964f`, planting one probe file per shape: the property
    // read gave `1 failed | 23 passed` naming that file, the destructured one gave `24 passed`.
    // Which way round that went is worth stating carefully, because this comment had it backwards
    // for a day — `process.env.<name>` *is* the property read, so "a member read passed where the
    // same variable read off `process.env` by property reds" names one form and hands it both
    // outcomes. The docstring above claims the absolute rule, so it is the scan that was narrow
    // rather than the rule. Both shapes are probed below, and neither the probes nor this comment
    // may spell a name beside the access — assembled from the constant, or this file matches
    // itself, which it did, twice, once for each arm, and once more while correcting this
    // paragraph.
    //
    // What is still outside it, said rather than implied: this scan can only see a name written
    // down, so a variable read through one held in a constant is invisible here exactly as a built
    // directory name is to the source-directory derivation. The remedy is the same one.
    const pattern = new RegExp(
      `process\\.env[^\\n]{0,4}(${names.join('|')})` +
        `|\\{[^}]*\\b(${names.join('|')})\\b[^}]*\\}\\s*=\\s*process\\.env`,
    );
    const rogue = [
      ...suiteSources(),
      { path: DERIVATION_OWNER, text: readFileSync(DERIVATION_OWNER, 'utf8') },
    ]
      .filter((file) => file.path !== RESOLVER && pattern.test(file.text))
      .map((file) => file.path);
    expect(
      rogue,
      `only ${RESOLVER} may read ${names.join('/')} — every other file asks it, so there is one ` +
        'answer to where the checkout is and one answer to whether a skip is allowed',
    ).toEqual([]);

    // Guard the guard: the pattern is built from an imported constant, so a rename upstream that
    // stopped it matching would empty the filter above in silence. Both probes are assembled from
    // that constant rather than written out, or this file would match itself — driven, it did.
    for (const name of names) {
      expect(pattern.test(`const x = process.env.${name} ?? 'fallback';`)).toBe(true);
      expect(pattern.test(`const x = process.env['${name}'];`)).toBe(true);
      expect(pattern.test(`const { ${name} } = process.env;`)).toBe(true);
      expect(pattern.test(`const {\n  ${name}: where,\n} = process.env;`)).toBe(true);
      // Naming one is not reading one: this file asserts the Jenkinsfile *declares* them.
      expect(pattern.test(`expect(pipeline).toContain("${name} = '1'");`)).toBe(false);
    }
  });

  it('is described by the record with the resolution the resolver actually performs', () => {
    // Same rule as the RUN_GATE clause below and for the same reason: three documents tell a
    // reader where to put the checkout, and one of them told them to use a variable the contract
    // reader did not read.
    //
    // A *phrase*, not a mention of each name. This check was `text.includes(name)` anywhere in the
    // file, which is satisfied by any occurrence — driven: rewriting the sentence in `README.md`
    // that actually describes the resolution left the suite green, because `CHEMCLAW_REPO` is
    // named elsewhere in that file for an unrelated reason, and only deleting *every* mention
    // reds. Order was held by nothing at all, and order is the half a reader acts on: which of two
    // exported variables wins decides which checkout the suite reads.
    //
    // Assembled from `CHECKOUT_VARS` and `DEFAULT_CHECKOUT` rather than written out, so adding a
    // variable, reordering two, or moving the fallback path reds here until the record says so.
    // Whitespace-normalised because a Markdown paragraph wraps, and all three wrap this sentence
    // in different places.
    //
    // The *fallback* is not a third candidate, and this check used to pin three documents to
    // saying it was: `` `CHEMCLAW3_DIR`, then `CHEMCLAW_REPO`, then `../Chemclaw3` `` reads as a
    // fall-through, and `checkoutRoots` takes the default *instead of* the configured roots.
    // Driven at the commit that pinned it: `checkoutRoots({ CHEMCLAW3_DIR: '/nonexistent-xyz' })`
    // is `['/nonexistent-xyz']` and `backendCheckout` is `null` — a stale export switches the
    // check off rather than quietly reading the sibling, which is the opposite of what a reader
    // who acted on that sentence would expect. So the two halves join differently.
    const claim =
      CHECKOUT_VARS.map((name) => `\`${name}\``).join(', then ') +
      `, and only where none of those is set, \`${DEFAULT_CHECKOUT}\``;

    // And the sentence's second half is a claim about the resolver rather than about this string,
    // so it is driven here, in the `it` that enforces the sentence: making `DEFAULT_CHECKOUT` a
    // third candidate reds beside the prose it falsifies, and the two cannot drift because both
    // read the one constant.
    //
    // Not redundant with `tests/backendContract.test.ts`, which is the reading that would delete
    // it. Its `falls back to the sibling path, and only when nothing names one` drives only the
    // nothing-set arm, so it is **green** under exactly that mutation — measured:
    // `[...configured.map(absolute), resolve(base, DEFAULT_CHECKOUT)]` leaves that `it` passing
    // and reds three of its neighbours plus this one. The title says "only when nothing names
    // one"; the assertions underneath do not check the other half.
    const sibling = resolve(process.cwd(), DEFAULT_CHECKOUT);
    expect(checkoutRoots({})).toContain(sibling);
    for (const name of CHECKOUT_VARS) {
      expect(
        checkoutRoots({ [name]: '/nonexistent-xyz' }),
        `${name} naming a directory that does not exist must not fall through to ` +
          `${DEFAULT_CHECKOUT} — the record above says it does not`,
      ).not.toContain(sibling);
    }
    // ## The phrase is bound to a block, not to a file, and that was a decision
    //
    // A whole-file `includes` is satisfied by *any* occurrence, which is the same axis this check
    // already narrowed once (from "each name anywhere" to "the phrase anywhere") and did not
    // finish. Driven: destroy the live sentence in `README.md` — the two variables replaced by
    // "some directory nobody documents" — and append a superseded historical note carrying the
    // phrase verbatim, `git diff --numstat` `4 3 README.md`, and the suite is **24 passed**. The
    // document now describes the resolution nowhere and the check cannot tell.
    //
    // Taken deliberately, because the cheap answers do not close it and the expensive one is not
    // as expensive as it looks. A per-document occurrence *count* fails: that mutation leaves
    // exactly one occurrence. Binding the phrase to a region is what closes it, and the cost is an
    // anchor — so the anchor is `CONTRACT_READER`, the filename of the reader the sentence is
    // about, which is one path, asserted to exist here, and already named in the describing block
    // of all three documents (`ISSUES.md` said "It resolves", six lines from its antecedent, and
    // now names the file). A prose anchor would be the stale thing; a path that must resolve on
    // disk cannot be, and a document that stops naming the reader reds with that as its message
    // rather than emptying the check in silence.
    //
    // Blocks split on a blank line *and* on a top-level list item, because two of the three
    // documents describe the resolution inside a bullet and the bullets in them are not
    // blank-line separated — splitting on blank lines alone makes one block of a whole section,
    // which is a region check in name only.
    //
    // **What is left, said rather than implied.** A document may name the reader in more than one
    // block (`docs/production-readiness.md` does, four times), so a superseded note placed inside
    // one of *those* blocks still passes. That is a narrower hole than the file, not no hole. And
    // the `RUN_GATE` clause below is still a whole-file `includes` on the same axis; it is not
    // covered by any of this.
    expect(
      existsSync(CONTRACT_READER),
      `${CONTRACT_READER} is what the documents' sentences are about and what this check looks ` +
        'for a block by — it has been renamed, so the anchor names nothing',
    ).toBe(true);
    // Collected and asserted as a list, which is this file's own idiom (`expect(missing).toEqual([])`)
    // and not only tidiness: a `for` loop of bare `expect`s aborts on the first failure, and the
    // edit that falsifies *all three* documents at once is the one most likely to happen — moving
    // `DEFAULT_CHECKOUT`. Driven under the loop, with `DEFAULT_CHECKOUT = '../Chemclaw3-elsewhere'`:
    // one failure, naming `README.md`, and three round trips to find out the other two were wrong
    // too. The commit that added this check said "reds all three documents", which was true of its
    // effect and not of what a reader is shown.
    const described = ['README.md', 'docs/production-readiness.md', 'ISSUES.md'].map((doc) => ({
      doc,
      blocks: readFileSync(doc, 'utf8')
        .split(/\n\s*\n|\n(?=[-*] )/)
        .map((block) => block.replace(/\s+/g, ' '))
        .filter((block) => block.includes(CONTRACT_READER)),
    }));
    expect(
      described.filter((entry) => entry.blocks.length === 0).map((entry) => entry.doc),
      `these no longer name ${CONTRACT_READER}, so there is no block for this check to read the ` +
        'resolution out of',
    ).toEqual([]);
    expect(
      described
        .filter((entry) => !entry.blocks.some((block) => block.includes(claim)))
        .map((entry) => entry.doc),
      `these do not say ${claim} in a block that names ${CONTRACT_READER}, which is the ` +
        'resolution that reader performs',
    ).toEqual([]);
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
    expect(
      contractSourceDirs('new URL(`${checkout}/src/chemclaw/publish/sinks.py`, ROOT)'),
    ).toEqual(['publish']);
    // And it derives nothing from text that opens nothing, so the assertion above is about the
    // shapes rather than about the regexes matching anything they are handed.
    expect(contractSourceDirs('this text opens no file at all')).toEqual([]);
  });

  it('is described by the record with the RUN_GATE default it actually declares', () => {
    // **This comment used to say the stage above is the only lane with a Chemclaw3 checkout, and
    // that stopped being true when the push lane grew one.** What survives is the reason the
    // assertion exists: `RUN_GATE` ships off, so this pipeline gates the contract check only in a
    // run somebody ticked the box on, and two documents described the stage as a gate for a day —
    // the failure mode this record exists to end, a control believed because it was written down.
    // Rather than asking each document for a phrase, all three are held to the parameter's own
    // value, so flipping the default is a decision that cannot be taken in the pipeline alone.
    const declared = runGateDefault();
    expect(declared, 'the Jenkinsfile no longer declares a RUN_GATE boolean parameter').not.toBe(
      null,
    );
    const claim = `\`RUN_GATE\` defaults to \`${declared}\``;
    // **What this sees is the substring, and what it cannot see is the sentence around it.** The
    // clause after this one in `ISSUES.md` Issue 14 went on reading "no lane of either pipeline
    // gates this check by default" for a whole commit after the push lane grew a checkout — false,
    // in the same bullet whose first sentence said the opposite, with this assertion green
    // throughout because the substring never moved. That is the limit of a verbatim check and not
    // a defect in it: it holds the *default*, which is the thing that changes under a pipeline
    // edit. The prose around it is held by a reader, which is how that one was found.
    // Three documents, because three describe the parameter. `README.md` was outside this list
    // while saying `RUN_GATE` "is an opt-in", which is the same claim in words the verbatim check
    // could not see — so a flipped default would have left one of the three describing a pipeline
    // that no longer existed, quietly, which is what this assertion is for.
    for (const doc of ['docs/production-readiness.md', 'ISSUES.md', 'README.md']) {
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

describe('the push lane', () => {
  it('gives the contract check the Chemclaw3 checkout it needs, and refuses to warn instead', () => {
    // **The lane that runs on every push, which is the one this check was missing from.**
    // `tests/backendContract.test.ts` verifies nothing without a Chemclaw3 checkout and says so
    // in a warning; this workflow checked out only this repository, so the sole comparison
    // between what this client sends and what the service declares was a gate in no lane by
    // default — the Jenkins `Gate` stage being behind `RUN_GATE`, which ships off.
    //
    // Two assertions, because a checkout with no variable pointing at it is as silent as no
    // checkout at all, and a variable naming a path nothing populates fails the run rather than
    // the contract.
    expect(
      /repository:\s*8fqycwdt8v-oss\/Chemclaw3\b/.test(workflow),
      'the push lane checks out no Chemclaw3, so the contract check warns there instead of gating',
    ).toBe(true);
    expect(
      /CHEMCLAW3_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.chemclaw3/.test(workflow),
      'the push lane makes a Chemclaw3 checkout and does not tell the reader where it went',
    ).toBe(true);
    expect(
      /CHEMCLAW3_REQUIRED:\s*'1'/.test(workflow),
      'the push lane has a checkout but leaves the check best-effort, so it degrades to a ' +
        'warning the moment the path moves — which is a control this lane would claim and not have',
    ).toBe(true);
  });

  it('pins the revision it reads, so a verdict is a function of two commits', () => {
    // **Without a `ref:`, `actions/checkout` takes the other repository's default branch at the
    // moment the job runs** — so the same UI commit was green one day and red the next with
    // nothing changed here, and re-running an old pull request judged it against today's
    // Chemclaw3. Both records framed the cost of this checkout as "reds on a rename", which is a
    // build that fails for a reason a reader can see; an unpinned ref is a build that is not
    // repeatable, which is a different property and the one that makes a red unanswerable.
    //
    // The assertion is that a ref is *named*, not which one: the default still tracks `main`, so a
    // real rename still reds. What must not come back is the absence.
    const step = siblingSteps().find((s) => /repository:/.test(s.text));
    expect(step, 'the push lane checks out no other repository at all').toBeTruthy();
    expect(
      /^\s*ref:\s*\S/m.test(String(step?.text)),
      "the Chemclaw3 checkout names no `ref:`, so it takes that repository's moving default " +
        "branch and this lane's verdict is not a function of the two commits under test",
    ).toBe(true);

    // And the two lanes name the same fact rather than one of them knowing it. `Jenkinsfile`
    // already parameterised its own clone; a workflow that hardcoded `main` while the other lane
    // took a parameter would be the "two declarations, nothing reconciling them" defect with the
    // reconciliation left to whoever remembers.
    expect(
      pipeline,
      'the Jenkinsfile stopped declaring which Chemclaw3 revision it clones, so the two lanes no ' +
        'longer name one fact',
    ).toContain("string(name: 'CHEMCLAW3_BRANCH'");
  });

  it('names no Chemclaw3 source directory, so it cannot drift from the reader', () => {
    // **The reason this checkout is full where `Jenkinsfile`'s is sparse**, and it is the same
    // argument `test_the_index...`-style derivations make everywhere in this family: the sparse
    // path list in `Preflight` is *derived* from what the contract reader opens, asserted above by
    // `gives its gate the Chemclaw3 checkout the contract reader needs`. Repeating that list here
    // would be a second declaration of one fact with nothing reconciling the two, so a reader that
    // grew a fifth source directory would be fetched by one lane and not the other — silently, in
    // the lane with no `RUN_GATE` in front of it.
    //
    // Driven rather than asserted in prose: every directory the reader opens must be absent from
    // this workflow, which is what makes "it names none" a checked fact rather than a promise.
    const dirs = contractSourceDirs();
    expect(dirs.length, 'found no Chemclaw3 source the contract reader opens').toBeGreaterThan(1);
    const named = dirs.filter((dir) => workflow.includes(`src/chemclaw/${dir}`));
    expect(
      named,
      'the push lane names Chemclaw3 source directories, which is a second copy of the sparse ' +
        'list the Jenkinsfile derives — take the full checkout instead, or reconcile the two',
    ).toEqual([]);
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
