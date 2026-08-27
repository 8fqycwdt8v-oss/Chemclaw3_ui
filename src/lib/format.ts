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
 * Render a number a chemist might write down.
 *
 * `options` is passed through for the rare call that knows its own precision — an energy in
 * kcal/mol is meaningless past a tenth — and defaults to `Intl`'s, which is what every one of
 * these call sites already got.
 */
export function formatScientificNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(SCIENTIFIC_LOCALE, options);
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
