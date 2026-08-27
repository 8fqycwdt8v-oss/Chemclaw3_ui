/**
 * What a tool returned, rendered as the thing it is.
 *
 * These used to live inside `ResultSheet`, which meant they could only be seen by a reader who had
 * already opened the trace, found the row and asked for the full result — three actions and a
 * full-height overlay to reach a hazard table the answer above was written from. They are now a
 * registry: each renderer states what it matches, and draws itself **compact** for the message
 * body or **full** for the sheet, from one component, so the card in the answer and the panel
 * behind it cannot describe the same result differently.
 *
 * Two rules shape every one of them, and both come from the service rather than from taste.
 *
 * **`text` is not promised to be JSON.** Upstream types it as text on purpose, so every renderer
 * parses defensively and the fallback is the raw text, never an error.
 *
 * **A `verdict` or `summary` renders before the data it qualifies.** Several of these results carry
 * one and it is load-bearing in a way that is easy to lose: an empty `flags` list means "no rule
 * matched", which is explicitly *not* a clearance; an empty fingerprint hit list can mean "the
 * index is empty" rather than "no analogue exists". A table with nothing in it reads as "nothing
 * found" unless the sentence above it says otherwise — so `Verdict` is rendered by the registry,
 * above whatever the renderer draws, and never re-worded here.
 *
 * ## Compact is a smaller view of the same data, never a different claim
 *
 * A compact renderer may show fewer rows. It may never drop the caveat, the verdict, the "index is
 * empty" banner or the "not resolved to a structure" alert: those are the sentences that decide
 * how the numbers are read, and a card that omits them to save two lines is a card that says
 * something the full view does not.
 */

import { Download } from 'lucide-react';
import { toolLabel } from '../lib/format.ts';
import { Molecule } from '../components/Molecule.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  firstRecordList,
  isObject,
  mightBeStructure,
  num,
  numericSeries,
  rows,
  scalarNumbers,
  str,
  strings,
  type Json,
} from './shape.ts';

/** What every renderer is handed. `compact` is the card in the answer; otherwise it is the sheet. */
export interface ResultViewProps {
  data: Json;
  /** The tool that produced it — the label, and the CSV's filename. */
  tool: string;
  compact: boolean;
  /** Called when a structure in here was put into the composer, so a sheet can close itself. */
  onUsed: () => void;
}

/* ── Shared furniture ─────────────────────────────────────────────────────── */

/** Severity is an ordered vocabulary upstream; the tone has to preserve the order. */
const SEVERITY_TONE: Record<string, 'danger' | 'warn' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warn',
  low: 'neutral',
  info: 'neutral',
};

/**
 * Turn records into a CSV a spreadsheet will open without argument.
 *
 * RFC 4180 quoting, which is three rules and worth doing properly: a field containing a comma, a
 * quote or a newline is quoted, and an embedded quote is doubled. A run sheet retyped into Excel by
 * hand is where the transcription error enters a campaign, and a chemist handed a markdown table
 * has no other option.
 */
export function toCsv(headers: string[], records: Json[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...records.map((r) => headers.map((h) => cell(r[h])).join(','))].join(
    '\r\n',
  );
}

export function DownloadCsv({
  headers,
  records,
  name,
}: {
  headers: string[];
  records: Json[];
  name: string;
}): React.JSX.Element {
  // An object URL rather than a data: URI — a large table exceeds what some browsers will accept
  // in a URL — revoked as soon as the click has been dispatched.
  const download = (): void => {
    const blob = new Blob([toCsv(headers, records)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Button variant="outline" size="xs" onClick={download}>
      <Download aria-hidden className="size-3.5" />
      Download CSV
    </Button>
  );
}

function Table({
  headers,
  body,
  label,
}: {
  headers: string[];
  body: React.ReactNode;
  /** Names the scroll region, which a focusable role="region" requires. */
  label: string;
}): React.JSX.Element {
  return (
    // The panel itself must never scroll sideways, so the table gets its own scroller — and a
    // scroller nothing inside it can focus is a column no keyboard can ever reach.
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
    >
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-sunken text-2xs tracking-wide text-ink-subtle uppercase">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="px-2.5 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">{body}</tbody>
      </table>
    </div>
  );
}

function Cell({
  children,
  numeric,
}: {
  children: React.ReactNode;
  numeric?: boolean;
}): React.JSX.Element {
  return (
    <td className={numeric ? 'px-2.5 py-1.5 text-right font-mono tabular-nums' : 'px-2.5 py-1.5'}>
      {children}
    </td>
  );
}

/** "3 of 11 shown" — said whenever a compact view is not the whole table, so a card can never be
 *  mistaken for the result. */
function Trimmed({ shown, total }: { shown: number; total: number }): React.JSX.Element | null {
  if (shown >= total) return null;
  return (
    <p className="text-2xs text-ink-subtle">
      {shown} of {total} shown — open the full result for the rest.
    </p>
  );
}

const take = <T,>(items: T[], compact: boolean, limit: number): T[] =>
  compact ? items.slice(0, limit) : items;

/* ── The renderers ────────────────────────────────────────────────────────── */

/**
 * `screen_hazards` and `screen_genotoxic_alerts` — a severity table with its citations.
 *
 * The caveat is pinned above the table and rendered whether or not anything matched, because the
 * dangerous reading of this result is the empty one. The service says it in the payload for the
 * same reason; repeating it here is not redundancy, it is the sentence the chemist acts on — and
 * it is why the compact card keeps it while dropping rows.
 */
function HazardScreen({ data, compact, onUsed }: ResultViewProps): React.JSX.Element {
  const flags = rows(data.flags);
  const screened = strings(data.screened);
  const shownFlags = take(flags, compact, 3);

  return (
    <>
      <p
        role="note"
        className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
      >
        A structural screen is advisory. Nothing matching is <strong>not</strong> a clearance — the
        rules cover known motifs, not this compound at this scale in this process.
      </p>

      {screened.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            Screened
          </h3>
          <ul className="flex flex-wrap gap-3">
            {take(screened, compact, 3).map((smiles) => (
              <li key={smiles} className="flex flex-col items-end gap-1">
                <Molecule smiles={smiles} maxWidth={compact ? 132 : 180} />
                <UseStructure smiles={smiles} onUsed={onUsed} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {flags.length === 0 ? (
        <p className="text-sm text-ink-muted">No rule in the table matched what was screened.</p>
      ) : (
        <>
          <Table
            label="Hazard rules that matched"
            headers={['Severity', 'Rule', 'Matched', 'Why', 'Citation']}
            body={shownFlags.map((flag, i) => (
              <tr key={`${str(flag.rule_id)}-${i}`}>
                <Cell>
                  <Badge tone={SEVERITY_TONE[str(flag.severity)] ?? 'neutral'}>
                    {str(flag.severity)}
                  </Badge>
                </Cell>
                <Cell>
                  <span className="font-mono text-2xs">{str(flag.rule_id)}</span>
                </Cell>
                <Cell>
                  <span className="font-mono text-2xs break-all">{str(flag.matched)}</span>
                </Cell>
                <Cell>{str(flag.explanation)}</Cell>
                <Cell>
                  <span className="text-2xs text-ink-muted">{str(flag.citation)}</span>
                </Cell>
              </tr>
            ))}
          />
          <Trimmed shown={shownFlags.length} total={flags.length} />
        </>
      )}
    </>
  );
}

/**
 * `ich_impurity_limit` — the number, and the guideline it is a number *from*.
 *
 * The provenance is the whole point of this renderer. This table was added to the service to end a
 * measured failure where a palladium PDE was recited from training as though it were the record; a
 * limit shown without its guideline, revision and table is that failure again with an extra step.
 * A miss is shown as a miss for the same reason.
 */
function ImpurityLimit({ data, compact }: ResultViewProps): React.JSX.Element {
  const limit = isObject(data.limit) ? data.limit : null;
  if (!limit) {
    return (
      <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-sm">
        No transcribed row for <span className="font-mono">{str(data.query)}</span>. That means this
        service has no limit on file — <strong>not</strong> that no limit exists.
      </p>
    );
  }
  const limits = rows(limit.limits);
  const shown = take(limits, compact, 3);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{str(limit.substance)}</span>
        <Badge tone="neutral">Class {str(limit.limit_class)}</Badge>
      </div>
      <p className="text-sm text-ink-muted">{str(limit.class_meaning)}</p>

      <Table
        label="Limits quoted by the guideline"
        headers={['Basis', 'Limit', 'Unit']}
        body={shown.map((row, i) => (
          <tr key={`${str(row.basis)}-${i}`}>
            <Cell>{str(row.basis)}</Cell>
            <Cell numeric>{num(row.value)?.toLocaleString() ?? '—'}</Cell>
            <Cell>{str(row.unit)}</Cell>
          </tr>
        ))}
      />
      <Trimmed shown={shown.length} total={limits.length} />

      <p className="text-2xs text-ink-muted">
        {str(limit.guideline)} · {str(limit.citation)}
      </p>
    </>
  );
}

/**
 * `stoichiometry_table` — the charge table, with what it could not resolve stated.
 *
 * **Each row draws its species.** This is the table a chemist reads at the bench while charging a
 * vessel, and it is the one where confusing two species has a physical consequence — a name is
 * what a reagent is called, a structure is what it is.
 */
function ChargeTable({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  const unresolved = strings(data.unresolved);
  const all = rows(data.rows);
  const shown = take(all, compact, 4);
  return (
    <>
      <p className="text-sm">
        Basis <span className="font-medium">{str(data.basis_name)}</span> at{' '}
        <span className="font-mono tabular-nums">
          {num(data.basis_mass_g)?.toFixed(2) ?? '—'} g
        </span>
      </p>

      {unresolved.length > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-ink"
        >
          Not resolved to a structure, so absent from the table below: {unresolved.join(', ')}.
        </p>
      )}

      <div className="flex justify-end">
        <DownloadCsv
          headers={[...new Set(all.flatMap((r) => Object.keys(r)))]}
          records={all}
          name={tool}
        />
      </div>

      <Table
        label="Charge table"
        headers={['Species', 'Role', 'Equiv', 'MW', 'mmol', 'Mass (g)', 'Volume (mL)']}
        body={shown.map((row, i) => (
          <tr key={`${str(row.name)}-${i}`}>
            <Cell>
              <span className="block">{str(row.name)}</span>
              {/* Absent for a species the table could not resolve — which is the `unresolved`
                  list above, so a missing drawing here is never silent. */}
              {mightBeStructure(str(row.smiles)) && (
                <Molecule smiles={str(row.smiles)} maxWidth={132} className="mt-1" />
              )}
            </Cell>
            <Cell>
              <Badge tone={str(row.role) === 'basis' ? 'brand' : 'neutral'}>{str(row.role)}</Badge>
            </Cell>
            <Cell numeric>{num(row.equivalents)?.toFixed(2) ?? '—'}</Cell>
            <Cell numeric>{num(row.molecular_weight)?.toFixed(2) ?? '—'}</Cell>
            <Cell numeric>{num(row.moles_mmol)?.toFixed(2) ?? '—'}</Cell>
            <Cell numeric>{num(row.mass_g)?.toFixed(3) ?? '—'}</Cell>
            {/* A reagent charged by mass has no volume; an empty cell is the honest rendering. */}
            <Cell numeric>{num(row.volume_ml)?.toFixed(1) ?? ''}</Cell>
          </tr>
        ))}
      />
      <Trimmed shown={shown.length} total={all.length} />
    </>
  );
}

/**
 * A run sheet — `generate_screening_design`, and anything else whose rows are meant to be worked
 * through in the order given.
 *
 * Two things separate it from the generic table it used to fall through to. The **order is the
 * data**: a screening design randomises its run order deliberately, and a table that invites
 * sorting invites destroying that, so the rows are numbered as they arrive. And the **CSV is not
 * an extra**: this is the one result that leaves the screen and goes to a bench, and a run sheet
 * retyped into Excel is where the transcription error enters a campaign — so the download is on
 * the compact card too, not only in the panel behind it.
 */
function RunSheet({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  const key = firstRecordList(data) ?? 'rows';
  const records = rows(data[key]);
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const shown = take(records, compact, 4);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs tracking-wide text-ink-subtle uppercase">
          {records.length} run{records.length === 1 ? '' : 's'}, in the order given
        </p>
        <DownloadCsv headers={headers} records={records} name={tool} />
      </div>
      <Table
        label="The run sheet, in run order"
        headers={['#', ...headers]}
        body={shown.map((record, i) => (
          <tr key={i}>
            <Cell numeric>{i + 1}</Cell>
            {headers.map((header) => {
              const value = record[header];
              const asNumber = num(value);
              if (asNumber !== null)
                return (
                  <Cell key={header} numeric>
                    {asNumber.toLocaleString()}
                  </Cell>
                );
              if (typeof value === 'string' || typeof value === 'boolean')
                return <Cell key={header}>{String(value)}</Cell>;
              if (value === undefined || value === null) return <Cell key={header}>—</Cell>;
              return (
                <Cell key={header}>
                  <span className="font-mono text-2xs">{JSON.stringify(value)}</span>
                </Cell>
              );
            })}
          </tr>
        ))}
      />
      <Trimmed shown={shown.length} total={records.length} />
    </>
  );
}

/**
 * A search whose answer *is* structures — `similar_molecules`, `substructure_matches`,
 * `similar_reactions`.
 *
 * ## The empty result is the dangerous one, and it is not this component's to interpret
 *
 * A live run answered `{"result": []}` off an unbackfilled index and it was read as "we have never
 * made anything like this". The payload carries `verdict` as a computed field for exactly that
 * reason, and the registry renders it verbatim above this. So this renders the *flags* rather than
 * re-deriving a sentence from them: writing our own "no analogue found" here would be the same
 * failure with a nicer typeface.
 */
function StructureHits({ data, tool, compact, onUsed }: ResultViewProps): React.JSX.Element {
  const hits = rows(data.hits);
  const subject = str(data.subject) || 'record';
  const shown = take(hits, compact, 6);
  const structureOf = (hit: Json): string => str(hit.smiles) || str(hit.label);
  const citationOf = (hit: Json): string => str(hit.compound_note_id) || str(hit.id);

  return (
    <>
      {data.index_empty === true && (
        <p
          role="alert"
          className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
        >
          The {subject} index holds no searchable record, so the query was compared against nothing.{' '}
          <strong>The question was not answered</strong> — this is not a finding that nothing
          similar exists.
        </p>
      )}

      {data.scan_truncated === true && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink">
          Not every stored {subject} was examined — the scan stopped at its record cap, or a stored
          record could not be read. What is below is not the complete picture.
        </p>
      )}

      {hits.length === 0 ? (
        // No sentence of our own. The verdict above carries the service's, which distinguishes the
        // three ways this can be empty; a friendlier second one here is the one a reader believes.
        <p className="text-sm text-ink-muted">Nothing to draw.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs tracking-wide text-ink-subtle uppercase">
              {hits.length} hit{hits.length === 1 ? '' : 's'}
              {data.hits_truncated === true && ' — a lower bound, not a total'}
            </p>
            <DownloadCsv
              headers={[...new Set(hits.flatMap((h) => Object.keys(h)))]}
              records={hits}
              name={tool}
            />
          </div>

          <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
            {shown.map((hit, i) => {
              const structure = structureOf(hit);
              const citation = citationOf(hit);
              const similarity = num(hit.similarity);
              return (
                <li
                  key={`${citation}-${i}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface-raised p-2"
                >
                  {structure ? (
                    <Molecule smiles={structure} maxWidth={176} />
                  ) : (
                    <span className="font-mono text-2xs break-all">{'—'}</span>
                  )}

                  <div className="flex items-center justify-between gap-1.5">
                    {/* Null for a substructure match, which is a yes/no question and has no
                        score. Rendering 0.00 there would be a number that means nothing. */}
                    {similarity !== null ? (
                      <Badge tone="neutral">
                        <span className="font-mono tabular-nums">{similarity.toFixed(2)}</span>
                        <span className="font-normal opacity-80">Tanimoto</span>
                      </Badge>
                    ) : (
                      <Badge tone="neutral">match</Badge>
                    )}
                    {structure && <UseStructure smiles={structure} onUsed={onUsed} />}
                  </div>

                  {citation && (
                    <span className="truncate font-mono text-2xs text-ink-muted" title={citation}>
                      {citation}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <Trimmed shown={shown.length} total={hits.length} />
        </>
      )}
    </>
  );
}

/**
 * A run of numbers whose shape is the reading — a campaign's running best, a scan profile.
 *
 * The series is labelled with the key the service filed it under and nothing else. There is no
 * unit on the wire, so there is no axis: a chart that invents "%" or "kcal/mol" is the same
 * fabrication as a value strip that invents "± 1.6", and it is harder to catch because it looks
 * like a measurement.
 */
function SeriesResult({ data, compact }: ResultViewProps): React.JSX.Element {
  const series = numericSeries(data)!;
  const { values, key } = series;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return (
    <>
      <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <Sparkline values={values} label={key} />
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-lg leading-none tabular-nums">{last}</p>
            <p className="text-2xs text-ink-subtle">latest</p>
          </div>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-subtle">
          <span className="font-mono">{key}</span> · {values.length} points · first{' '}
          <span className="font-mono tabular-nums">{first}</span>, lowest{' '}
          <span className="font-mono tabular-nums">{Math.min(...values)}</span>, highest{' '}
          <span className="font-mono tabular-nums">{Math.max(...values)}</span>
        </p>
      </div>
      {/* The numbers themselves, because a chart is a reading of data and not a substitute for it.
          Compact keeps the chart and leaves the list to the full view. */}
      {!compact && (
        <pre
          tabIndex={0}
          role="region"
          aria-label={`Every value in ${key}`}
          className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs whitespace-pre-wrap focus-ring"
        >
          {values.join(', ')}
        </pre>
      )}
    </>
  );
}

/**
 * A result whose payload is a handful of named numbers — a pKa, a logD, an electronic profile.
 *
 * **No units and no derived quantities.** The keys are the service's own, printed as it wrote
 * them, because the alternative is a table that reads `pKa 4.76 ± 1.6` over a payload that said
 * `{"pka": 4.76, "sd": 1.6}` and never claimed the second was an uncertainty on the first.
 */
function ValueStrip({ data, compact }: ResultViewProps): React.JSX.Element {
  const all = scalarNumbers(data);
  const shown = take(all, compact, 6);
  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
        {shown.map(({ key, value }) => (
          <li key={key} className="rounded-lg border border-border-subtle bg-surface-raised p-2">
            <p className="truncate text-2xs tracking-wide text-ink-subtle uppercase" title={key}>
              {key}
            </p>
            <p className="font-mono text-base tabular-nums">{value.toLocaleString()}</p>
          </li>
        ))}
      </ul>
      <Trimmed shown={shown.length} total={all.length} />
    </>
  );
}

/**
 * Anything shaped like a list of flat records, whatever produced it.
 *
 * Deliberately generic. The alternative — a renderer per tool — means every new tool on the
 * service is invisible here until someone writes one, and there are roughly fifty-six. Columns
 * come from the union of the keys present, so a tool that adds a field shows it without a change
 * here. Nested values are not flattened: they are shown as JSON in the cell, which is worse than a
 * real renderer and much better than hiding them.
 */
function AutoTable({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  const key = firstRecordList(data);
  const records = key ? rows(data[key]) : [];
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const shown = take(records, compact, 3);
  return (
    <>
      {!compact && (
        <div className="flex justify-end">
          <DownloadCsv headers={headers} records={records} name={tool} />
        </div>
      )}
      <Table
        label="The tool's result, as a table"
        headers={headers}
        body={shown.map((record, i) => (
          <tr key={i}>
            {headers.map((header) => {
              const value = record[header];
              const asNumber = num(value);
              if (asNumber !== null)
                return (
                  <Cell key={header} numeric>
                    {asNumber.toLocaleString()}
                  </Cell>
                );
              if (typeof value === 'string' || typeof value === 'boolean')
                return <Cell key={header}>{String(value)}</Cell>;
              if (value === undefined || value === null) return <Cell key={header}>—</Cell>;
              return (
                <Cell key={header}>
                  <span className="font-mono text-2xs">{JSON.stringify(value)}</span>
                </Cell>
              );
            })}
          </tr>
        ))}
      />
      <Trimmed shown={shown.length} total={records.length} />
    </>
  );
}

/** A bare list of records at the top level, which several search tools return. */
function BareList({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  return <AutoTable data={data} tool={tool} compact={compact} onUsed={() => {}} />;
}

/** The floor: exactly what the tool returned, unparsed. Still the whole thing in the full view. */
export function RawText({ text, compact }: { text: string; compact: boolean }): React.JSX.Element {
  const shown = compact && text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label="The tool's full output"
      className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap focus-ring"
    >
      {shown}
    </pre>
  );
}

/** The one sentence that qualifies everything under it, when the result carries one. */
export function Verdict({ data }: { data: Json }): React.JSX.Element | null {
  const line = str(data.verdict) || str(data.summary);
  if (!line) return null;
  return <p className="text-sm font-medium">{line}</p>;
}

/* ── The registry ─────────────────────────────────────────────────────────── */

export interface ResultRenderer {
  /** Stable id, so a test can assert which renderer a payload chose without matching on markup. */
  id: string;
  /** What to call this block in the answer. The tool's own label when there is nothing better. */
  title: (tool: string) => string;
  View: (props: ResultViewProps) => React.JSX.Element;
  /** Whether this result wants more width than the answer's reading measure. */
  wide: boolean;
  /**
   * The one thing the block's header can say about the payload before it is read.
   *
   * Deliberately a count or a state and never a judgement: "1 high" is what the table says, and
   * "looks fine" would be this component deciding something the service did not. Absent when the
   * shape has nothing worth summarising, which is most of them.
   */
  summary?: (data: Json) => { text: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' } | null;
  /**
   * Whether this renderer models the payload or merely displays it.
   *
   * A generic renderer draws what it recognised and may have left the rest behind, so the sheet
   * offers the raw text underneath it. A typed one has already rendered every field it cares
   * about, and repeating the whole payload beside it is a second copy of the same result — which
   * is how a reader ends up comparing a table with the JSON it was built from.
   */
  generic: boolean;
}

/**
 * Is this a fingerprint search — a `hits` list whose rows carry a structure?
 *
 * Shape, not tool name, so a fourth search tool renders without an edit here. What this must not do
 * is claim a `hits` list of something else — a job listing, a set of candidates — so an empty
 * `hits` array only counts when the payload also carries the fingerprint search's own flags.
 */
function isStructureSearch(parsed: Json): boolean {
  if (!Array.isArray(parsed.hits)) return false;
  const hits = rows(parsed.hits);
  if (hits.length === 0) return 'index_empty' in parsed;
  return hits.every((hit) => mightBeStructure(str(hit.smiles) || str(hit.label)));
}

/**
 * The table, in priority order.
 *
 * Order is the whole of the dispatch, so it is written as data rather than as a chain of ternaries
 * — which is what the sheet used to carry, and which made "what renders this payload" a question
 * you answered by reading an expression. The two name-keyed entries are first because their shapes
 * are genuinely ambiguous; everything below them keys on the payload alone.
 */
const RENDERERS: (ResultRenderer & { matches: (tool: string, data: Json) => boolean })[] = [
  {
    id: 'hazard',
    generic: false,
    title: () => 'Hazard screen',
    wide: true,
    summary: (data) => {
      const flags = rows(data.flags);
      if (flags.length === 0) {
        // "no rule matched", never "clear": the difference is the whole of the caveat below it.
        return { text: 'no rule matched', tone: 'neutral' };
      }
      const worst = ['critical', 'high', 'medium', 'low', 'info'].find((level) =>
        flags.some((f) => str(f.severity) === level),
      );
      return {
        text: worst ? `${flags.length} · ${worst}` : `${flags.length} matched`,
        tone: worst ? (SEVERITY_TONE[worst] ?? 'neutral') : 'neutral',
      };
    },
    matches: (tool, data) =>
      tool === 'screen_hazards' || tool === 'screen_genotoxic_alerts' || 'flags' in data,
    View: HazardScreen,
  },
  {
    id: 'impurity',
    generic: false,
    title: () => 'Impurity limit',
    wide: false,
    // Name-keyed: a miss is `{limit: null}`, which no shape test can tell from any other payload
    // carrying a null field.
    matches: (tool) => tool === 'ich_impurity_limit',
    View: ImpurityLimit,
  },
  {
    id: 'charge',
    generic: false,
    title: () => 'Charge table',
    wide: true,
    summary: (data) =>
      strings(data.unresolved).length > 0
        ? { text: `${strings(data.unresolved).length} unresolved`, tone: 'danger' }
        : { text: `${rows(data.rows).length} species`, tone: 'neutral' },
    matches: (tool, data) =>
      tool === 'stoichiometry_table' || ('basis_name' in data && rows(data.rows).length > 0),
    View: ChargeTable,
  },
  {
    id: 'structures',
    generic: false,
    title: () => 'Structures found',
    wide: true,
    summary: (data) => {
      if (data.index_empty === true) return { text: 'index empty', tone: 'warn' };
      const hits = rows(data.hits).length;
      return { text: `${hits} hit${hits === 1 ? '' : 's'}`, tone: 'neutral' };
    },
    matches: (_tool, data) => isStructureSearch(data),
    View: StructureHits,
  },
  {
    id: 'runsheet',
    generic: false,
    title: () => 'Run sheet',
    wide: true,
    summary: (data) => {
      const key = firstRecordList(data);
      const count = key ? rows(data[key]).length : 0;
      return { text: `${count} run${count === 1 ? '' : 's'}`, tone: 'neutral' };
    },
    // Name-keyed, and it has to be: "a list of records in a meaningful order" and "a list of
    // records" are the same shape. Getting it wrong costs a numbered column on a table that did
    // not want one, which is why the fallback below is the generic table rather than this.
    matches: (tool, data) => tool === 'generate_screening_design' && !!firstRecordList(data),
    View: RunSheet,
  },
  {
    id: 'series',
    generic: true,
    title: () => 'Series',
    wide: false,
    matches: (_tool, data) => numericSeries(data) !== null,
    View: SeriesResult,
  },
  {
    id: 'values',
    generic: true,
    title: (tool) => toolLabel(tool),
    wide: false,
    // Only when there is nothing else in the payload worth tabulating: a result carrying both a
    // record list and a couple of scalars is a table with a header, not a value strip.
    matches: (_tool, data) => scalarNumbers(data).length > 0 && !firstRecordList(data),
    View: ValueStrip,
  },
  {
    id: 'table',
    generic: true,
    title: (tool) => toolLabel(tool),
    wide: true,
    matches: (_tool, data) => firstRecordList(data) !== undefined,
    View: AutoTable,
  },
];

/** The renderer for a bare top-level array — handled outside the table because it is not an object. */
const BARE_LIST: ResultRenderer = {
  id: 'table',
  title: (tool) => toolLabel(tool),
  wide: true,
  generic: true,
  View: BareList,
};

/**
 * Which renderer draws this result, and the object it should be handed.
 *
 * Returns `null` when nothing structured applies, which is the caller's cue to show the raw text.
 * The `data` it returns is not always the parsed payload: a bare top-level array is wrapped so
 * every renderer can assume an object, rather than each one re-deriving that distinction.
 */
export function rendererFor(
  tool: string,
  parsed: unknown,
): { renderer: ResultRenderer; data: Json } | null {
  if (Array.isArray(parsed)) {
    const records = rows(parsed);
    if (records.length === 0 || records.length !== parsed.length) return null;
    return { renderer: BARE_LIST, data: { items: records } };
  }
  if (!isObject(parsed)) return null;
  const found = RENDERERS.find((r) => r.matches(tool, parsed));
  return found ? { renderer: found, data: parsed } : null;
}
