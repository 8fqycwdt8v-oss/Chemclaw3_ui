/** Small display helpers for the chemistry payloads the backend returns. */

/**
 * The locale every *scientific* number is rendered in, whoever is looking at it.
 *
 * A bare `toLocaleString()` follows the browser, so the same pKa reads `1,234.5` to one chemist
 * and `1.234,5` to the next — and the two forms disagree by three orders of magnitude and one
 * decimal place. Nothing on screen says which convention is in force, so a value transcribed by
 * hand, quoted in an email or read off a screenshot carries no way to tell. The CSV export
 * already refuses the question by writing `String(value)`; this is the same decision for the
 * screen, where grouping is worth keeping for legibility but must not vary by viewer.
 *
 * Deliberately not applied to UI chrome — a byte size or a character count is a fact about the
 * interface, not a measurement anybody transcribes, and there the reader's own conventions are
 * the right ones.
 */
const SCIENTIFIC_LOCALE = 'en-US';

/**
 * Below this magnitude a fixed-point rendering stops being readable — `0.0000000012` is a string
 * nobody counts the zeroes of correctly — so the notation switches to scientific. Above it, and
 * below 1, the digits are kept significant rather than positional.
 */
const SCIENTIFIC_BELOW = 1e-4;

/**
 * Significant digits for a value smaller than 1. Four is what a measurement in this app carries:
 * a Boltzmann population is reported to four places, and a rate constant is quoted to two or
 * three. Above 1 the default grouping is already right and is left alone.
 */
const SIGNIFICANT_DIGITS = 4;

/**
 * The two formatters the magnitude-aware path uses, built once.
 *
 * `Number.prototype.toLocaleString` constructs an `Intl.NumberFormat` on every call, and V8 caches
 * exactly one of them: the *default* one for a locale. Hand it an options object and the cache is
 * missed, every time. Measured in bare node 22 over 1,000 sub-1 values, with a throwaway harness
 * kept out of the tree: **35.3 µs/call with options against 0.75 µs/call through a hoisted
 * formatter — 47×**. That is not a micro-optimization on a cold path: sub-1 magnitudes are what a
 * chemistry payload is made of — similarity scores, mole fractions, catalyst loadings, Boltzmann
 * populations, rate constants — so the options branch is the branch this app takes, and `AutoTable`
 * calls it once per numeric cell. End to end, the same 2,000-row ten-column result — three of those
 * columns below 1, so 6,000 such cells — rendered ~1,747 ms before this change and ~1,133 ms after
 * (vitest + happy-dom, one paired run). A table whose columns were *all* sub-1 would have been
 * spending 847 ms of a 24,000-cell render inside this one function.
 *
 * **The no-options path below is deliberately left on `toLocaleString`.** The obvious symmetry —
 * hoist all three — was measured and is not an improvement: the default formatter *is* the one V8
 * caches, and a hoisted instance came out at 0.75 µs against 0.63 µs for the method call. Caching
 * something already cached buys nothing and costs a reader the question of why it is there.
 *
 * The output is byte-identical by construction: `toLocaleString(locale, options)` is specified as
 * `new Intl.NumberFormat(locale, options).format(value)`, and `tests/formatterCache.test.ts` proves
 * it against the pre-hoist expression over 900-odd values rather than trusting the spec.
 */
const SCIENTIFIC_FORMAT = new Intl.NumberFormat(SCIENTIFIC_LOCALE, {
  notation: 'scientific',
  maximumSignificantDigits: SIGNIFICANT_DIGITS,
});
const SIGNIFICANT_FORMAT = new Intl.NumberFormat(SCIENTIFIC_LOCALE, {
  maximumSignificantDigits: SIGNIFICANT_DIGITS,
});

/**
 * Render a number a chemist might write down.
 *
 * `options` is passed through for the rare call that knows its own precision — an energy in
 * kcal/mol is meaningless past a tenth — and it wins outright, because a call site that states its
 * precision has said more than this function can infer. It is also the one path that still pays the
 * uncached ~35 µs, and that is left alone rather than fixed: a caller's options object has no
 * identity to cache on, and the only caller in `src/` is `formatEnergy` — once per finished job
 * card, not once per cell.
 *
 * The default is magnitude-aware, and it did not used to be. `Intl`'s own default is
 * `maximumFractionDigits: 3`, which is a *fixed-decimal* clamp and not a precision: every value
 * below 5e-4 printed as `0`, through `AutoTable` — the generic renderer for ANY tool result — and
 * through the entity rail, which is on screen for every structure a turn mentioned. A rate
 * constant of 4.2e-6 read `0`, a whole column of them read `0`, and nothing on screen said the
 * number had been rounded rather than measured. This repository is arranged against exactly that:
 * a wrong number reaching a chemist unwarned.
 *
 * `NaN` and `±Infinity` are decided rather than inherited: they keep `Intl`'s `NaN` and `∞`. Neither
 * can cross JSON, so this is about what the screen would say if one ever arrived — and both are
 * unmistakable for a measurement, which `0` would not be.
 */
export function formatScientificNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (options) return value.toLocaleString(SCIENTIFIC_LOCALE, options);
  const magnitude = Math.abs(value);
  if (!Number.isFinite(value) || value === 0 || magnitude >= 1) {
    return value.toLocaleString(SCIENTIFIC_LOCALE);
  }
  // Through the hoisted formatters — see their docstring for the 47× and for why the two branches
  // above are not treated the same way.
  return (magnitude < SCIENTIFIC_BELOW ? SCIENTIFIC_FORMAT : SIGNIFICANT_FORMAT).format(value);
}

/** Hartree to kcal/mol. The backend reports QM energies in hartree; chemists mostly think in
 *  kcal/mol, so we show both rather than making anyone convert in their head. */
export const HARTREE_TO_KCAL = 627.5094740631;

export function formatEnergy(hartree: number): string {
  const kcal = hartree * HARTREE_TO_KCAL;
  return `${hartree.toFixed(6)} Eh (${formatScientificNumber(kcal, {
    maximumFractionDigits: 1,
  })} kcal/mol)`;
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Human label for a tool name, e.g. `gather_evidence` -> `Gather evidence`. */
export function toolLabel(tool: string): string {
  const words = tool.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
