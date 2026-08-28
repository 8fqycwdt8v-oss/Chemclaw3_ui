/**
 * Reading a tool result without believing anything about it.
 *
 * A stored tool result is text. Upstream types it that way on purpose — a result is whatever the
 * framework handed back, and a store that promised JSON would have to fail or lie about the ones
 * that are not — so everything here is defensive by construction and the floor is always the raw
 * text.
 *
 * The matchers below are what decide which renderer a result gets, and they key on **shape**
 * rather than on tool name wherever a shape exists to key on. That is not tidiness: the service
 * registers ~56 tools and grows, and a renderer table keyed on names means every new tool is
 * invisible until somebody writes an entry for it. A shape-keyed table renders the next
 * fingerprint search, the next severity table and the next run sheet on the day they ship.
 *
 * Where a tool name IS used it is because the shape genuinely does not identify the payload —
 * `ich_impurity_limit`'s miss is `{limit: null}`, which is indistinguishable from anything else
 * carrying a null field.
 */

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The records in an array, ignoring anything in it that is not one. */
export const rows = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

/** The strings in an array, ignoring anything else — several payloads carry mixed lists. */
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * A run of numbers worth drawing, and the key the service filed it under.
 *
 * Deliberately unopinionated about what the numbers *mean*. Nothing on the wire says whether a
 * series is a yield, an energy or a count, so the key name is the only honest label available and
 * it is used verbatim. Three points is the floor: two points is a pair of values, not a shape.
 */
export interface NumericSeries {
  key: string;
  values: number[];
}

export function numericSeries(data: Json): NumericSeries | null {
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value) || value.length < 3) continue;
    const values = value.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (values.length === value.length) return { key, values };
  }
  return null;
}

/** The scalar numbers an object carries at its top level, in the order the service wrote them. */
export function scalarNumbers(data: Json): { key: string; value: number }[] {
  const out: { key: string; value: number }[] = [];
  for (const [key, value] of Object.entries(data)) {
    const n = num(value);
    if (n !== null) out.push({ key, value: n });
  }
  return out;
}

/** The first key whose value is a non-empty array of records — the generic table's subject. */
export const firstRecordList = (data: Json): string | undefined =>
  Object.keys(data).find((k) => rows(data[k]).length > 0);

/**
 * Could this string be a structure?
 *
 * Syntactic on purpose: `Molecule` is the arbiter and shows the string it refused rather than an
 * empty box, so a row whose label is not really a structure degrades to visible text rather than
 * to a lie. Re-exported from the chemistry module so there is one definition of the question.
 */
export { mightBeStructure } from '../chem/structure.ts';
