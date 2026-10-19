/**
 * The artefact contract's constants without its valibot schemas, so the eager path (transcript
 * projection, pane store, composer, card chrome) does not pull the schemas into the first load.
 * `exhibits.ts` re-exports everything here. Keep this file dependency-free.
 */

/** `xb-` plus sixteen lowercase hex characters, minted at random by the service. */
export const EXHIBIT_ID_RE = /^xb-[0-9a-f]{16}$/;

/** The closed set of kinds. Order is the order the service's `CHECK` constraint lists them. */
export const EXHIBIT_KINDS = [
  'document',
  'table',
  'structures',
  'chart',
  'result',
  'link',
  'geometry',
  // Wave 3: agent-written HTML, drawn only inside the sandbox origin (`HtmlView`), never inline.
  'html',
] as const;
export type ExhibitKind = (typeof EXHIBIT_KINDS)[number];

/**
 * How many artefacts one message may hand back (`exhibit_refs`). Mirrors the service's fixed cap of
 * five so the composer refuses a sixth chip instead of the message failing 422.
 */
export const MAX_EXHIBIT_REFS = 5;

/** One artefact handed back to the agent with a message: `exhibit_refs` on the turn route. */
export interface ExhibitRef {
  exhibit_id: string;
  /** `0` is the head at the moment the turn runs; a number pins the revision the chemist saw. */
  revision: number;
}

/** The label a chemist reads for a kind. "Artefact" is the noun; this is the adjective. */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  document: 'Document',
  table: 'Table',
  structures: 'Structures',
  chart: 'Chart',
  result: 'Tool result',
  link: 'Link',
  geometry: '3D structure',
  html: 'HTML',
};

/**
 * A calculation by-product reference, `<calc_key>#<name>` (`ArtifactRef.as_str()` upstream), read
 * from a query string by the BFF whitelist (`server/routes.ts`) and checked client-side by
 * `api.getCalcArtifact`.
 *
 * The key is anything but whitespace and `#` (real keys contain `/`, e.g.
 * `xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:abc:def`); it travels as one encoded parameter and is
 * resolved by lookup. The name stays strict, never only dots, because it becomes the download
 * filename. Lengths bound the URL.
 */
export const CALC_ARTIFACT_REF = /^[^\s#]{1,512}#(?!\.+$)[A-Za-z0-9._+-]{1,128}$/;
