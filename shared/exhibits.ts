/**
 * The artefact decoders for the service's exhibit REST bodies. "Exhibit" is the code name
 * (the service already uses "artifact" for calculation by-products); users only ever read
 * "Artefact".
 *
 * An exhibit is a typed, versioned working document in one session, shown beside the chat.
 * Revisions are append-only and authored (`author_kind`, parent, change note); a write names its
 * base revision and a stale one gets a 409 with the head.
 *
 * Values may be bound to a tool result (`{"$bind": {result, pointer}}`). A view carries `spec`
 * (resolved, what renderers draw) and `raw_spec` (stored, with bindings — the only base for a
 * write, so untouched bindings survive an edit). `bindings[]` reports each bound path's source and
 * status; `unverified_figures` lists literals no tool returned.
 *
 * Valibot schemas (types are `v.InferOutput`), tolerant per field (`v.fallback`) but strict per
 * spec: an unreadable spec becomes `null` and the view says so rather than drawing a half-coerced
 * document. Written here rather than generated because the contract types `spec` as `unknown`; the
 * fields each decoder reads are held against the contract in `tests/pinnedContract.test.ts`.
 */

import * as v from 'valibot';
import { text, textList } from './eventCoercion.ts';
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
 * Export formats per kind, served by `GET …/export.{fmt}` (the service 404s others). SDF and SVG
 * are made in the browser.
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

/*
 * ── field vocabulary ── Each a `v.fallback`, so a malformed field costs only that field. The
 * shapes shared with the events are `shared/eventCoercion.ts`'s.
 */

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

/*
 * ── bindings ── A bound value in a stored spec: the outer object is strict (exactly one `$bind`
 * key), the inner loose so fields added later survive an edit. `result` is the 64-hex `result_ref`;
 * `pointer` is an RFC 6901 JSON Pointer.
 */
export const BIND_KEY = '$bind';

const bindValue = v.strictObject({
  $bind: v.looseObject({ result: v.string(), pointer: v.string() }),
});
export type BindValue = v.InferOutput<typeof bindValue>;

/** Whether a stored value is a binding rather than a literal. */
export const isBind = (value: unknown): value is BindValue => v.is(bindValue, value);

/**
 * A whole table bound to one array in a tool result (one row per element, column pointers relative
 * to it). Exclusive with `rows`.
 */
const rowsFrom = v.looseObject({
  result: v.string(),
  pointer: v.string(),
  columns: v.record(v.string(), v.string()),
});
export type RowsFrom = v.InferOutput<typeof rowsFrom>;

/**
 * One bound path as the service resolved it. `ok: false` means the source result is gone (`spec`
 * holds `null` there, `error` says why). Rows without a boolean `ok` are dropped.
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

/*
 * ── the spec, one schema per kind ── Strict about the content field, defaulting what the service
 * defaults. The resolved schema admits `null` where an expired binding resolved; the raw schema
 * admits `$bind` values instead.
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
 * A resolved table: `rows_from` has become `rows`; an expired binding leaves `rows` null (no rows).
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
 * A calculation by-product a geometry is read from: which calculation and the file's role, i.e.
 * `<calc_key>#<name>` (`calcArtifactRef`).
 */
const geometrySource = v.object({
  calc_key: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
});

/**
 * One 3D structure: stored with exactly one of `xyz`, `source` or `structure_id`. Resolved, a
 * `structure_id` arrives as `xyz` (or with no `xyz` and a failed binding row if the structure is
 * gone; see `resolvedGeometry`). The XYZ text is parsed only by `parseXyz` in
 * `src/chem/geometry.ts`. `highlight_atoms` are 0-based; `energy_hartree` is a label.
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
 * Agent-written HTML, never rendered on this origin (`HtmlView` uses the sandbox frame or escaped
 * source). `height` is the starting frame height in CSS pixels.
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
 * A resolved geometry: the stored rule, or a `structure_id` with its resolved `xyz` or with nothing
 * if the structure vanished.
 */
const resolvedGeometry = (spec: { kind: string }): boolean => {
  if (oneGeometrySource(spec)) return true;
  const { source, structure_id } = spec as Record<string, unknown>;
  return structure_id !== undefined && source === undefined;
};

const GEOMETRY_RULE = 'a geometry takes exactly one of `xyz`, `source` or `structure_id`';

/**
 * The spec plus the geometry's one-structure rule, checked on the union because `v.variant` needs
 * plain object members.
 */
const checkedSpec = v.pipe(
  exhibitSpec,
  v.check((spec) => resolvedGeometry(spec), GEOMETRY_RULE),
);

/** The stored spec, with the geometry rule and the table's: `rows` or `rows_from`, never both. */
const checkedRawSpec = v.pipe(
  rawExhibitSpec,
  v.check((spec) => oneGeometrySource(spec), GEOMETRY_RULE),
  // The service sends a whole-table binding with an empty `rows` beside `rows_from`; accept that
  // shape.
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
 * The flat `<calc_key>#<name>` form of a calc artifact reference (`ArtifactRef.as_str()`), shared
 * by geometry sources, `list_artifacts` rows and the download route.
 */
export const calcArtifactRef = (source: GeometrySource): string =>
  `${source.calc_key}#${source.name}`;

/**
 * A spec, or `null` when this build cannot read it (there is no honest default). The revision log,
 * diff and export still work.
 */
const specOrNull = () => v.fallback(v.nullable(checkedSpec), null);
const rawSpecOrNull = () => v.fallback(v.nullable(checkedRawSpec), null);

/* ── the bodies ──────────────────────────────────────────────────────────── */

/** Drop malformed rows of a list body, keeping the rest. */
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
   * The stored spec with its bindings — the base of every write. Older services send only `spec`,
   * which is then used for both.
   */
  raw_spec: rawSpecOrNull(),
  /** Every bound path of this revision, with its tool and whether its source is still there. */
  bindings: rowsOf(binding),
  /**
   * Numerals in an agent revision that no tool in this session returned: "unchecked", not "wrong".
   * Empty until checked and for human revisions; strings as sent.
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
 * One change between two revisions, in `protocols.diff.FieldChange`'s shape so `RevisionDiff`
 * renders it. Values are stringified (non-strings as JSON; `null`/absent as `''`).
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

/** A binding as a diff shows it: what it points at, not its JSON. */
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
 * `GET /sessions/{id}/exhibits` — the session's artefacts, newest first. `enabled`
 * (`agent_exhibits_enabled`) decides whether the pane exists; absent reads as off.
 */
const exhibitListOut = v.object({
  enabled: v.fallback(v.boolean(), false),
  /**
   * Whether the agent may create `html` artefacts here (`agent_html_artefacts_enabled`); absent
   * reads as off. Existing ones still view.
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
 * A decoder that only fails on a body that is not an object (an HTML error page, `null`), which is
 * reported as an error rather than drawn as an empty artefact.
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
 * An artefact body. An older service sends only `spec`, which is then also the stored spec (nothing
 * could be bound).
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
 * Validate a spec this app is about to send, with the read schema, so this app's own bad edit fails
 * here with a clear message. The service remains the authority.
 */
export function isSpec(value: unknown): value is RawExhibitSpec {
  // The *stored* schema: what is sent is a raw spec, which may carry the bindings it kept.
  return v.safeParse(checkedRawSpec, value).success;
}
