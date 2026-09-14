/**
 * The production-readiness record's own rule, enforced.
 *
 * `docs/production-readiness.md` states what is enforced, bounded, measured and accepted, and its
 * whole value rests on one promise: **every clause that claims something names the test that holds
 * it, and a clause with no test is rewritten as an accepted risk or deleted.** A document that
 * promises that and is not checked is the thing this repository keeps finding — a control that
 * exists in prose, believed because it was written down.
 *
 * Four failures are possible and this file drives all four:
 *
 *  - **A clause that claims and cites nothing.** "Enforced: the proxy is a whitelist" with no test
 *    beside it is an assertion about somebody's intentions. Accepted clauses are exempt by
 *    definition — an accepted risk is precisely the one with nothing holding it — and they are
 *    held to a different rule instead (see below).
 *  - **A claiming clause that cites something that is not a test.** The rule says *the test*, and
 *    the check said *a file*, then *a file whose path starts with `tests/`*: an **Enforced** clause
 *    citing `src/lib/utils.ts`, and later one citing `tests/helpers.ts` or the `tests/stubs`
 *    directory, each passed — so the document promised more than ran. It promised it about nothing:
 *    measured over the record as it stood before either tightening, every Enforced and Bounded
 *    clause in it already cited a real test file, so this rule is prophylactic and no clause was
 *    ever rewritten to satisfy it. (An earlier edition of this paragraph put a fraction on the gap.
 *    There is no quantity there to have: the set of clauses a looser rule *would* have admitted is
 *    not the set it did admit, and that one was empty.) **Enforced** and **Bounded** claim a
 *    refusal or a ceiling, and only a test can drive one, so those two must name a path under
 *    `tests/` or `e2e/` that is itself a `*.test.ts(x)` or `*.spec.ts(x)`. **Measured** is deliberately not held to that: a measurement is a number
 *    somebody ran, and the thing that ran it is a script — two shipped clauses cite
 *    `scripts/measure-*.mjs` and are right to.
 *  - **A citation that has gone stale.** A renamed or deleted test leaves the sentence reading
 *    exactly as it did, which is worse than having no sentence: `tests/decision_log`-style rot,
 *    where the record outlives the thing it records. Every path cited anywhere in the document
 *    must exist on disk.
 *  - **A cross-reference to a section that does not exist.** `§n` was matched as a regex and never
 *    resolved, so an accepted risk could be anchored to `§99` in an eleven-section document and
 *    read as filed. Every `§n` anywhere in the document must name one of its own headings.
 *
 * What this file deliberately does NOT check: that the cited test asserts what the clause says it
 * asserts. Nothing mechanical can, and pretending otherwise would put this file in the same
 * category as the documents it is guarding. What it buys is that the citation is real and current,
 * which is the half a rename breaks silently.
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RECORD = 'docs/production-readiness.md';
const text = readFileSync(resolve(process.cwd(), RECORD), 'utf8');

/**
 * The document's clauses, each as one string.
 *
 * A clause is a `- **Word.** …` bullet plus its indented continuation lines, because prettier
 * wraps prose at 100 characters and every clause in this record is several lines long. Reading
 * line by line would ask each fragment for a citation the clause carries once.
 *
 * **At any indent**, and that was a hole rather than a detail: the first edition started a clause
 * only at column 0 and appended every indented line to the previous clause's body, so a nested
 * `  - **Enforced.** …` with no citation was absorbed into a parent that had one and never
 * existed as far as this file was concerned. Driven — it passed. A sub-bullet is the natural way
 * this document grows, and `found.length > 20` cannot see a clause merged into its neighbour;
 * `parses a nested clause as a clause` below reads the bodies for a swallowed one, which is the
 * half that stays true if this parser is ever rewritten.
 */
function clauses(): { kind: string; body: string; line: number }[] {
  const out: { kind: string; body: string; line: number }[] = [];
  const lines = text.split('\n');
  let current: { kind: string; body: string; line: number } | null = null;
  lines.forEach((line, index) => {
    const start = /^\s*- \*\*(Enforced|Bounded|Measured|Accepted)\b/.exec(line);
    if (start) {
      if (current) out.push(current);
      // Trimmed, so a clause body never *begins* with whitespace — which is what lets the
      // swallow check below look for a clause start preceded by whitespace and mean it.
      current = { kind: start[1] as string, body: line.trim(), line: index + 1 };
      return;
    }
    if (current && /^\s+\S/.test(line)) {
      current.body += ` ${line.trim()}`;
      return;
    }
    if (current && line.trim() === '') return; // a blank line inside a section, not a terminator
    if (current) {
      out.push(current);
      current = null;
    }
  });
  if (current) out.push(current);
  return out;
}

/** Every repository path the document cites, in backticks, anywhere — clause or prose. */
function citations(body: string): string[] {
  return [...body.matchAll(/`((?:tests|e2e|scripts|src|server|shared|docs)\/[^`\s]+)`/g)].map(
    (match) => (match[1] as string).replace(/[.,;:]$/, ''),
  );
}

/**
 * The cited paths that are tests — the only kind of file that can hold a refusal or a ceiling.
 *
 * `scripts/` is deliberately not one: a script runs a measurement and produces a number, which is
 * what **Measured** claims, and holding it to the same rule would force two honest clauses to cite
 * a test that does not exist.
 *
 * The suffix is checked, not just the directory. `tests/` is where this repository's *test
 * helpers* live too — `backendContract.ts`, `gateSteps.ts`, `helpers.ts`, `scriptInvocations.ts`
 * and the `stubs/` directory, none of which drives an assertion — so a prefix admitted an Enforced
 * clause citing a module nothing runs, and a directory name at that. Driven before this was
 * tightened: `(\`tests/stubs\`)` and `(\`tests/helpers.ts\`)` each passed the whole file.
 */
const testCitations = (body: string): string[] =>
  citations(body).filter((path) => /^(?:tests|e2e)\/.*\.(?:test|spec)\.tsx?$/.test(path));

/** The section numbers this document actually has, off its own `## n.` headings. */
const sections = (): Set<number> =>
  new Set([...text.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1])));

describe('the production-readiness record', () => {
  const found = clauses();

  it('is made of clauses this test can actually see', () => {
    // The whole file is a loop over `clauses()`. A parse that returns nothing — a heading style
    // changed, prettier reflowing differently — would make every assertion below pass over an
    // empty list, which is the shape of every test this repository has caught passing with its
    // subject deleted. Four is the number of kinds; there are many more clauses than kinds.
    expect(found.length, `no clauses parsed out of ${RECORD}`).toBeGreaterThan(20);
    expect(new Set(found.map((clause) => clause.kind))).toEqual(
      new Set(['Enforced', 'Bounded', 'Measured', 'Accepted']),
    );
  });

  it('names a file for every clause that claims something', () => {
    const uncited = found
      .filter((clause) => clause.kind !== 'Accepted' && citations(clause.body).length === 0)
      .map((clause) => `${RECORD}:${clause.line} ${clause.body.slice(0, 90)}…`);
    expect(
      uncited,
      'an Enforced/Bounded/Measured clause with no file beside it — make it Accepted, or name what holds it',
    ).toEqual([]);
  });

  it('names a test for every clause that claims a refusal or a ceiling', () => {
    // The document's rule is "every clause names **the test** that holds it", and for two of the
    // four words that is the whole claim: Enforced says something is refused, Bounded says a
    // ceiling is asserted, and a source file cannot drive either. Measured is exempt on purpose
    // (see `testCitations`), and Accepted claims nothing.
    const sourceOnly = found
      .filter(
        (clause) =>
          (clause.kind === 'Enforced' || clause.kind === 'Bounded') &&
          testCitations(clause.body).length === 0,
      )
      .map((clause) => `${RECORD}:${clause.line} ${clause.body.slice(0, 90)}…`);
    expect(
      sourceOnly,
      'an Enforced/Bounded clause naming no test — a file under src/ or server/ is the thing ' +
        'being claimed about, not the thing that holds it. Cite a test, or make it Measured/Accepted',
    ).toEqual([]);
  });

  it('parses a nested clause as a clause, rather than absorbing it into its neighbour', () => {
    // Independent of the regex above, and that is the point: if the parser is ever rewritten to
    // start clauses at column 0 again, a nested `  - **Enforced.** …` reappears *inside* a
    // neighbouring clause's body, where it inherits that clause's citation and is never asked for
    // one of its own. Driven before the fix: it passed.
    const swallowed = found
      .filter((clause) => /\s- \*\*(Enforced|Bounded|Measured|Accepted)\b/.test(clause.body))
      .map((clause) => `${RECORD}:${clause.line} ${clause.body.slice(0, 90)}…`);
    expect(
      swallowed,
      'a clause body contains another clause — the parser merged them, so the inner one is held ' +
        'to nothing',
    ).toEqual([]);
  });

  it('cross-references only sections it has', () => {
    // `§n` was matched as a shape and never resolved, so `§99` anchored an accepted risk in an
    // eleven-section document and read as filed. Over the whole document rather than over Accepted
    // clauses alone: a stale §n in prose misdirects a reader exactly as far.
    const have = sections();
    expect(
      have.size,
      'no `## n.` headings parsed, so this check would accept anything',
    ).toBeGreaterThan(5);
    const dangling = [...new Set([...text.matchAll(/§(\d+)/g)].map((match) => Number(match[1])))]
      .filter((number) => !have.has(number))
      .map((number) => `§${number}`);
    expect(dangling, `${RECORD} points at sections it does not have`).toEqual([]);
  });

  it('cites no file that has gone away', () => {
    const missing = [...new Set(citations(text))].filter(
      (path) => !existsSync(resolve(process.cwd(), path)),
    );
    expect(missing, `${RECORD} cites files that do not exist`).toEqual([]);
  });

  it('says where every accepted risk is recorded', () => {
    // An accepted risk is exempt from naming a test — that is what accepted means — but not from
    // being findable. Each one points at `ISSUES.md`, at another section of this document, or at
    // the file where the decision is written down, so "accepted" cannot become a place things go
    // to stop being tracked.
    const unanchored = found
      .filter(
        (clause) =>
          clause.kind === 'Accepted' &&
          !/ISSUES\.md|tasks\/todo\.md/.test(clause.body) &&
          ![...clause.body.matchAll(/§(\d+)/g)].some((match) => sections().has(Number(match[1]))) &&
          citations(clause.body).length === 0,
      )
      .map((clause) => `${RECORD}:${clause.line} ${clause.body.slice(0, 90)}…`);
    expect(unanchored, 'an accepted risk with nowhere to read the rest of it').toEqual([]);
  });

  it('is linked from the README, or nobody will find it', () => {
    expect(readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')).toContain(RECORD);
  });
});
