/**
 * Talking to the composer from components that cannot reach it (citation chips, prompt buttons,
 * rail rows, structure hits), via window events. One module so `tests/prefillContract.test.tsx`
 * checks every producer.
 *
 * `chemclaw:prefill` replaces the draft: the sender hands over a whole question.
 * `chemclaw:insert-structure` inserts at the caret and keeps the draft, since a structure is rarely
 * the whole question (same rule as `Composer.insertStructure`).
 */

export const PREFILL_EVENT = 'chemclaw:prefill';
export const INSERT_STRUCTURE_EVENT = 'chemclaw:insert-structure';

/** What rides on `chemclaw:prefill`. A bare string is the no-send form. */
export type PrefillDetail = string | { text: string; autoSend?: boolean };

/**
 * Detail of `chemclaw:insert-structure`. `smiles` must be canonical, or the entity rail would get a
 * second row for one compound; every producer already holds an RDKit-read string.
 */
export interface InsertStructureDetail {
  smiles: string;
}

/** Fill the composer and focus it. The human presses Send. */
export function prefill(text: string): void {
  window.dispatchEvent(new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail: text }));
}

/**
 * Fill the composer and submit. Only for one-tap approve/decline and Retry on a lost answer
 * (`turn_interrupted`); always a press on a sentence the chemist just read.
 */
export function prefillAndSend(text: string): void {
  window.dispatchEvent(
    new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail: { text, autoSend: true } }),
  );
}

/**
 * Put a structure into the message at the caret. Never sends: a structure that sent itself would be
 * a tool call composed by a click.
 */
export function insertStructure(smiles: string): void {
  window.dispatchEvent(
    new CustomEvent<InsertStructureDetail>(INSERT_STRUCTURE_EVENT, { detail: { smiles } }),
  );
}
