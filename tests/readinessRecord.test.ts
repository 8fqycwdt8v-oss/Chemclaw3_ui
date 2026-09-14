/**
 * The production-readiness record's own rule, enforced.
 *
 * `docs/production-readiness.md` states what is enforced, bounded, measured and accepted, and its
 * whole value rests on one promise: **every clause that claims something names the test that holds
 * it, and a clause with no test is rewritten as an accepted risk or deleted.** A document that
 * promises that and is not checked is the thing this repository keeps finding — a control that
 * exists in prose, believed because it was written down.
 *
 * Two failures are possible and this file drives both:
 *
 *  - **A clause that claims and cites nothing.** "Enforced: the proxy is a whitelist" with no test
 *    beside it is an assertion about somebody's intentions. Accepted clauses are exempt by
 *    definition — an accepted risk is precisely the one with nothing holding it — and they are
 *    held to a different rule instead (see below).
 *  - **A citation that has gone stale.** A renamed or deleted test leaves the sentence reading
 *    exactly as it did, which is worse than having no sentence: `tests/decision_log`-style rot,
 *    where the record outlives the thing it records. Every path cited anywhere in the document
 *    must exist on disk.
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
 */
function clauses(): { kind: string; body: string; line: number }[] {
  const out: { kind: string; body: string; line: number }[] = [];
  const lines = text.split('\n');
  let current: { kind: string; body: string; line: number } | null = null;
  lines.forEach((line, index) => {
    const start = /^- \*\*(Enforced|Bounded|Measured|Accepted)\b/.exec(line);
    if (start) {
      if (current) out.push(current);
      current = { kind: start[1] as string, body: line, line: index + 1 };
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
          !/ISSUES\.md|tasks\/todo\.md|§\d/.test(clause.body) &&
          citations(clause.body).length === 0,
      )
      .map((clause) => `${RECORD}:${clause.line} ${clause.body.slice(0, 90)}…`);
    expect(unanchored, 'an accepted risk with nowhere to read the rest of it').toEqual([]);
  });

  it('is linked from the README, or nobody will find it', () => {
    expect(readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')).toContain(RECORD);
  });
});
