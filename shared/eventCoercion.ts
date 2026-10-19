/**
 * The coercion vocabulary the generated event schemas (`shared/generated/events.ts`) are written in.
 *
 * One helper per shape this wire carries. Each is a `v.fallback`, so a malformed field costs that
 * field and never the event: a turn that carried one bad value still renders. The generator picks
 * the helper from the document's schema for the field; `shared/events.ts` overrides the few fields
 * whose reading is a UI decision rather than a fact of the document.
 *
 * Imported by the SPA, the BFF and the e2e fixture service; `valibot` is its one dependency.
 */

import * as v from 'valibot';

/** A string, or the stated fallback. The shape most of this wire has. */
export const text = (fallback = '') => v.fallback(v.string(), fallback);

/** A string, or `null`; anything else reads as `null`. */
export const textOrNull = () => v.fallback(v.nullable(v.string()), null);

/** Every entry stringified; a non-array is empty. */
export const textList = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) => entries.map(String)),
    ),
    [] as string[],
  );

/**
 * Finite numbers only. This array feeds numeric rendering, and one `NaN` in it is a blank cell
 * nobody can explain.
 */
export const numberList = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)),
      ),
    ),
    [] as number[],
  );

/** A finite number, never `NaN`/`Infinity`; `0` is the honest reading of "not reported". */
export const finiteNumber = (fallback = 0) => v.fallback(v.pipe(v.number(), v.finite()), fallback);

/** A finite number, or `null` where the sender said it could not tell. */
export const numberOrNull = () => v.fallback(v.nullable(v.pipe(v.number(), v.finite())), null);

/**
 * A count, never `NaN`/`Infinity`. Same reason as `numberList`'s filter, and `0` is the honest
 * reading of "not reported".
 */
export const count = (fallback = 0) =>
  v.fallback(
    v.pipe(
      v.number(),
      v.check((n: number) => Number.isFinite(n)),
      v.transform((n) => Math.trunc(n)),
    ),
    fallback,
  );

/**
 * A count, or `null` where the sender said it could not tell — which is information a `0` would
 * erase ("nobody is waiting" and "the broker would not say" are different readings).
 */
export const countOrNull = () =>
  v.fallback(
    v.nullable(
      v.pipe(
        v.number(),
        v.check((n: number) => Number.isFinite(n) && n >= 0),
        v.transform((n) => Math.trunc(n)),
      ),
    ),
    null,
  );

/** A real boolean, never merely truthy: anything else falls back to the unqualified reading. */
export const flag = (fallback = false) => v.fallback(v.boolean(), fallback);

/** One of a closed set, or the stated fallback. */
export const oneOf = <T extends string>(options: readonly [T, ...T[]], fallback: T) =>
  v.fallback(v.picklist(options), fallback);

/**
 * One of a closed set, or `null`; an unknown value reads as nothing rather than as the wrong
 * something.
 */
export const oneOfOrNull = <T extends string>(options: readonly [T, ...T[]]) =>
  v.fallback(v.nullable(v.picklist(options)), null);

/**
 * The members of a closed set, dropping the rest. The narrowing is per member: an unknown entry
 * would otherwise reach a renderer as a check that ran.
 */
export const listOf = <T extends string>(options: readonly [T, ...T[]]) =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.filter((x): x is T => (options as readonly unknown[]).includes(x)),
      ),
    ),
    [] as T[],
  );

/** Any object, untouched. Nothing here to validate, and pretending otherwise would drop keys. */
export const anyObject = () =>
  v.fallback(
    v.custom<Record<string, unknown>>((x) => typeof x === 'object' && x !== null),
    {} as Record<string, unknown>,
  );

/**
 * The rows of a list that satisfy a row schema, dropping the rest: one malformed row costs that row
 * and not the list.
 */
export const rowsOf = <T extends v.GenericSchema>(row: T) =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = v.safeParse(row, entry);
          return parsed.success ? [parsed.output as v.InferOutput<T>] : [];
        }),
      ),
    ),
    [] as v.InferOutput<T>[],
  );
