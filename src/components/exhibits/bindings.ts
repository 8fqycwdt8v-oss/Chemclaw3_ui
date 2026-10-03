/**
 * Bound values (wave 3): where a stored spec is bound, what that binding says, and how to detach it.
 *
 * ## Read from `raw_spec`, enriched from `bindings[]`
 *
 * The stored spec is what decides *whether* a position is bound — a `$bind` value sits exactly
 * there, so no path string has to be parsed back into a position. `bindings[]` then supplies what
 * the stored value cannot: the tool that produced the result, and whether the result is still there.
 * It is matched by the service's path first (`rows[3].yield`) and, failing that, by the same result
 * and pointer — so a path spelled differently from this guess still finds its tool, and a binding
 * the list omits still draws a marker, with no status rather than an invented one.
 *
 * ## Detach is a literal copy of what is on screen
 *
 * Detaching replaces the binding in the *stored* spec with the *resolved* value at the same
 * position — the number the chemist is looking at — and leaves every other binding verbatim. After
 * it the value is ordinary content: editable, and no longer claimed by a tool. A binding whose
 * source is gone resolved to `null`, which is a legal literal only in a table cell; anywhere else
 * there is nothing to keep, so it is not offered (`canDetach`).
 */

import {
  isBind,
  type Binding,
  type BindValue,
  type ExhibitSpec,
  type ExhibitView,
  type RawExhibitSpec,
} from '../../../shared/exhibits.ts';

/** A bindable position in a spec. */
export type BoundTarget =
  | { at: 'cell'; row: number; key: string }
  | { at: 'rows_from' }
  | { at: 'smiles'; item: number }
  | { at: 'prop'; item: number; name: string }
  | { at: 'series'; series: number; axis: 'x' | 'y' };

/** A position's path, spelled as the contract's diff spells paths (`rows[3].yield`). */
export function pathOf(target: BoundTarget): string {
  switch (target.at) {
    case 'cell':
      return `rows[${target.row}].${target.key}`;
    case 'rows_from':
      return 'rows_from';
    case 'smiles':
      return `items[${target.item}].smiles`;
    case 'prop':
      return `items[${target.item}].props.${target.name}`;
    case 'series':
      return `series[${target.series}].${target.axis}`;
  }
}

/** What one bound position says about itself: everything the marker shows. */
export interface Provenance {
  path: string;
  /** The full result ref as stored, or the `r:` handle when that is all the stored value holds. */
  result: string;
  pointer: string;
  /** The tool that returned the result; `''` when the service did not say. */
  tool: string;
  /** `false` when the source is gone; `null` when the service sent no status for this binding. */
  ok: boolean | null;
  error: string;
}

/** The binding stored at a position, or `null` for a literal. */
export function storedBinding(raw: RawExhibitSpec | null, target: BoundTarget): unknown {
  if (!raw) return null;
  switch (target.at) {
    case 'cell':
      return raw.kind === 'table' ? (raw.rows?.[target.row]?.[target.key] ?? null) : null;
    case 'rows_from':
      return raw.kind === 'table' && raw.rows_from
        ? { $bind: { result: raw.rows_from.result, pointer: raw.rows_from.pointer } }
        : null;
    case 'smiles':
      return raw.kind === 'structures' ? (raw.items[target.item]?.smiles ?? null) : null;
    case 'prop':
      return raw.kind === 'structures'
        ? (raw.items[target.item]?.props[target.name] ?? null)
        : null;
    case 'series':
      return raw.kind === 'chart' ? (raw.series[target.series]?.[target.axis] ?? null) : null;
  }
}

/** The 64-hex form of a stored ref, for matching against `bindings[].result_ref`. */
const sameRef = (stored: string, listed: string): boolean =>
  stored === listed || (stored.startsWith('r:') && listed.startsWith(stored.slice(2)));

/**
 * `bindings[]` by path, built once per body. A table of 2,000 bound rows asks this per cell, and a
 * linear search per cell would make drawing it quadratic.
 */
const indexes = new WeakMap<readonly Binding[], Map<string, Binding>>();
function byPath(bindings: readonly Binding[]): Map<string, Binding> {
  let index = indexes.get(bindings);
  if (!index) {
    index = new Map(bindings.map((b) => [b.path, b]));
    indexes.set(bindings, index);
  }
  return index;
}

/**
 * The provenance of a position, or `null` when it holds a literal.
 *
 * Keyed on the stored spec, as the module header argues; the `bindings` row is what names the tool.
 */
export function provenanceAt(view: ExhibitView, target: BoundTarget): Provenance | null {
  const stored = storedBinding(view.raw_spec, target);
  if (!isBind(stored)) return null;
  const path = pathOf(target);
  const { result, pointer } = (stored as BindValue).$bind;
  const listed: Binding | undefined =
    byPath(view.bindings).get(path) ??
    view.bindings.find((b) => b.pointer === pointer && sameRef(result, b.result_ref));
  return {
    path,
    result: listed?.result_ref || result,
    pointer,
    tool: listed?.tool ?? '',
    ok: listed ? listed.ok : null,
    error: listed?.error ?? '',
  };
}

/** `r:` plus the first twelve hex — the handle the agent itself wrote, short enough to read. */
export const shortRef = (ref: string): string =>
  ref.startsWith('r:') ? ref : `r:${ref.slice(0, 12)}`;

/**
 * A `bindings[]` row that is not a tool result at all but a geometry's stored structure (hardening
 * item 1): `{path: "xyz", result_ref: "", tool: "structure", pointer: <structure_id>}`. The strip
 * says it in its own words — "the tool result has been removed" would be false of it.
 */
export const isStructureCitation = (b: Binding): boolean =>
  b.tool === 'structure' && b.result_ref === '';

/** Every binding of this revision whose source is gone, for the pane's strip. */
export const goneBindings = (view: ExhibitView): Binding[] => view.bindings.filter((b) => !b.ok);

/**
 * Whether a binding can be detached at all: only when there is a value to keep, or when `null` is
 * itself a legal literal at that position (a table cell, which the service types `str|number|null`).
 */
export const canDetach = (target: BoundTarget, provenance: Provenance): boolean =>
  provenance.ok !== false || target.at === 'cell';

/** A deep copy of a plain JSON value — the spec is one, so this is exact. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The stored spec with the binding at `target` replaced by the resolved value there.
 *
 * Everything else is copied verbatim, bindings included. `null` when the two specs do not describe
 * the same artefact (different kinds), which only a caller bug produces — the caller then says so
 * rather than posting something nobody wrote.
 */
export function detach(
  raw: RawExhibitSpec,
  resolved: ExhibitSpec,
  target: BoundTarget,
): RawExhibitSpec | null {
  const next = copy(raw);
  switch (target.at) {
    case 'cell': {
      if (next.kind !== 'table' || resolved.kind !== 'table' || !next.rows) return null;
      const row = next.rows[target.row];
      if (!row) return null;
      row[target.key] = resolved.rows[target.row]?.[target.key] ?? null;
      return next;
    }
    case 'rows_from': {
      if (next.kind !== 'table' || resolved.kind !== 'table') return null;
      // The whole body becomes the rows on screen, keyed by the table's own columns.
      const keys = next.columns.map((c) => c.key);
      next.rows = resolved.rows.map((row) =>
        Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k] ?? null])),
      );
      delete next.rows_from;
      return next;
    }
    case 'smiles': {
      if (next.kind !== 'structures' || resolved.kind !== 'structures') return null;
      const item = next.items[target.item];
      const shown = resolved.items[target.item]?.smiles;
      if (!item || !shown) return null;
      item.smiles = shown;
      return next;
    }
    case 'prop': {
      if (next.kind !== 'structures' || resolved.kind !== 'structures') return null;
      const item = next.items[target.item];
      const shown = resolved.items[target.item]?.props[target.name];
      if (!item || shown === null || shown === undefined) return null;
      item.props[target.name] = shown;
      return next;
    }
    case 'series': {
      if (next.kind !== 'chart' || resolved.kind !== 'chart') return null;
      const series = next.series[target.series];
      const shown = resolved.series[target.series];
      if (!series || !shown) return null;
      if (target.axis === 'x') series.x = [...shown.x];
      else series.y = [...shown.y];
      return next;
    }
  }
}

/** Whether a stored series is linked: its `y` bound, and its `x` bound or only category names. */
function seriesLinked(
  stored: { x: unknown; y: unknown } | undefined,
  resolvedX: readonly (number | string)[],
): boolean {
  const xLinked = isBind(stored?.x) || resolvedX.every((x) => typeof x === 'string');
  return isBind(stored?.y) && xLinked;
}

/**
 * The series of a chart whose plotted values are the agent's own transcription — decided per
 * series from the stored specs, never from who wrote the revision on screen.
 *
 * A series is linked when its `y` is bound and its `x` is too — or is only category names, which
 * are labels rather than figures anybody could have mistyped. A literal series is transcribed when
 * the agent wrote it literally; the one other way a chart series becomes literal is a person
 * detaching it (a chart has no point editor), and a detached series holds the tool's values
 * verbatim, so calling it transcribed would be false.
 *
 * `agentRaw` is the stored spec of the most recent **agent-authored** revision at or before this
 * one: a series literal here and linked there was detached since. `undefined` while that revision
 * is not known yet, which reads every literal series as transcribed — the cautious answer, and the
 * one this function gave before it knew.
 */
export function transcribedSeries(
  raw: RawExhibitSpec | null,
  resolved: ExhibitSpec,
  agentRaw?: RawExhibitSpec | null,
): string[] {
  if (resolved.kind !== 'chart') return [];
  return resolved.series.flatMap((series, index) => {
    const stored = raw?.kind === 'chart' ? raw.series[index] : undefined;
    if (seriesLinked(stored, series.x)) return [];
    if (agentRaw !== undefined) {
      const agentStored = agentRaw?.kind === 'chart' ? agentRaw.series[index] : undefined;
      // No agent revision at all, or the agent linked it and a person detached it since.
      if (agentRaw === null || seriesLinked(agentStored, series.x)) return [];
    }
    return [series.name || `Series ${index + 1}`];
  });
}

/**
 * A revision's stored spec, when it is the kind the view draws — what a write starts from. `null`
 * only when the service sent none it could read, and then the view offers no edit.
 */
export function rawOf<K extends RawExhibitSpec['kind']>(
  view: ExhibitView,
  kind: K,
): Extract<RawExhibitSpec, { kind: K }> | null {
  const raw = view.raw_spec;
  return raw && raw.kind === kind ? (raw as Extract<RawExhibitSpec, { kind: K }>) : null;
}
