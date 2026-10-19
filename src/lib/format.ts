/** Small display helpers for the chemistry payloads the backend returns. */

/**
 * The locale every scientific number renders in, regardless of the viewer: `1,234.5` must not read
 * as `1.234,5` to another chemist. UI chrome (sizes, counts) keeps the reader's own locale.
 */
const SCIENTIFIC_LOCALE = 'en-US';

/**
 * Below this magnitude, switch to scientific notation; between it and 1, keep significant digits.
 */
const SCIENTIFIC_BELOW = 1e-4;

/** Significant digits for values below 1. */
const SIGNIFICANT_DIGITS = 4;

/**
 * The formatters for the magnitude-aware path, built once: `toLocaleString` with options builds a
 * new `Intl.NumberFormat` per call, which dominated large table renders. The no-options path stays
 * on `toLocaleString` (V8 caches the default formatter). Output is identical
 * (`tests/formatterCache.test.ts`).
 */
const SCIENTIFIC_FORMAT = new Intl.NumberFormat(SCIENTIFIC_LOCALE, {
  notation: 'scientific',
  maximumSignificantDigits: SIGNIFICANT_DIGITS,
});
const SIGNIFICANT_FORMAT = new Intl.NumberFormat(SCIENTIFIC_LOCALE, {
  maximumSignificantDigits: SIGNIFICANT_DIGITS,
});

/**
 * Render a number a chemist might write down. Caller `options` win. The default is magnitude-aware:
 * fixed three-decimal clamping would print tiny values (e.g. 4.2e-6) as `0`. `NaN` and `±Infinity`
 * render as `NaN` and `∞`.
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
