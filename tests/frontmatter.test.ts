/**
 * The note-frontmatter subset the review view parses.
 *
 * Worth pinning without a component around it, because the failure this parser must not have is
 * silent: a reviewer signs off on bytes, and a header key the parser drops without saying so is a
 * fact hidden from the person whose whole job is to see it. So the cases below are as much about
 * what lands in `unparsed` as about what lands in `fields`.
 *
 * The fixtures are the shape `frontmatter.dumps` actually emits — block style, sorted keys — taken
 * from the backend's own seed corpus (`knowledge/compound/*.md`).
 */

import { describe, expect, it } from 'vitest';
import { field, list, parseNote } from '../src/views/frontmatter.ts';

const COMPOUND = `---
artifact_refs: []
calc_refs: []
compound_smiles: COc1ccc(Br)cc1
confidence: 0.9
created_by: agent
id: compound-4-bromoanisole
relations: []
source: seed-corpus
tags:
- aryl-halide
- reagent
type: compound
---

An electron-rich aryl bromide.

- also written: 4-bromoanisole
`;

describe('note frontmatter', () => {
  it('reads the structure field the review view draws from', () => {
    const note = parseNote(COMPOUND);
    expect(note.hasFrontmatter).toBe(true);
    expect(field(note, 'compound_smiles')).toBe('COc1ccc(Br)cc1');
    expect(field(note, 'type')).toBe('compound');
    expect(list(note, 'tags')).toEqual(['aryl-halide', 'reagent']);
  });

  it('keeps the body out of the header and the header out of the body', () => {
    const note = parseNote(COMPOUND);
    expect(note.body).toContain('An electron-rich aryl bromide.');
    expect(note.body).not.toContain('compound_smiles');
  });

  it('treats an empty flow list as a list, not as the string "[]"', () => {
    // `relations: []` renders as "—" in the metadata strip; as a string it would render "[]",
    // which reads like a value rather than an absence.
    expect(list(parseNote(COMPOUND), 'relations')).toEqual([]);
    expect(field(parseNote(COMPOUND), 'relations')).toBeUndefined();
  });

  it('names a structured key it did not model rather than dropping it', () => {
    const note = parseNote(`---
id: rxn-suzuki-biaryl
relations:
- kind: precursor-of
  target: compound-4-bromoanisole
type: reaction
---
body
`);
    expect(note.unparsed).toContain('relations');
    // The keys around it still parse — one unmodelled block must not swallow the rest.
    expect(field(note, 'id')).toBe('rxn-suzuki-biaryl');
    expect(field(note, 'type')).toBe('reaction');
  });

  it('returns a file with no header as a body, not as a parse failure', () => {
    // A `dependencies` entry may legitimately not be a note at all.
    const note = parseNote('just a data file\nwith lines\n');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.body).toBe('just a data file\nwith lines\n');
  });

  it('does not treat an unterminated fence as a header that ate the file', () => {
    const note = parseNote('---\nid: broken\nstill going\n');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.body).toContain('still going');
  });

  it('unquotes only what YAML quoted, and never rewrites a SMILES', () => {
    const note = parseNote(`---
compound_smiles: 'C#N'
source: "it's fine"
type: compound
---
`);
    // A quoted SMILES comes back exactly as written inside the quotes; an unquoted one is
    // returned byte-for-byte, which is the property that matters — a "cleaned up" SMILES is a
    // different molecule.
    expect(field(note, 'compound_smiles')).toBe('C#N');
    expect(field(note, 'source')).toBe("it's fine");
  });
});
