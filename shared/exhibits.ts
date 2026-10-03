/**
 * The artefact contract — a mirror of the service's exhibit REST bodies.
 *
 * **"Exhibit" is the code name and "Artefact" is the only word a chemist reads.** The service owns
 * the name: in its tree `artifact` already means a calculation's by-product (`ArtifactRef`,
 * `artifact_blobs`, the `calc` bundle's `list_artifacts`), and a second meaning would collide in
 * tool names the model reads and module names reviewers read. So every identifier here says
 * `exhibit`, and every string a person sees says "Artefact(s)" — the split the shared contract
 * (`artefacts-contract.md`, frozen across both repositories) states in its first line.
 *
 * ## What an exhibit is, and what that decides here
 *
 * A typed, versioned working document that belongs to one session and is displayed beside the
 * chat: a report draft, a table, a structure panel, a chart, a pinned tool result or a link to a
 * protocol/note/job. The agent writes one as *part of its answer*; the chemist opens, edits,
 * exports and hands it back. Two properties of that contract decide how this mirror is built:
 *
 * **Revisions are append-only and authored.** Every revision carries `author_kind` (`agent` or
 * `human`), its parent, and a change note — the same apparatus `shared/protocols.ts` carries for
 * the same reason: a chemist's correction is the most informative thing the system observes, and a
 * surface that drew an agent's figure and a person's figure the same would erase it. A write names
 * the revision it was based on, and the service answers 409 with the head when that is stale.
 *
 * **The spec holds literal values that the agent transcribed.** Phase 0 measured the binding
 * design out (tables are 2.7% of what answers spend), so a table cell or a chart point is a number
 * the model *wrote*, not one bound to a tool result. That is why `unverified_figures` exists and
 * why `ChartView` captions an agent-authored chart: the UI is the place that has to say it.
 *
 * ## Why valibot here, when `shared/protocols.ts` is hand-written interfaces
 *
 * `shared/events.ts` records what a hand-written mirror costs: nine members and fields deleted in
 * transit because the decoder and the declaration were different objects. These bodies are the
 * same kind of thing — another repository's shape, read by a surface that renders whatever it is
 * handed — and the spec is a seven-member discriminated union whose members a renderer switches on.
 * A schema whose `InferOutput` *is* the type makes "a field the type has and the decoder drops"
 * unrepresentable, exactly as it did there, and it lets an unreadable spec be a value the view can
 * say something honest about instead of a `TypeError` three components down.
 *
 * **Tolerant per field, strict per spec.** A header field that is the wrong type costs that field
 * (`v.fallback`), because a list of artefacts must not vanish over one malformed timestamp. A
 * *spec* that does not parse is not patched up field by field: it becomes `null`, and the view
 * says "this build cannot read this artefact's content" — a half-coerced table with invented
 * empty cells would be a document nobody wrote, which is worse than no document.
 *
 * Imported by the SPA (bundled by Vite) and by the e2e fixture service (Node type stripping), like
 * its two siblings; `valibot` is the one dependency `shared/` takes, see `docs/dependencies.md`.
 */

import * as v from 'valibot';
import type { ExhibitKind } from './exhibitConstants.ts';

export {
  EXHIBIT_ID_RE,
  EXHIBIT_KINDS,
  KIND_LABEL,
  MAX_EXHIBIT_REFS,
  type ExhibitKind,
  type ExhibitRef,
} from './exhibitConstants.ts';

/** Who wrote a revision. A closed set of two upstream and here. */
export const AUTHOR_KINDS = ['agent', 'human'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/**
 * What each kind can be downloaded as from the service — `GET …/export.{fmt}`.
 *
 * Transcribed from the contract's table, which is also what the service 404s outside of: asking a
 * chart for `.smi` is a request with no answer, so the menu never offers it. SDF and SVG are not
 * here because they are made in this browser (RDKit's molblock, the chart's own DOM) rather than
 * fetched — see `ExhibitPane`'s export menu.
 */
export const EXPORT_FORMATS: Readonly<Record<ExhibitKind, readonly ExportFormat[]>> = {
  document: ['md'],
  table: ['csv', 'md'],
  structures: ['smi', 'csv'],
  chart: ['csv'],
  result: [],
  link: [],
  // The inline block, or the bytes the `source` names, resolved by the service — so the file is the
  // same one whether the agent pasted the coordinates or cited the calculation that produced them.
  geometry: ['xyz'],
};

/** Every server-side export format. The BFF whitelist's `FMT` pattern is this list. */
export const EXPORT_FORMAT_LIST = ['md', 'csv', 'smi', 'xyz'] as const;
export type ExportFormat = (typeof EXPORT_FORMAT_LIST)[number];

/* ── field vocabulary ────────────────────────────────────────────────────────
 *
 * The same idiom `shared/events.ts` uses — each a `v.fallback` so a malformed field costs that
 * field and never the body around it. Re-declared rather than imported because that module keeps
 * its helpers private on purpose: they are the event decoder's, and a second module depending on
 * their exact fallbacks would couple two contracts that move independently.
 */

const text = (fallback = '') => v.fallback(v.string(), fallback);

/** A revision number: a whole number of at least zero. `0` is what the service means by "none"
 *  (`parent_revision` of a first revision) and is the honest reading of a malformed one. */
const revision = () =>
  v.fallback(
    v.pipe(
      v.number(),
      v.check((n: number) => Number.isSafeInteger(n) && n >= 0),
    ),
    0,
  );

const authorKind = () => v.fallback(v.picklist(AUTHOR_KINDS), 'agent' as AuthorKind);

const textList = () =>
  v.fallback(
    v.pipe(
      v.array(v.unknown()),
      v.transform((entries) => entries.map(String)),
    ),
    [] as string[],
  );

/* ── the spec, one schema per kind ──────────────────────────────────────────
 *
 * Literal values only (no bindings — superseded in phase 0). Each is strict about the field that
 * *is* the content and defaults what the service defaults, so a spec the service accepted parses
 * here, and one it could not have accepted does not.
 */

/** A table cell: the service's `str | number | null`, nothing else. */
const cell = v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]);

const documentSpec = v.object({
  kind: v.literal('document'),
  /** Rendered through `Markdown`, which forbids raw HTML — the reason the declined interactive
   *  kind is not needed for a report draft. */
  markdown: v.string(),
});

const tableColumn = v.object({
  key: v.string(),
  label: v.string(),
  /** Shown in the column header. Empty means the column has no unit, never "unknown unit". */
  unit: v.optional(v.string(), ''),
});

const tableSpec = v.object({
  kind: v.literal('table'),
  columns: v.pipe(v.array(tableColumn), v.minLength(1)),
  rows: v.optional(v.array(v.record(v.string(), cell)), []),
});

const structureItem = v.object({
  smiles: v.string(),
  label: v.optional(v.string(), ''),
  props: v.optional(
    v.record(v.string(), v.union([v.string(), v.pipe(v.number(), v.finite())])),
    {},
  ),
});

const structuresSpec = v.object({
  kind: v.literal('structures'),
  items: v.pipe(v.array(structureItem), v.minLength(1)),
});

const chartSeries = v.object({
  name: v.string(),
  /** Numbers, or category names for a `bar` chart — the only kind the service lets them be. */
  x: v.array(v.union([v.pipe(v.number(), v.finite()), v.string()])),
  y: v.array(v.pipe(v.number(), v.finite())),
});

const chartSpec = v.object({
  kind: v.literal('chart'),
  chart: v.picklist(['line', 'scatter', 'bar']),
  /** The axis label *with its unit*, as the agent wrote it. Nothing here invents one. */
  x_label: v.string(),
  y_label: v.string(),
  series: v.array(chartSeries),
});

const resultSpec = v.object({
  kind: v.literal('result'),
  /** The content address in the session's tool-result store — the same ref a result block holds. */
  result_ref: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  tool: v.optional(v.string(), ''),
});

const linkSpec = v.object({
  kind: v.literal('link'),
  target: v.picklist(['protocol', 'note', 'job']),
  id: v.string(),
});

/**
 * A calculation by-product a geometry is read from — the calc artifact store's `ArtifactRef` key.
 *
 * Two fields, because those are what address a stored artifact: which calculation, and the file's
 * role in it. Together they are the `<calc_key>#<name>` string `fetch_artifact` and a note's
 * `artifact_refs` already spell (`calcArtifactRef`), which is what `GET /calc-artifacts/content`
 * takes.
 */
const geometrySource = v.object({
  calc_key: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
});

/**
 * One 3D structure (wave 2): an inline XYZ block, or a stored calculation artifact it cites.
 *
 * **Exactly one of `xyz` and `source`**, as the service holds it — checked here too, because a spec
 * carrying both would leave the viewer choosing which structure is "the" artefact, and one carrying
 * neither is not a structure at all. The service omits whichever is absent rather than sending
 * `null`, so both are plain optionals.
 *
 * The block itself is *not* parsed here. The service validated it on write (count line, known
 * elements, finite coordinates, at most `exhibit_max_atoms`); this schema's job is the shape, and
 * `src/chem/geometry.ts`'s `parseXyz` is the one reader of the text — so a `source`'s bytes, which nothing validated
 * on the way out of the calc store, go through the same parser and the same refusals.
 *
 * `highlight_atoms` are **0-based** indices into the atom lines (the service's own docstring), and
 * `energy_hartree` is a label to show, not a figure anything here computes — the same posture the
 * chart's caption takes about agent-transcribed values.
 */
const geometrySpec = v.object({
  kind: v.literal('geometry'),
  format: v.optional(v.literal('xyz'), 'xyz'),
  xyz: v.optional(v.string()),
  source: v.optional(geometrySource),
  label: v.optional(v.string(), ''),
  energy_hartree: v.optional(v.pipe(v.number(), v.finite())),
  highlight_atoms: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(0))), []),
});

const exhibitSpec = v.variant('kind', [
  documentSpec,
  tableSpec,
  structuresSpec,
  chartSpec,
  resultSpec,
  linkSpec,
  geometrySpec,
]);

/**
 * The spec, with the one rule a member cannot state about itself: a geometry carries exactly one of
 * `xyz` and `source`. On the union rather than on `geometrySpec` because `v.variant` dispatches only
 * on plain object members, and a check there would make the member something it cannot take.
 */
const checkedSpec = v.pipe(
  exhibitSpec,
  v.check(
    (spec) => spec.kind !== 'geometry' || (spec.xyz === undefined) !== (spec.source === undefined),
    'a geometry takes exactly one of `xyz` or `source`',
  ),
);

export type ExhibitSpec = v.InferOutput<typeof checkedSpec>;
export type DocumentSpec = v.InferOutput<typeof documentSpec>;
export type TableSpec = v.InferOutput<typeof tableSpec>;
export type TableColumn = v.InferOutput<typeof tableColumn>;
export type TableCell = v.InferOutput<typeof cell>;
export type StructuresSpec = v.InferOutput<typeof structuresSpec>;
export type StructureItem = v.InferOutput<typeof structureItem>;
export type ChartSpec = v.InferOutput<typeof chartSpec>;
export type ChartSeries = v.InferOutput<typeof chartSeries>;
export type ResultSpec = v.InferOutput<typeof resultSpec>;
export type LinkSpec = v.InferOutput<typeof linkSpec>;
export type GeometrySpec = v.InferOutput<typeof geometrySpec>;
export type GeometrySource = v.InferOutput<typeof geometrySource>;

/**
 * The flat `<calc_key>#<name>` form of a calc artifact reference — `ArtifactRef.as_str()` upstream.
 *
 * Written once because three things spell it and must agree: a geometry's `source`, the
 * `artifact_ref` a `list_artifacts` row carries, and the query parameter the download route takes.
 */
export const calcArtifactRef = (source: GeometrySource): string =>
  `${source.calc_key}#${source.name}`;

/**
 * A spec, or `null` when this build cannot read it.
 *
 * Not `v.fallback` to a default spec: there is no honest default content. The view renders the
 * null as a sentence, and the revision log, the diff and the export — none of which need the
 * spec's shape — keep working.
 */
const specOrNull = () => v.fallback(v.nullable(checkedSpec), null);

/* ── the bodies ──────────────────────────────────────────────────────────── */

const headerEntries = {
  exhibit_id: text(),
  session_id: text(),
  /** Open rather than narrowed: a kind this build does not know must still list, with its title,
   *  so a chemist can see it exists. The views switch on the *spec*, which is narrowed. */
  kind: text(),
  title: text(),
  head_revision: revision(),
  /** Who wrote the head — what the card's "edited by you / by <name>" reads. */
  head_author_kind: authorKind(),
  head_author: text(),
  created_by: text(),
  created_at: text(),
  updated_at: text(),
};

const exhibitHeader = v.object(headerEntries);
export type ExhibitHeader = v.InferOutput<typeof exhibitHeader>;

const exhibitView = v.object({
  ...headerEntries,
  /** The revision this body is — the head unless one was asked for with `?revision=N`. */
  revision: revision(),
  parent_revision: revision(),
  author_kind: authorKind(),
  author: text(),
  change_note: text(),
  revision_created_at: text(),
  spec: specOrNull(),
  /**
   * Numerals in an agent-authored revision that no tool in this session returned (phase 2).
   *
   * "Unchecked", not "wrong": the service found no tool output carrying the figure, which is what a
   * transcription error looks like and also what a figure the agent derived looks like. `[]` until
   * the check runs, and for every human revision. Strings, as the service sends them, so a figure
   * keeps the spelling the reader will search the document for.
   */
  unverified_figures: textList(),
});
export type ExhibitView = v.InferOutput<typeof exhibitView>;

const exhibitRevision = v.object({
  revision: revision(),
  parent_revision: revision(),
  author_kind: authorKind(),
  author: text(),
  change_note: text(),
  created_at: text(),
  byte_size: revision(),
});
export type ExhibitRevision = v.InferOutput<typeof exhibitRevision>;

/**
 * One change between two revisions — **the shape of `protocols.diff.FieldChange`** on purpose, so
 * `RevisionDiff` renders an artefact diff with no second component.
 *
 * `before`/`after` are stringified here because `RevisionDiff` renders text and the contract leaves
 * their type open (a document hunk is text, a table cell may be a number). A non-string is shown as
 * its JSON, which is what the service would have meant by it; `null` and absent are `''`, which
 * `RevisionDiff` already draws as an explicit absence agreeing with the kind badge.
 */
const shownValue = () =>
  v.fallback(
    v.pipe(
      v.unknown(),
      v.transform((value) =>
        value === null || value === undefined
          ? ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(value),
      ),
    ),
    '',
  );

const exhibitChange = v.object({
  path: text('spec'),
  kind: v.fallback(v.picklist(['added', 'removed', 'changed']), 'changed' as const),
  before: shownValue(),
  after: shownValue(),
});

const exhibitDiff = v.object({
  from_revision: revision(),
  to_revision: revision(),
  changes: v.fallback(v.array(exhibitChange), []),
});
export type ExhibitDiff = v.InferOutput<typeof exhibitDiff>;

/**
 * Drop the rows of a list that are not one of its members, keeping the rest.
 *
 * A list body is the one place a per-row failure must not cost the list: twenty artefacts with one
 * malformed header is nineteen artefacts and a log line, not an empty pane.
 */
const rowsOf = <T extends v.GenericSchema>(row: T) =>
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

/**
 * `GET /sessions/{id}/exhibits` — every artefact of one session, newest activity first.
 *
 * `enabled` is the deployment's `agent_exhibits_enabled`, and it is the whole of what decides
 * whether the pane exists: off, and the right column is the entity rail exactly as it was, with no
 * empty "Artefacts" tab promising a feature this deployment turned off. Absent reads as **off**,
 * which is the reading that cannot put a dead tab on screen.
 */
const exhibitListOut = v.object({
  enabled: v.fallback(v.boolean(), false),
  exhibits: rowsOf(exhibitHeader),
});
export type ExhibitListOut = v.InferOutput<typeof exhibitListOut>;

/** `GET …/revisions` — every revision, ascending. */
const exhibitRevisionsOut = v.object({ revisions: rowsOf(exhibitRevision) });
export type ExhibitRevisionsOut = v.InferOutput<typeof exhibitRevisionsOut>;

/** `GET /exhibits` (phase 3) — the caller's artefacts across every session they can open. */
const exhibitIndexOut = v.object({ exhibits: rowsOf(exhibitHeader) });
export type ExhibitIndexOut = v.InferOutput<typeof exhibitIndexOut>;

/**
 * A decoder that cannot throw on a body that is an object, and says so when it is not one.
 *
 * Every field has a fallback, so the only way `v.safeParse` fails here is a body that is not an
 * object at all — a proxy's HTML error page, a `null`. That is a fault worth an error rather than
 * an empty artefact, because an empty body the service never sent would be rendered as a document
 * with nothing in it.
 */
function decoder<T extends v.GenericSchema>(schema: T, what: string) {
  return (raw: unknown): v.InferOutput<T> => {
    const parsed = v.safeParse(schema, raw);
    if (!parsed.success) throw new Error(`The service sent ${what} this app cannot read.`);
    return parsed.output;
  };
}

export const decodeExhibitList = decoder(exhibitListOut, 'an artefact list');
export const decodeExhibitView = decoder(exhibitView, 'an artefact');
export const decodeExhibitRevisions = decoder(exhibitRevisionsOut, 'an artefact history');
export const decodeExhibitDiff = decoder(exhibitDiff, 'an artefact comparison');
export const decodeMyExhibits = decoder(exhibitIndexOut, 'an artefact list');

/**
 * Validate a spec this app is about to *send*, with the same schema it reads with.
 *
 * The service is the authority (pydantic, `extra="forbid"`, a 422 with its own sentence), and this
 * does not replace it. What it buys is that an edit this app built wrongly — a table cell that
 * became `NaN`, a column whose key went missing — fails here with a sentence about *this* app's
 * fault rather than reaching the service as a revision the chemist is told was refused.
 */
export function isSpec(value: unknown): value is ExhibitSpec {
  return v.safeParse(checkedSpec, value).success;
}
