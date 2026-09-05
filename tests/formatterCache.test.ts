/**
 * Hoisting the `Intl.NumberFormat`s changed how fast the number is rendered and nothing else.
 *
 * `Number.prototype.toLocaleString(locale, options)` is specified as
 * `new Intl.NumberFormat(locale, options).format(value)`, so replacing the call with a formatter
 * built once is a *transformation with no output*. It is also the kind of claim that is easy to
 * assert and easy to be wrong about at one value in ten thousand — a boundary, a signed zero, a
 * subnormal — and a display helper that quietly moved a decimal point would be exactly the failure
 * `scientificNotation.test.tsx` exists to prevent, arriving through the fix for something else.
 *
 * So this file is the proof rather than an assertion: the pre-hoist expression is transcribed
 * verbatim below as `beforeHoisting` and every value is compared **byte for byte** against what the
 * shipped function returns. Transcribed rather than imported, deliberately — importing the constants
 * the implementation uses would let a changed locale or a changed digit count agree with itself and
 * pass.
 *
 * The second `describe` is the part that fails without the change, and it is a claim about the
 * mechanism rather than about a duration: on the magnitude-aware path the shipped code must not
 * touch `Number.prototype.toLocaleString` at all, because that method is where the 47× goes. A
 * wall-clock assertion was considered and rejected — a ratio measured inside a CI container is a
 * flake, and the number that matters (35.3 µs against 0.75 µs, node 22, 1,000 sub-1 values) belongs
 * in the docstring it was measured for.
 */

import { describe, expect, it, vi } from 'vitest';
import { formatScientificNumber } from '../src/lib/format.ts';

/** Exactly what `formatScientificNumber` was before the formatters were hoisted out of it. */
function beforeHoisting(value: number, options?: Intl.NumberFormatOptions): string {
  if (options) return value.toLocaleString('en-US', options);
  const magnitude = Math.abs(value);
  if (!Number.isFinite(value) || value === 0 || magnitude >= 1) {
    return value.toLocaleString('en-US');
  }
  return value.toLocaleString(
    'en-US',
    magnitude < 1e-4
      ? { notation: 'scientific', maximumSignificantDigits: 4 }
      : { maximumSignificantDigits: 4 },
  );
}

/**
 * Every value the two implementations are compared over.
 *
 * Built rather than listed: a hand-written list is a list of the cases somebody thought of, and the
 * one that breaks a formatter is the one nobody did. The sweep is nine mantissas across 49 decades,
 * both signs, so it crosses the `1e-4` notation boundary, the `1` significant-digits boundary and
 * the point where grouping separators appear, from both sides and at every mantissa.
 */
function probeValues(): number[] {
  const values: number[] = [];
  for (let exponent = -18; exponent <= 30; exponent++) {
    for (const mantissa of [1, 1.5, 2.25, 3.14159, 4.2, 5, 6.0221408, 8.999, 9.9999]) {
      const v = mantissa * Math.pow(10, exponent);
      values.push(v, -v);
    }
  }
  values.push(
    // The two boundaries this function is built on, from both sides and at the value itself.
    1e-4,
    -1e-4,
    9.999e-5,
    -9.999e-5,
    1.0001e-4,
    0.00009999,
    0.999999999,
    1,
    1.000000001,
    -0.999999999,
    -1,
    // Zero, both signs. `-0 === 0`, so the sign is carried entirely by the formatter.
    0,
    -0,
    // The edges of the double.
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.EPSILON,
    Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    5e-324,
    1e21,
    // Not measurements, and neither can cross JSON — but both decide what the screen would say.
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  return values;
}

describe('the hoisted formatters render exactly what the per-call ones did', () => {
  it('agrees byte for byte across every magnitude, both signs, and the boundaries between them', () => {
    const values = probeValues();
    // Over 900 values, so a mismatch is reported as the value that broke rather than as a diff of
    // two enormous arrays nobody can read.
    const mismatches = values
      .map((value) => ({ value, want: beforeHoisting(value), got: formatScientificNumber(value) }))
      .filter((row) => row.want !== row.got);

    expect(mismatches).toEqual([]);
    expect(values.length).toBeGreaterThan(900);
  });

  it('agrees on the caller-supplied precision path, which is deliberately still uncached', () => {
    // `formatEnergy`'s own options, plus the shapes a call site might plausibly state. This branch
    // was not changed; the proof covers it so that a later attempt to cache it has a baseline.
    const optionSets: Intl.NumberFormatOptions[] = [
      { maximumFractionDigits: 1 },
      { maximumFractionDigits: 0 },
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
      { maximumSignificantDigits: 2 },
      { notation: 'scientific' },
      { style: 'percent' },
    ];
    for (const options of optionSets) {
      for (const value of [0, -0, 1234.5, 0.0000032, -4.2e-6, 6.022e23, Number.NaN]) {
        expect(formatScientificNumber(value, options)).toBe(beforeHoisting(value, options));
      }
    }
  });
});

describe('the magnitude-aware path no longer builds a formatter per call', () => {
  it('does not call toLocaleString for a value below 1', () => {
    // The probe is the method the old code went through. It is on `Number.prototype`, so a spy on
    // it sees every construction the old implementation paid for and none of the hoisted ones.
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      // Both sub-1 branches: scientific below 1e-4, significant digits between that and 1.
      formatScientificNumber(3.2e-6);
      formatScientificNumber(0.5136);
      formatScientificNumber(-0.0009);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still goes through toLocaleString where V8 already caches the formatter', () => {
    // The other half of the same decision, asserted so that "hoist all three" cannot be done
    // silently: the no-options formatter is the one V8 caches, and a hoisted instance measured
    // slower (0.75 µs against 0.63 µs). Values at or above 1, zero and the non-finites take it.
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      formatScientificNumber(1234.5);
      formatScientificNumber(0);
      formatScientificNumber(Number.NaN);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
