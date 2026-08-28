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
 * Render a number a chemist might write down.
 *
 * `options` is passed through for the rare call that knows its own precision — an energy in
 * kcal/mol is meaningless past a tenth — and it wins outright, because a call site that states its
 * precision has said more than this function can infer.
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
  return value.toLocaleString(
    SCIENTIFIC_LOCALE,
    magnitude < SCIENTIFIC_BELOW
      ? { notation: 'scientific', maximumSignificantDigits: SIGNIFICANT_DIGITS }
      : { maximumSignificantDigits: SIGNIFICANT_DIGITS },
  );
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
