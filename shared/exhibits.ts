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
 * **A value is either transcribed or bound (wave 3).** Phase 0 measured the binding design out, and
 * the owner reversed that on 2026-10-03: a table cell, a structure's SMILES or property, and a chart
 * series may now be `{"$bind": {result, pointer}}` — a value taken verbatim from a tool result the
 * session holds. So an `ExhibitView` carries two specs. `spec` is **resolved** (every binding
 * replaced by its value), and every renderer draws it unchanged; `raw_spec` is what is **stored**,
 * bindings and all, and it is the only spec a write starts from — a human edit that rebuilt its
 * body from `spec` would silently turn every binding it did not touch into a literal. `bindings[]`
 * says, per bound path, which tool it came from and whether its source is still there. A literal
 * is still a number the model *wrote*, which is why `unverified_figures` exists and why
 * `ChartView` captions the series nothing links to a tool result.
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
  // The source, as an attachment the service types `text/plain` — never `text/html` on any origin
  // that holds a token. Opening it in a browser is the reader's own decision, outside this app.
  html: ['html'],
};

/** Every server-side export format. The BFF whitelist's `FMT` pattern is this list. */
export const EXPORT_FORMAT_LIST = ['md', 'csv', 'smi', 'xyz', 'html'] as const;
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

/* ── bindings (wave 3) ──────────────────────────────────────────────────────
 *
 * A bound value in a *stored* spec. The outer object is strict — it is a binding exactly when its
 * one key is `$bind`, so a cell can never be misread as one — and the inner one is loose, because a
 * write keeps an untouched binding **verbatim**: a field the service adds inside `$bind` later must
 * survive a chemist's edit of a different cell rather than being stripped on the way back.
 *
 * `result` is the full 64-hex `result_ref` once stored (the agent writes the `r:<12 hex>` handle,
 * and the service substitutes it); `pointer` is an RFC 6901 JSON Pointer into that result.
 */
export const BIND_KEY = '$bind';

const bindValue = v.strictObject({
  $bind: v.looseObject({ result: v.string(), pointer: v.string() }),
});
export type BindValue = v.InferOutput<typeof bindValue>;

/** Whether a stored value is a binding rather than a literal. */
export const isBind = (value: unknown): value is BindValue => v.is(bindValue, value);

/**
 * A whole table bound to one array in a tool result: each element is a row, each column a pointer
 * relative to the element. Mutually exclusive with `rows`. Loose for the reason `bindValue` is.
 */
const rowsFrom = v.looseObject({
  result: v.string(),
  pointer: v.string(),
  columns: v.record(v.string(), v.string()),
});
export type RowsFrom = v.InferOutput<typeof rowsFrom>;

/**
 * One bound path of a revision, as the service resolved it.
 *
 * `path` is the spec path (`rows[3].yield`, `items[0].props.mw`, `series[1].y`, `rows_from`).
 * `ok: false` is a binding whose result blob is gone (retention): the resolved `spec` then holds
 * `null` there, and `error` is the service's reason. A row without a boolean `ok` is dropped rather
 * than guessed at — the provenance marker still draws from `raw_spec`, without a status it would
 * have had to invent.
 */
const binding = v.object({
  path: v.string(),
  result_ref: text(),
  tool: text(),
  pointer: text(),
  ok: v.boolean(),
  error: text(),
});
export type Binding = v.InferOutput<typeof binding>;

/* ── the spec, one schema per kind ──────────────────────────────────────────
 *
 * Each is strict about the field that *is* the content and defaults what the service defaults, so
 * a spec the service accepted parses here, and one it could not have accepted does not.
 *
 * **Two readings of the three kinds that can bind.** The *resolved* schema is what the views draw:
 * literals only, except that a binding whose source is gone resolved to `null` — so a bindable
 * position also admits `null` there (a series' `x`/`y` reads as no points, a SMILES as empty) rather
 * than costing the whole spec over one expired result. The *raw* schema is what is stored and what a
 * write sends: a bindable position admits a `$bind` value instead, and never `null` where the
 * service would refuse one.
 */

/** A table cell: the service's `str | number | null`, nothing else. */
const cell = v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]);
const finite = () => v.pipe(v.number(), v.finite());
/** A resolved array a gone binding left `null`: no values, which the provenance marker explains. */
const resolvedArray = <T extends v.GenericSchema>(item: T) =>
  v.pipe(
    v.nullable(v.array(item)),
    v.transform((items) => items ?? []),
  );

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

/**
 * A resolved table. A `rows_from` binding has become `rows` — the service resolves it — and an
 * expired one leaves `rows` null, read as no rows.
 */
const tableSpec = v.object({
  kind: v.literal('table'),
  columns: v.pipe(v.array(tableColumn), v.minLength(1)),
  rows: v.optional(resolvedArray(v.record(v.string(), cell)), []),
});

/** A stored table: cells may be bound, or the whole body may be one `rows_from` binding. */
const rawTableSpec = v.object({
  kind: v.literal('table'),
  columns: v.pipe(v.array(tableColumn), v.minLength(1)),
  rows: v.optional(v.array(v.record(v.string(), v.union([cell, bindValue])))),
  rows_from: v.optional(rowsFrom),
});

const structureItem = v.object({
  smiles: v.pipe(
    v.nullable(v.string()),
    v.transform((smiles) => smiles ?? ''),
  ),
  label: v.optional(v.string(), ''),
  props: v.optional(v.record(v.string(), v.union([v.string(), finite(), v.null()])), {}),
});

const rawStructureItem = v.object({
  smiles: v.union([v.string(), bindValue]),
  label: v.optional(v.string(), ''),
  props: v.optional(v.record(v.string(), v.union([v.string(), finite(), bindValue])), {}),
});

const structuresSpec = v.object({
  kind: v.literal('structures'),
  items: v.pipe(v.array(structureItem), v.minLength(1)),
});

const rawStructuresSpec = v.object({
  kind: v.literal('structures'),
  items: v.pipe(v.array(rawStructureItem), v.minLength(1)),
});

/** Numbers, or category names for a `bar` chart — the only kind the service lets them be. */
const chartX = v.union([finite(), v.string()]);

const chartSeries = v.object({
  name: v.string(),
  x: resolvedArray(chartX),
  y: resolvedArray(finite()),
});

/** A stored series: `x` and `y` are each a literal array or one binding to an array. */
const rawChartSeries = v.object({
  name: v.string(),
  x: v.union([v.array(chartX), bindValue]),
  y: v.union([v.array(finite()), bindValue]),
});

const chartEntries = {
  kind: v.literal('chart'),
  chart: v.picklist(['line', 'scatter', 'bar']),
  /** The axis label *with its unit*, as the agent wrote it. Nothing here invents one. */
  x_label: v.string(),
  y_label: v.string(),
};

const chartSpec = v.object({ ...chartEntries, series: v.array(chartSeries) });
const rawChartSpec = v.object({ ...chartEntries, series: v.array(rawChartSeries) });

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
 * One 3D structure (wave 2): an inline XYZ block, a stored calculation artifact it cites, or — the
 * contract's hardening item 1, and what the agent actually holds — a `structure_id` in the service's
 * structure store.
 *
 * **Stored, exactly one of `xyz`, `source` and `structure_id`** — checked here too, because a spec
 * carrying two would leave the viewer choosing which structure is "the" artefact, and one carrying
 * none is not a structure at all. The service omits whichever is absent rather than sending `null`,
 * so all three are plain optionals.
 *
 * **Resolved, a `structure_id` arrives as `xyz`.** The service reads the structure at read time and
 * puts its XYZ text in the view's `spec` (the stored `raw_spec` keeps the id), so the views draw the
 * same field whichever way the geometry was written. A structure that has since vanished resolves to
 * *no* `xyz`, with a `bindings[]` row (`tool: "structure"`, `ok: false`) the pane's strip reads —
 * so the resolved reading also admits a `structure_id` with or without `xyz` (`resolvedGeometry`).
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
  /** A structure in the service's structure store (hardening item 1); see above. */
  structure_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  label: v.optional(v.string(), ''),
  energy_hartree: v.optional(v.pipe(v.number(), v.finite())),
  highlight_atoms: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(0))), []),
});

/**
 * Agent-written HTML (wave 3). **Never rendered on this origin**: `HtmlView` hands it to the sandbox
 * origin's frame, or shows it as escaped source when there is none. `height` is the frame's starting
 * height in CSS pixels, before the frame reports its own.
 */
const htmlSpec = v.object({
  kind: v.literal('html'),
  html: v.string(),
  // At least 1, as the service's model says (`ge=1`): a zero-height frame is a page nobody sees.
  height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 480),
});

const exhibitSpec = v.variant('kind', [
  documentSpec,
  tableSpec,
  structuresSpec,
  chartSpec,
  resultSpec,
  linkSpec,
  geometrySpec,
  htmlSpec,
]);

const rawExhibitSpec = v.variant('kind', [
  documentSpec,
  rawTableSpec,
  rawStructuresSpec,
  rawChartSpec,
  resultSpec,
  linkSpec,
  geometrySpec,
  htmlSpec,
]);

/** A stored geometry carries exactly one of `xyz`, `source` and `structure_id`. */
const oneGeometrySource = (spec: { kind: string }): boolean => {
  if (spec.kind !== 'geometry') return true;
  const { xyz, source, structure_id } = spec as Record<string, unknown>;
  return [xyz, source, structure_id].filter((field) => field !== undefined).length === 1;
};

/**
 * A *resolved* geometry: the stored rule, or a `structure_id` beside the `xyz` it resolved to — or
 * beside nothing, when the structure has vanished, which the view says rather than refusing the
 * whole spec over (the binding row carries the reason).
 */
const resolvedGeometry = (spec: { kind: string }): boolean => {
  if (oneGeometrySource(spec)) return true;
  const { source, structure_id } = spec as Record<string, unknown>;
  return structure_id !== undefined && source === undefined;
};

const GEOMETRY_RULE = 'a geometry takes exactly one of `xyz`, `source` or `structure_id`';

/**
 * The spec, with the one rule a member cannot state about itself: a geometry's one structure. On the
 * union rather than on `geometrySpec` because `v.variant` dispatches only on plain object members,
 * and a check there would make the member something it cannot take.
 */
const checkedSpec = v.pipe(
  exhibitSpec,
  v.check((spec) => resolvedGeometry(spec), GEOMETRY_RULE),
);

/** The stored spec, with the geometry rule and the table's: `rows` or `rows_from`, never both. */
const checkedRawSpec = v.pipe(
  rawExhibitSpec,
  v.check((spec) => oneGeometrySource(spec), GEOMETRY_RULE),
  // The service sends a whole-table binding as `{"rows": [], "rows_from": {...}}` — `rows` is a
  // defaulted field of its model — so an *empty* `rows` beside `rows_from` is the wire shape, and
  // refusing it read every such table's raw_spec as null: no marker, no Detach, no edit.
  v.check(
    (spec) => spec.kind !== 'table' || !spec.rows?.length || spec.rows_from === undefined,
    'a table takes `rows` or `rows_from`, not both',
  ),
);

export type ExhibitSpec = v.InferOutput<typeof checkedSpec>;
/** The stored spec, bindings and all — what `raw_spec` holds and what every write sends. */
export type RawExhibitSpec = v.InferOutput<typeof checkedRawSpec>;
export type DocumentSpec = v.InferOutput<typeof documentSpec>;
export type TableSpec = v.InferOutput<typeof tableSpec>;
export type RawTableSpec = v.InferOutput<typeof rawTableSpec>;
export type TableColumn = v.InferOutput<typeof tableColumn>;
export type TableCell = v.InferOutput<typeof cell>;
export type StructuresSpec = v.InferOutput<typeof structuresSpec>;
export type RawStructuresSpec = v.InferOutput<typeof rawStructuresSpec>;
export type StructureItem = v.InferOutput<typeof structureItem>;
export type ChartSpec = v.InferOutput<typeof chartSpec>;
export type RawChartSpec = v.InferOutput<typeof rawChartSpec>;
export type ChartSeries = v.InferOutput<typeof chartSeries>;
export type ResultSpec = v.InferOutput<typeof resultSpec>;
export type LinkSpec = v.InferOutput<typeof linkSpec>;
export type GeometrySpec = v.InferOutput<typeof geometrySpec>;
export type GeometrySource = v.InferOutput<typeof geometrySource>;
export type HtmlSpec = v.InferOutput<typeof htmlSpec>;

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
const rawSpecOrNull = () => v.fallback(v.nullable(checkedRawSpec), null);

/* ── the bodies ──────────────────────────────────────────────────────────── */

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
  /** The **resolved** spec: every binding replaced by its value. What every view draws. */
  spec: specOrNull(),
  /**
   * The **stored** spec, with its bindings (wave 3) — the base of every write, so an edit keeps the
   * bindings it did not touch. A service that predates the field sends none, and the decoder reads
   * `spec` in its place, which is exact there: nothing could be bound.
   */
  raw_spec: rawSpecOrNull(),
  /** Every bound path of this revision, with its tool and whether its source is still there. */
  bindings: rowsOf(binding),
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
            : isBind(value)
              ? boundLabel(value)
              : JSON.stringify(value),
      ),
    ),
    '',
  );

/**
 * A binding as a diff shows it: what it points at, not its JSON. The service diffs the *stored*
 * spec, so "detached" reads as `linked to r:… /0/yield` → `82`, which is the fact a reviewer needs.
 */
export function boundLabel(value: BindValue): string {
  const { result, pointer } = value.$bind;
  const short = result.startsWith('r:') ? result : `r:${result.slice(0, 12)}`;
  return `linked to ${short} ${pointer || '/'}`;
}

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
 * `GET /sessions/{id}/exhibits` — every artefact of one session, newest activity first.
 *
 * `enabled` is the deployment's `agent_exhibits_enabled`, and it is the whole of what decides
 * whether the pane exists: off, and the right column is the entity rail exactly as it was, with no
 * empty "Artefacts" tab promising a feature this deployment turned off. Absent reads as **off**,
 * which is the reading that cannot put a dead tab on screen.
 */
const exhibitListOut = v.object({
  enabled: v.fallback(v.boolean(), false),
  /**
   * Whether the agent may create `html` artefacts here (`agent_html_artefacts_enabled`, wave 3).
   * Read only as a fact about the deployment: a person has no way to create one anyway, and an
   * existing one still views when this is off. Absent reads as off.
   */
  html_enabled: v.fallback(v.boolean(), false),
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
const decodeView = decoder(exhibitView, 'an artefact');

/**
 * An artefact body. A service that predates `raw_spec` sends `spec` alone, and that spec *is* the
 * stored one — nothing in it can be bound — so it is read as both rather than leaving every write
 * without a base.
 */
export const decodeExhibitView = (raw: unknown): ExhibitView =>
  decodeView(
    raw !== null && typeof raw === 'object' && !('raw_spec' in raw)
      ? { ...raw, raw_spec: (raw as { spec?: unknown }).spec }
      : raw,
  );
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
export function isSpec(value: unknown): value is RawExhibitSpec {
  // The *stored* schema: what is sent is a raw spec, which may carry the bindings it kept.
  return v.safeParse(checkedRawSpec, value).success;
}
