/**
 * The artefact contract's constants — what the *eager* path needs, without the schemas.
 *
 * Split out of `shared/exhibits.ts` for the first load. The transcript projection needs the id
 * pattern, the pane's store and the composer need the reference cap, and the card's chrome needs a
 * kind's label — and importing any of them from `exhibits.ts` pulled every valibot schema of the
 * contract into what a chemist downloads before the app paints, although nothing decodes an
 * artefact body until a pane, a card or a pin asks for one. `exhibits.ts` re-exports all of this,
 * so a module that already decodes bodies keeps one import.
 *
 * Dependency-free on purpose: no valibot here, and nothing that would bring it.
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
 * How many artefacts one message may hand back to the agent (`exhibit_refs`, phase 2).
 *
 * The service's cap, mirrored so the composer refuses a sixth chip instead of letting the whole
 * message come back 422 after it was typed. A fallback rather than a negotiated value, because the
 * contract fixes it at five and nothing on the wire publishes it.
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
 * A calculation by-product's reference, `<calc_key>#<name>` — `ArtifactRef.as_str()` upstream.
 *
 * The one id the BFF whitelist reads out of a **query string** (`GET /calc-artifacts/content
 * ?ref=…`, `server/routes.ts`), because its `#` cannot be a path segment. Here rather than there
 * so the client holds a ref to the same rule before it asks (`api.getCalcArtifact`), and says
 * "not a calculation file" instead of reporting a refused ref as an evicted one.
 *
 * **The key is anything but whitespace and `#`.** The first version allowed the alphabet a key
 * *looked* written in, and refused every real one: the calc server's engine version is
 * `tblite-{v}/rdkit-{v}/scipy-{v}/{rev}`, so a stored key reads like
 * `xtb_opt@gfn2+xtb+xtb-6.7.1/tblite-0.4.0:abc:def` — slashes included (the frozen contract's
 * wave-2 amendment). The key travels encoded inside one query parameter and the service resolves
 * it by lookup, so a `/` in it reaches no path. The **name** stays strict — a producer's filename
 * (`xtbopt.xyz`, `hessian`), never only dots — because it becomes the download's filename. The
 * lengths bound the URL, not the service's fields.
 */
export const CALC_ARTIFACT_REF = /^[^\s#]{1,512}#(?!\.+$)[A-Za-z0-9._+-]{1,128}$/;
