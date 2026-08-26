/**
 * Talking to the composer from somewhere that cannot reach it.
 *
 * Citation chips, prompt buttons, rail rows, structure hits and inline structures are all rendered
 * deep inside markdown output or inside a portalled sheet, with no shared ancestor worth threading
 * a callback through. They hand their intent to the composer on a window event instead.
 *
 * That coupling already existed — `chemclaw:prefill` was dispatched inline from three different
 * files, each spelling the detail shape out by hand. This module is those spellings written once.
 * It is not an abstraction over one caller: `prefill` has three, and collecting them is what makes
 * the contract in `tests/prefillContract.test.tsx` a check on every producer rather than on one.
 *
 * ## Two events, because they are two different intents
 *
 * `chemclaw:prefill` **replaces** the draft — the chip and the prompt button are handing over a
 * whole question, and appending theirs to whatever was half-typed would produce a sentence nobody
 * wrote.
 *
 * `chemclaw:insert-structure` **inserts at the caret** and leaves the rest of the draft alone,
 * because a structure is almost never the whole question. "Screen this for hazards" is what the
 * chemist is actually writing, and a structure that replaced the draft would make them type it
 * twice. It is the same rule `Composer.insertStructure` was written under for the structure panel;
 * this event is how everything else in the app reaches it.
 */

export const PREFILL_EVENT = 'chemclaw:prefill';
export const INSERT_STRUCTURE_EVENT = 'chemclaw:insert-structure';

/** What rides on `chemclaw:prefill`. A bare string is the no-send form. */
export type PrefillDetail = string | { text: string; autoSend?: boolean };

/**
 * What rides on `chemclaw:insert-structure`.
 *
 * `smiles` is required to be **canonical** by every producer, because the composer promotes it
 * into the entity rail and a raw spelling there would be a second row for one compound. Every
 * producer today is handing back a string RDKit has already read — a rail key, a hit's structure,
 * an inline span the renderer confirmed — so this costs nobody a round trip.
 */
export interface InsertStructureDetail {
  smiles: string;
}

/** Fill the composer and focus it. The human presses Send. */
export function prefill(text: string): void {
  window.dispatchEvent(new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail: text }));
}

/** Fill the composer AND submit — one-tap approve/decline, and nothing else. */
export function prefillAndSend(text: string): void {
  window.dispatchEvent(
    new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail: { text, autoSend: true } }),
  );
}

/**
 * Put a structure into the message being written, at the caret.
 *
 * Never sends. Turning a drawing into a question is the chemist's job, and a structure that sent
 * itself would be a tool call composed by a click — the line this app draws deliberately and which
 * `docs/chemistry-aware-frontend.md` §9 leaves open.
 */
export function insertStructure(smiles: string): void {
  window.dispatchEvent(
    new CustomEvent<InsertStructureDetail>(INSERT_STRUCTURE_EVENT, { detail: { smiles } }),
  );
}
