/**
 * Reading a tool result without believing anything about it. A stored result is text, so everything
 * here is defensive and the floor is the raw text.
 *
 * Matchers key on payload shape rather than tool name, so new tools with familiar shapes render on
 * the day they ship. A tool name is used only where the shape cannot identify the payload
 * (`ich_impurity_limit`'s miss is `{limit: null}`).
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
 * A run of numbers worth drawing, with the key the service filed it under (the only honest label,
 * used verbatim). At least three points.
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
 * Could this string be a structure? Syntactic only; `Molecule` is the arbiter and shows a refused
 * string as text. Re-exported so there is one definition.
 */
export { mightBeStructure } from '../chem/structure.ts';
