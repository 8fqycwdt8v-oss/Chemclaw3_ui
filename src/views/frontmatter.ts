/**
 * A knowledge note, split into its YAML frontmatter and its Markdown body.
 *
 * A proposal's `content` is a note file exactly as it would land in the tree: a `---` fenced
 * header, then prose. The header is where the structure lives — `type` says what kind of thing
 * the note is and `compound_smiles` is the one place in this entire system where a structure is a
 * *typed field* rather than something recovered from text — so a reviewer who cannot see it
 * rendered is reviewing a wall of YAML.
 *
 * **This parses a deliberate subset and reports what it skipped.** No YAML library: the whole
 * dependency would be pulled in to read a header that `frontmatter.dumps` emits in one narrow
 * shape (block style, sorted keys, scalars and lists of scalars). What it does not model — chiefly
 * `relations:`, a list of mappings — is named in `unparsed` rather than dropped, because the
 * failure this file must not have is a reviewer approving bytes a parser quietly hid from them.
 * For the same reason the review view shows the raw file alongside anything derived from it: the
 * structured rendering is an aid, and the bytes are what is being signed off.
 */

export interface ParsedNote {
  /** False when the content had no `---` header at all — then it is not a note and `body` is the
   *  whole file. A `dependencies` entry can legitimately be one (a data file, say). */
  hasFrontmatter: boolean;
  /** Scalars and lists-of-scalars from the header, in file order. */
  fields: Record<string, string | string[]>;
  /** Header keys this parser saw and deliberately did not model. Shown to the reader. */
  unparsed: string[];
  body: string;
}

const FENCE = '---';
const KEY = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/;

export function parseNote(content: string): ParsedNote {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { hasFrontmatter: false, fields: {}, unparsed: [], body: content };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    // An unterminated fence is not a header — treating the rest of the file as one would hide the
    // note's whole body behind a parse error.
    return { hasFrontmatter: false, fields: {}, unparsed: [], body: content };
  }

  const fields: Record<string, string | string[]> = {};
  const unparsed: string[] = [];

  for (let i = 1; i < close; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const match = KEY.exec(line);
    if (!match) continue; // a continuation line; the block that owns it decides what to do
    const [, key = '', rest = ''] = match;

    if (rest.trim() !== '') {
      fields[key] = rest.trim() === '[]' ? [] : unquote(rest.trim());
      continue;
    }

    // A block value: either `- item` entries or a nested mapping. Consume the indented run.
    const items: string[] = [];
    let nested = false;
    let j = i + 1;
    for (; j < close; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (!/^[ \t]/.test(next) && !next.startsWith('- ')) break;
      if (next.startsWith('- ') && !next.includes(': ')) items.push(unquote(next.slice(2).trim()));
      else nested = true;
    }
    i = j - 1;

    if (nested) unparsed.push(key);
    else fields[key] = items;
  }

  return {
    hasFrontmatter: true,
    fields,
    unparsed,
    body: lines.slice(close + 1).join('\n').replace(/^\n+/, ''),
  };
}

/** Strip the quoting PyYAML adds only when a scalar needs it, and nothing else. A value that was
 *  not quoted is returned byte-for-byte — a SMILES must never be "cleaned up". */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

/** A header field as a string, or `undefined` when it is absent or was a list. */
export function field(note: ParsedNote, key: string): string | undefined {
  const value = note.fields[key];
  return typeof value === 'string' ? value : undefined;
}

/** A header field as a list, or `[]`. A single scalar counts as a one-item list, which is how
 *  YAML would have read it too. */
export function list(note: ParsedNote, key: string): string[] {
  const value = note.fields[key];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}
