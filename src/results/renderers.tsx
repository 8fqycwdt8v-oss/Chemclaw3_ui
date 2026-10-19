/**
 * What a tool returned, rendered as the thing it is: a registry where each renderer states what it
 * matches and draws itself compact (in the answer) or full (in the sheet), so both views describe a
 * result the same way.
 *
 * - `text` is not promised to be JSON: parse defensively, fall back to the raw text.
 * - A `verdict` or `summary` renders above the data it qualifies (an empty `flags` list is not a
 *   clearance); the registry draws it, never re-worded.
 * - Compact may show fewer rows but never drops a caveat, verdict or alert.
 */

import { lazy, Suspense, useState } from 'react';
import { Download } from 'lucide-react';
import { formatScientificNumber, toolLabel } from '../lib/format.ts';
import { saveBlob } from '../lib/download.ts';
import { Molecule } from '../components/Molecule.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BestSoFarChart, ParetoScatter, sig } from '@/components/chem/Charts';
import { cn } from '@/lib/utils';
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

/**
 * A figure for a table cell, or an em dash. Uses `formatScientificNumber`, not `toLocaleString`, so
 * the decimal separator does not depend on the browser locale.
 */
const numeric = (value: number | null): string =>
  value === null ? '—' : formatScientificNumber(value);

/** Severity is an ordered vocabulary upstream; the tone has to preserve the order. */
const SEVERITY_TONE: Record<string, 'danger' | 'warn' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warn',
  low: 'neutral',
  info: 'neutral',
};

/**
 * Whether a cell would be evaluated as a spreadsheet formula (`=`, `+`, `-`, `@`, or after a
 * leading tab/CR). Tool results come from outside the browser, so this is an injection guard. A
 * cell that is entirely a number (e.g. `-40`) is not a formula.
 */
function isFormula(text: string): boolean {
  if (text === '') return false;
  const head = text[0]!;
  if (head === '=' || head === '+' || head === '@' || head === '\t' || head === '\r') return true;
  return head === '-' && !Number.isFinite(Number(text));
}

/**
 * Records to CSV: RFC 4180 quoting, plus a leading `'` on any cell a spreadsheet would read as a
 * formula (quoting alone does not stop evaluation).
 */
export function toCsv(headers: string[], records: Json[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const text = isFormula(raw) ? `'${raw}` : raw;
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
  // `saveBlob` carries the two rules a browser download needs (object URL, anchor in the document
  // and revoked a tick later); the artefact export menu saves through it too.
  const download = (): void =>
    saveBlob(
      new Blob([toCsv(headers, records)], { type: 'text/csv;charset=utf-8' }),
      `${name}.csv`,
    );
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

/**
 * Rows the full view draws before offering the rest (rendering cost is linear in rows). A cap never
 * subtracts: the CSV and the header union always cover the whole record set.
 */
const FULL_ROW_LIMIT = 100;

/**
 * The cap for a grid of drawn structures (~5 ms and ~10 kB of SVG each, drawn in one task). 24
 * divides evenly by every column count the grid uses.
 */
const FULL_STRUCTURE_LIMIT = 24;

/**
 * A cap on a long list and the state that lifts it. Compact is a fixed slice pointing at the full
 * result; the full view is capped, never truncated — it always says how many were drawn and offers
 * the rest.
 */
interface Cap {
  /** How many items to draw. */
  limit: number;
  /** One page — what "show more" adds. */
  page: number;
  /** Lift the cap by a page, or all the way. Absent in the compact card, which does not offer it. */
  more: ((all: boolean) => void) | null;
}

function useCap(total: number, compact: boolean, compactLimit: number, fullLimit: number): Cap {
  const [limit, setLimit] = useState(fullLimit);
  if (compact) return { limit: compactLimit, page: compactLimit, more: null };
  return {
    limit,
    page: fullLimit,
    more: (all: boolean) => setLimit(all ? total : limit + fullLimit),
  };
}

/**
 * "3 of 11 shown", whenever a view is not the whole list. Compact names the panel; full offers the
 * control. `csv` is set when the adjacent download covers the whole set.
 */
function Trimmed({
  shown,
  total,
  cap,
  noun = 'row',
  csv = false,
  className,
}: {
  shown: number;
  total: number;
  cap?: Cap;
  /** Singular; pluralised here. What is being counted, so the sentence is about hits or structures
   *  rather than about "items". */
  noun?: string;
  csv?: boolean;
  /** For a caller whose own container carries no gap — the sentence has to sit off the list. */
  className?: string;
}): React.JSX.Element | null {
  if (shown >= total) return null;
  if (!cap?.more) {
    return (
      <p className={cn('text-2xs text-ink-subtle', className)}>
        {shown} of {total} shown — open the full result for the rest.
      </p>
    );
  }
  const remaining = total - shown;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      {/* Always plural: this branch is unreachable unless at least two exist. */}
      <p className="text-2xs text-ink-subtle">
        {shown} of {total} {noun}s drawn — the rest are held back to keep this view responsive, not
        dropped
        {csv && ', and the CSV above is the whole set'}.
      </p>
      <Button variant="outline" size="xs" onClick={() => cap.more?.(false)}>
        Show {Math.min(cap.page, remaining)} more
      </Button>
      {remaining > cap.page && (
        <Button variant="link" size="xs" onClick={() => cap.more?.(true)}>
          Show all {total}
        </Button>
      )}
    </div>
  );
}

const take = <T,>(items: T[], compact: boolean, limit: number): T[] =>
  compact ? items.slice(0, limit) : items;

/* ── The renderers ────────────────────────────────────────────────────────── */

/**
 * `screen_hazards` and `screen_genotoxic_alerts`: a severity table with citations. The caveat is
 * always shown, even with no matches, because the empty result is the dangerous reading.
 */
function HazardScreen({ data, compact, onUsed }: ResultViewProps): React.JSX.Element {
  const flags = rows(data.flags);
  const screened = strings(data.screened);
  const shownFlags = take(flags, compact, 3);
  // The screened structure list takes the structure cap; the flag table is never capped (its rows
  // are the finding).
  const screenedCap = useCap(screened.length, compact, 3, FULL_STRUCTURE_LIMIT);
  const shownScreened = screened.slice(0, screenedCap.limit);

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
            {shownScreened.map((smiles) => (
              <li key={smiles} className="flex flex-col items-end gap-1">
                <Molecule smiles={smiles} maxWidth={compact ? 132 : 180} />
                <UseStructure smiles={smiles} onUsed={onUsed} />
              </li>
            ))}
          </ul>
          <Trimmed
            shown={shownScreened.length}
            total={screened.length}
            cap={screenedCap}
            noun="structure"
            className="mt-1.5"
          />
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
 * `ich_impurity_limit`: the number and the guideline, revision and table it comes from. A limit
 * without its source is not shown; a miss is shown as a miss.
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
            <Cell numeric>{numeric(num(row.value))}</Cell>
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
 * `stoichiometry_table`: the charge table, drawing each row's species and stating what could not be
 * resolved.
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
 * A run sheet (`generate_screening_design` and similar). Rows are numbered in the given order and
 * not sortable (the order is randomised on purpose), and the CSV is on the compact card too.
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
                    {formatScientificNumber(asNumber)}
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
 * A search whose answer is structures (`similar_molecules`, `substructure_matches`,
 * `similar_reactions`). An empty result may mean an unbackfilled index; the registry renders the
 * payload's `verdict` above, and this renders flags without deriving its own sentence.
 */
function StructureHits({ data, tool, compact, onUsed }: ResultViewProps): React.JSX.Element {
  const hits = rows(data.hits);
  const subject = str(data.subject) || 'record';
  // Capped in the full view: see `FULL_STRUCTURE_LIMIT`.
  const cap = useCap(hits.length, compact, 6, FULL_STRUCTURE_LIMIT);
  const shown = hits.slice(0, cap.limit);
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
          <Trimmed shown={shown.length} total={hits.length} cap={cap} noun="hit" csv={!compact} />
        </>
      )}
    </>
  );
}

/*
 * ── The experiment protocol ── `draft_experiment_protocol`, `structure_experiment_request` and
 * `read_experiment_protocol` return a `ProtocolReceipt` (`shared/protocols.ts`): a pointer at a
 * document a human edits. The card is never the protocol (`arms` is capped; the link to
 * `/protocols/{design_id}` is part of the result), and the structural-checks caveat is always
 * shown.
 */

/**
 * What the receipt says about itself, as a count and a state, shared by the header chip and the
 * card. `blocking` is the service's subset of failed checks that stop execution. No checks at all
 * is neutral, not "all passed".
 */
function protocolVerdict(data: Json): {
  text: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger';
} {
  const blocking = strings(data.blocking);
  if (blocking.length > 0) {
    return { text: `${blocking.length} blocking`, tone: 'danger' };
  }
  const checks = rows(data.checks);
  const failed = checks.filter((check) => check.passed === false);
  if (failed.length > 0) {
    return { text: `${failed.length} of ${checks.length} failed`, tone: 'warn' };
  }
  if (checks.length === 0) return { text: 'no checks recorded', tone: 'neutral' };
  // At the request stage, unrun checks come back as passing notes, so they are not counted as
  // passes. Decided by `has_protocol` (what the service chose the stage by); `!== false` falls back
  // to the status for older services.
  if (
    data.has_protocol === false ||
    (data.has_protocol === undefined && str(data.status) === 'requested')
  ) {
    return { text: 'the ask only — the procedure has not been checked', tone: 'neutral' };
  }
  return { text: `${checks.length} checks passed`, tone: 'ok' };
}

/** Check severity tones, in upstream order. Shared with the document view. */
export const CHECK_TONE: Record<string, 'danger' | 'warn' | 'neutral'> = {
  blocker: 'danger',
  warning: 'warn',
  note: 'neutral',
};

/** One arm as a flat record — what the CSV writes and what the table reads, derived once. */
function armRecords(data: Json, factorNames: string[]): Json[] {
  return rows(data.arms).map((arm) => {
    const levels = isObject(arm.levels) ? arm.levels : {};
    const named: Json = {};
    for (const name of factorNames) named[name] = str(levels[name]);
    return {
      arm: str(arm.arm_id),
      well: str(arm.well),
      run_order: num(arm.run_order) ?? '',
      ...named,
      temperature_c: num(arm.temperature_c) ?? '',
      time_h: num(arm.time_h) ?? '',
      solvent: str(arm.solvent),
      control: str(arm.control),
      replicate_of: str(arm.replicate_of),
      note: str(arm.note),
    };
  });
}

function ProtocolResult({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  const verdict = protocolVerdict(data);
  const designId = str(data.design_id);
  const checks = rows(data.checks);
  const blocking = new Set(strings(data.blocking));
  // Failed first, and blockers before the rest of them: a reader scanning a compact card sees the
  // thing that stops the design before the thing that merely qualifies it.
  const failing = checks
    .filter((check) => check.passed === false)
    .sort((a, b) => Number(blocking.has(str(b.check_id))) - Number(blocking.has(str(a.check_id))));
  const shownChecks = take(failing, compact, 3);

  const factorEntries = isObject(data.factors)
    ? Object.entries(data.factors).map(([name, levels]) => ({ name, levels: strings(levels) }))
    : [];
  const factorNames = factorEntries.map((entry) => entry.name);
  const records = armRecords(data, factorNames);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  const shownArms = take(records, compact, 4);
  const omitted = num(data.arms_omitted) ?? 0;
  const armCount = num(data.arm_count) ?? records.length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={verdict.tone}>{verdict.text}</Badge>
        <span className="text-2xs text-ink-subtle">
          revision {num(data.revision) ?? '—'} · {str(data.status) || 'unknown status'} · {armCount}{' '}
          arm{armCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* Always on the compact card: these checks read the document, not the chemistry. */}
      <p
        role="note"
        className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
      >
        These checks are structural: they test that the document is complete and self-consistent.
        Nothing blocking is <strong>not</strong> a finding that the experiment is safe or that it
        will answer the question — a hazard screen and a person are what decide that.
      </p>

      {failing.length > 0 && (
        <>
          <Table
            label="Checks this design did not pass"
            headers={['Severity', 'Check', 'What it found']}
            body={shownChecks.map((check, i) => (
              <tr key={`${str(check.check_id)}-${i}`}>
                <Cell>
                  <Badge tone={CHECK_TONE[str(check.severity)] ?? 'neutral'}>
                    {str(check.severity)}
                    {blocking.has(str(check.check_id)) && (
                      <span className="font-normal opacity-80">blocks</span>
                    )}
                  </Badge>
                </Cell>
                <Cell>
                  <span className="font-mono text-2xs break-all">{str(check.check_id)}</span>
                </Cell>
                <Cell>{str(check.detail)}</Cell>
              </tr>
            ))}
          />
          <Trimmed shown={shownChecks.length} total={failing.length} />
        </>
      )}

      {factorEntries.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            Factors
          </h3>
          <Table
            label="The factors this design varies, and their levels"
            headers={['Factor', 'Levels']}
            body={factorEntries.map((factor) => (
              <tr key={factor.name}>
                <Cell>{factor.name}</Cell>
                <Cell>
                  <span className="flex flex-wrap gap-1">
                    {factor.levels.map((level, i) => (
                      <Badge key={`${level}-${i}`} tone="neutral">
                        {level}
                      </Badge>
                    ))}
                  </span>
                </Cell>
              </tr>
            ))}
          />
        </div>
      )}

      {records.length > 0 && (
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">
              Arms, in run order
            </h3>
            {/* The CSV is on the compact card too (the run sheet goes to the bench). */}
            <DownloadCsv headers={headers} records={records} name={`${tool}-${designId}`} />
          </div>
          <Table
            label="The arms of this design, in run order"
            headers={headers}
            body={shownArms.map((record, i) => (
              <tr key={i}>
                {headers.map((header) => {
                  const value = record[header];
                  return typeof value === 'number' ? (
                    <Cell key={header} numeric>
                      {formatScientificNumber(value)}
                    </Cell>
                  ) : (
                    <Cell key={header}>{String(value ?? '')}</Cell>
                  );
                })}
              </tr>
            ))}
          />
          <Trimmed shown={shownArms.length} total={records.length} />
        </div>
      )}

      {/* What the service dropped before the card saw it, separate from what `Trimmed` reports. */}
      {omitted > 0 && (
        <p className="text-2xs text-ink-subtle">
          The service sent {records.length} of {armCount} arms with this result; {omitted} more are
          in the design itself.
        </p>
      )}

      {designId && (
        // A plain anchor, not a router `Link`: this registry imports no router so it renders
        // anywhere.
        <p className="text-sm">
          <a
            href={`/protocols/${designId}`}
            className="text-brand-ink underline underline-offset-2 focus-ring"
          >
            Open the full protocol
          </a>{' '}
          <span className="font-mono text-2xs text-ink-subtle">{designId}</span>
        </p>
      )}
    </>
  );
}

/**
 * A run of numbers whose shape is the reading (running best, scan profile). Labelled with the
 * service's key only; no unit is on the wire, so there is no axis unit.
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
 * A handful of named numbers (pKa, logD, ...). Keys printed as the service wrote them; no units and
 * no derived quantities (e.g. never `± sd`).
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
            <p className="font-mono text-base tabular-nums">{formatScientificNumber(value)}</p>
          </li>
        ))}
      </ul>
      <Trimmed shown={shown.length} total={all.length} />
    </>
  );
}

/**
 * Any list of flat records, so a new tool is legible without a renderer. Columns are the union of
 * keys; nested values are shown as JSON.
 */
function AutoTable({ data, tool, compact }: ResultViewProps): React.JSX.Element {
  const key = firstRecordList(data);
  const records = key ? rows(data[key]) : [];
  // Headers and CSV cover every record, not only those drawn.
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const cap = useCap(records.length, compact, 3, FULL_ROW_LIMIT);
  const shown = records.slice(0, cap.limit);
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
                    {formatScientificNumber(asNumber)}
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
      <Trimmed shown={shown.length} total={records.length} cap={cap} noun="row" csv={!compact} />
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

/** The calc store's files, in their own chunk (`CalcArtifacts.tsx`): not needed on first load. */
const CalcArtifactsChunk = lazy(() =>
  import('./CalcArtifacts.tsx').then((m) => ({ default: m.CalcArtifactsResult })),
);

function CalcArtifacts(props: ResultViewProps): React.JSX.Element {
  return (
    <Suspense fallback={<p className="text-xs text-ink-muted">Listing the files…</p>}>
      <CalcArtifactsChunk {...props} />
    </Suspense>
  );
}

/** The two calc-store tools whose rows are files (`list_artifacts`, `fetch_artifact`). */
const CALC_ARTIFACT_TOOLS = new Set(['list_artifacts', 'fetch_artifact']);

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
   * What the block header can say about the payload: a count or a state, never a judgement. Absent
   * for most shapes.
   */
  summary?: (data: Json) => { text: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' } | null;
  /**
   * Whether this renderer only displays the payload (generic; the sheet then also offers the raw
   * text) or models it (typed; no raw copy beside it).
   */
  generic: boolean;
}

/**
 * Whether this is a fingerprint search: a `hits` list of structures. By shape, not tool name; an
 * empty `hits` counts only with the search's own flags.
 */
function isStructureSearch(parsed: Json): boolean {
  if (!Array.isArray(parsed.hits)) return false;
  const hits = rows(parsed.hits);
  if (hits.length === 0) return 'index_empty' in parsed;
  return hits.every((hit) => mightBeStructure(str(hit.smiles) || str(hit.label)));
}

/*
 * ── The campaign renderers ── Keyed on tool name, because the three shapes share no field worth
 * dispatching on. Each carries a fact a table would lose: assay noise, a front with no single best
 * point, an extrapolation flag.
 */

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2">
      <dt className="text-2xs tracking-wide text-ink-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
      {note && <p className="mt-0.5 font-sans text-2xs text-ink-muted">{note}</p>}
    </div>
  );
}

/**
 * The scalar entries of a parameter assignment; other shapes are dropped rather than stringified.
 */
function paramEntries(params: Json): [string, string | number][] {
  return Object.entries(params).filter(
    (entry): entry is [string, string | number] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number',
  );
}

/** The same assignment as one line of text — a chart mark's tooltip, where no markup is allowed. */
const paramText = (params: Json): string =>
  paramEntries(params)
    .map(([name, value]) => `${name} ${typeof value === 'number' ? sig(value) : value}`)
    .join(', ');

/** A parameter assignment — the conditions of one run, candidate or prediction. */
function ParamList({ params }: { params: Json }): React.JSX.Element {
  const entries = paramEntries(params);
  if (entries.length === 0) return <span className="text-ink-muted">no conditions stated</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.map(([name, value]) => (
        <span key={name} className="whitespace-nowrap">
          <span className="text-2xs text-ink-subtle">{name}</span>{' '}
          <span className="font-mono tabular-nums">
            {typeof value === 'number' ? sig(value) : value}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * A value and the surrogate's spread around it, as one figure (`predicted_sd` qualifies the value).
 * No units are on the wire; the objective's name labels it.
 */
function ValueWithSd({
  value,
  sd,
}: {
  value: number | null;
  sd: number | null;
}): React.JSX.Element {
  if (value === null) return <span className="text-ink-muted">—</span>;
  return (
    <span className="font-mono whitespace-nowrap tabular-nums">
      {sig(value)}
      {sd !== null && <span className="text-ink-muted"> ± {sig(sd)}</span>}
    </span>
  );
}

/** What one objective did across the runs supplied — `ObjectiveScale`, in the shape this file reads. */
interface ObjectiveScale {
  name: string;
  direction: string;
  n: number;
  min: number | null;
  max: number | null;
}

/**
 * The result's objective scales, lead first (`scales` wins over `scale`). `spread` is recomputed
 * here: upstream it is a plain property, not serialized.
 */
function scalesOf(data: Json): ObjectiveScale[] {
  const raw = rows(data.scales);
  const source = raw.length > 0 ? raw : isObject(data.scale) ? [data.scale] : [];
  return source.map((scale) => ({
    name: str(scale.name),
    direction: str(scale.direction),
    n: num(scale.n) ?? 0,
    min: num(scale.observed_min),
    max: num(scale.observed_max),
  }));
}

/** Observed max minus min, or null where fewer than two runs give it a meaning. */
const spreadOf = (scale: ObjectiveScale): number | null =>
  scale.min === null || scale.max === null ? null : scale.max - scale.min;

/**
 * One objective's value from an observation: `values[objective]`, or the scalar `value` for the
 * lead objective in single-objective runs (mirrors the backend's `observed_value`).
 */
function observedValue(observation: Json, objective: string, lead: string): number | null {
  const values = isObject(observation.values) ? observation.values : {};
  const named = num(values[objective]);
  if (named !== null) return named;
  return objective === lead ? num(observation.value) : null;
}

/** What the surrogate said about one candidate, one entry per objective it spoke about. */
function predictedOf(
  candidate: Json,
  scales: ObjectiveScale[],
): { name: string; value: number | null; sd: number | null }[] {
  const values = isObject(candidate.predicted_values) ? candidate.predicted_values : {};
  const sds = isObject(candidate.predicted_sds) ? candidate.predicted_sds : {};
  const named = scales.filter((scale) => scale.name in values);
  if (named.length > 0) {
    return named.map((scale) => ({
      name: scale.name,
      value: num(values[scale.name]),
      sd: num(sds[scale.name]),
    }));
  }
  return [
    {
      name: scales[0]?.name || 'objective',
      value: num(candidate.predicted_value),
      sd: num(candidate.predicted_sd),
    },
  ];
}

/**
 * `campaign_progress`: has the optimization stopped finding anything? The plateau verdict is a chip
 * with three states — withheld (`enough_observations: false`), plateaued, not plateaued — never
 * two.
 */
function CampaignProgressReading({ data }: ResultViewProps): React.JSX.Element {
  const series = Array.isArray(data.best_so_far)
    ? data.best_so_far.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];
  const noise = num(data.assay_noise);
  const best = num(data.best_value);
  const enough = data.enough_observations === true;
  const plateaued = data.plateaued === true;
  const objective = str(data.objective) || 'the objective';
  const direction = str(data.direction);
  const observations = num(data.n_observations) ?? 0;
  const distinct = num(data.n_distinct);
  const inSpace = num(data.n_distinct_in_space);
  const designSpace = num(data.design_space);
  const since = num(data.evaluations_since_improvement);
  const windowSize = num(data.window);
  const windowSpan = num(data.window_span);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* "Not plateaued", not "Still improving": the absence of a plateau finding is not a progress finding. The `since` count is in the stats below. */}
        {!enough ? (
          <Badge tone="neutral">Plateau verdict withheld</Badge>
        ) : plateaued ? (
          <Badge tone="warn">Plateaued</Badge>
        ) : (
          <Badge tone="ok">Not plateaued</Badge>
        )}
        {noise !== null && (
          <span className="text-2xs text-ink-subtle">judged against ±{sig(noise)} assay noise</span>
        )}
      </div>

      {!enough && (
        <p
          role="note"
          className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
        >
          {observations} evaluation(s) is too few to read a trend from, so no plateau verdict is
          given. That is <strong>not</strong> a finding that the campaign is still improving — it is
          the absence of a finding either way.
        </p>
      )}

      {series.length > 0 && noise !== null && best !== null && (
        <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
          <BestSoFarChart
            series={series}
            objective={objective}
            direction={direction}
            noise={noise}
            best={best}
          />
          <p className="mt-1 text-2xs text-ink-muted">
            The shaded band is ±{sig(noise)} — the assay reproducibility you stated. A result inside
            it is not distinguishable from the best already in hand.
          </p>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Evaluations" value={observations} />
        {/* The ratio uses `n_distinct_in_space` (conditions in the feasible grid) over `design_space`; `n_distinct` can exceed it when an exclusion was added after a run. Without that field (older service) only the bare count is shown. */}
        <Stat
          label="Distinct conditions"
          value={
            designSpace === null || inSpace === null
              ? (distinct ?? '—')
              : `${inSpace} / ${designSpace}`
          }
          note={
            designSpace === null
              ? 'the grid is infinite — a continuous parameter'
              : inSpace === null
                ? 'distinct conditions run'
                : distinct !== null && distinct > inSpace
                  ? `of the feasible grid — ${distinct - inSpace} further run(s) are outside it, excluded by a constraint`
                  : 'of the feasible grid'
          }
        />
        <Stat
          label="Since a real gain"
          value={since ?? '—'}
          note={`evaluation(s) since a gain beat the noise`}
        />
        {windowSpan !== null && windowSize !== null && (
          <Stat
            label={`Last ${windowSize} span`}
            value={sig(windowSpan)}
            note={
              data.window_indistinguishable === true
                ? 'inside the noise — these results are not distinguishable'
                : 'wider than the noise — these results do differ'
            }
          />
        )}
      </dl>
    </>
  );
}

/**
 * `suggest_next_experiment`: the proposed experiments and the trade-off.
 *
 * - `opened_new_campaign` is shown first: the history is now split across two campaigns.
 * - The front is drawn as a scatter only for exactly two objectives; for three or more the table is
 *   the answer (a 2-D scatter would drop an axis).
 * - Dominated runs are not in the payload; their count is stated, and axes span the full observed
 *   range.
 */
function SuggestionResult({ data }: ResultViewProps): React.JSX.Element {
  const candidates = rows(data.candidates);
  const scales = scalesOf(data);
  const lead = scales[0];
  // The second axis of a two-objective scatter, bound once so the scatter's guard and its props
  // are the same check. Undefined for one objective, and irrelevant for three or more.
  const second = scales[1];
  const front = rows(data.front);
  const supplied = lead?.n ?? 0;
  const campaignId = str(data.campaign_id);
  const calcRefs = Array.isArray(data.calc_refs) ? data.calc_refs.map(String) : [];
  const tolerance = num(data.front_tolerance);

  // One entry per front member, read once: the scatter, the table and the mark tooltips all
  // describe the same runs, so deriving them twice is how the two drift apart.
  const frontPoints = front.map((observation) => {
    const params = isObject(observation.params) ? observation.params : {};
    return {
      label: paramText(params) || 'conditions not stated',
      values: scales.map((scale) => observedValue(observation, scale.name, lead?.name ?? '')),
      params,
    };
  });

  return (
    <>
      {data.opened_new_campaign === true && (
        <p
          role="alert"
          className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
        >
          These runs were supplied against a decision space this system has never been asked about,
          so a <strong>new campaign was opened</strong> rather than an existing one continued. That
          is usually a space that drifted — an option added, a bound moved — and the history is now
          split across two campaigns. Confirm which campaign was meant before acting on these
          candidates.
        </p>
      )}

      <div>
        <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
          Proposed experiments
        </h3>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-muted">No candidate was proposed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate, index) => {
              const predicted = predictedOf(candidate, scales);
              // A seed has no predicted value. Keyed on `value`, not `sd`, since upstream fills
              // them independently.
              const isSeed = predicted.every((entry) => entry.value === null);
              return (
                <li
                  key={index}
                  className="rounded-lg border border-border-subtle bg-surface-raised p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-2xs tracking-wide text-ink-subtle uppercase">
                      Candidate {index + 1}
                    </span>
                    {isSeed && (
                      <Badge tone="neutral">space-filling seed · no surrogate opinion</Badge>
                    )}
                  </div>

                  <div className="mt-1.5 text-sm">
                    <ParamList params={isObject(candidate.params) ? candidate.params : {}} />
                  </div>

                  {!isSeed && (
                    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                      {predicted.map((entry) => {
                        const scale = scales.find((s) => s.name === entry.name);
                        return (
                          <div key={entry.name}>
                            <dt className="text-2xs text-ink-subtle">
                              predicted {entry.name}
                              {scale?.direction ? ` (${scale.direction})` : ''}
                            </dt>
                            <dd className="text-sm">
                              <ValueWithSd value={entry.value} sd={entry.sd} />
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {scales.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            What the runs supplied span
          </h3>
          <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
            {scales.map((scale) => {
              const spread = spreadOf(scale);
              return (
                <li key={scale.name}>
                  <span className="text-ink">{scale.name}</span> ({scale.direction}) —{' '}
                  {scale.n === 0
                    ? 'no runs supplied, so a ± beside a candidate has nothing to be read against'
                    : spread === null
                      ? `${scale.n} run(s)`
                      : `${scale.n} run(s) spanning ${sig(scale.min ?? 0)} to ${sig(scale.max ?? 0)} (${sig(spread)})`}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {scales.length > 1 && (
        <div>
          <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            Trade-off front
          </h3>

          {front.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No front: nothing has been measured against these {scales.length} objectives yet.
            </p>
          ) : (
            <>
              {scales.length === 2 && lead && second ? (
                <div className="rounded-lg border border-border-subtle bg-surface-raised p-3">
                  <ParetoScatter
                    x={{
                      name: lead.name,
                      direction: lead.direction,
                      min: lead.min ?? 0,
                      max: lead.max ?? 1,
                    }}
                    y={{
                      name: second.name,
                      direction: second.direction,
                      min: second.min ?? 0,
                      max: second.max ?? 1,
                    }}
                    points={frontPoints
                      .filter((p) => p.values[0] !== null && p.values[1] !== null)
                      .map((p) => ({ x: p.values[0] ?? 0, y: p.values[1] ?? 0, label: p.label }))}
                  />
                </div>
              ) : (
                <p
                  role="note"
                  className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-xs"
                >
                  {scales.length} objectives cannot be drawn as a two-axis scatter without dropping
                  one of them, and a reader cannot see that it happened. The front is listed
                  instead.
                </p>
              )}

              <div className="mt-2">
                <Table
                  label="Runs on the trade-off front"
                  headers={['Front', ...scales.map((scale) => scale.name), 'Conditions']}
                  body={frontPoints.map((point, index) => (
                    <tr key={index}>
                      <Cell>
                        <Badge tone="brand">on the front</Badge>
                      </Cell>
                      {point.values.map((value, axis) => (
                        <Cell key={scales[axis]?.name ?? axis} numeric>
                          {value === null ? '—' : sig(value)}
                        </Cell>
                      ))}
                      <Cell>
                        <ParamList params={point.params} />
                      </Cell>
                    </tr>
                  ))}
                />
              </div>

              <p className="mt-1.5 text-2xs text-ink-muted">
                {front.length} of the {supplied} run(s) supplied are on the front
                {supplied > front.length
                  ? ` — the other ${supplied - front.length} are beaten on every objective at once, and this result does not carry them`
                  : ''}
                .{' '}
                {tolerance === null
                  ? 'Drawn at exact precision: every numeric difference counted as real.'
                  : `Runs differing by ${sig(tolerance)} or less were treated as indistinguishable.`}
              </p>
            </>
          )}
        </div>
      )}

      {campaignId && (
        <p className="text-2xs text-ink-muted">
          Campaign{' '}
          <span className="font-mono text-ink" title="Quote this to continue the same campaign">
            {campaignId}
          </span>
          {calcRefs.length > 0 && ` · ${calcRefs.length} calculation(s) behind the decision space`}
        </p>
      )}
    </>
  );
}

/**
 * `predict_outcome`: the model's expectation at a named point. `in_domain: false` is shown as an
 * alert — an extrapolation reads like any other number. Each prediction's own summary is rendered
 * with it.
 */
function SurrogateAnswerResult({ data }: ResultViewProps): React.JSX.Element {
  const predictions = rows(data.predictions);
  const fit = rows(data.fit);

  return (
    <>
      <div>
        <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
          Predictions
        </h3>
        {predictions.length === 0 ? (
          <p className="text-sm text-ink-muted">No point was predicted.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {predictions.map((prediction, index) => {
              const inDomain = prediction.in_domain !== false;
              const values = isObject(prediction.values) ? prediction.values : {};
              const sds = isObject(prediction.sds) ? prediction.sds : {};
              return (
                <li
                  key={index}
                  className={
                    inDomain
                      ? 'rounded-lg border border-border-subtle bg-surface-raised p-3'
                      : 'rounded-lg border border-warn/40 bg-warn-soft p-3'
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">
                      <ParamList params={isObject(prediction.params) ? prediction.params : {}} />
                    </span>
                    <Badge tone={inDomain ? 'neutral' : 'warn'}>
                      {inDomain ? 'inside the declared space' : 'extrapolation'}
                    </Badge>
                  </div>

                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                    {Object.keys(values)
                      .sort()
                      .map((name) => (
                        <div key={name}>
                          <dt className="text-2xs text-ink-subtle">{name}</dt>
                          <dd className="text-sm">
                            <ValueWithSd value={num(values[name])} sd={num(sds[name])} />
                          </dd>
                        </div>
                      ))}
                  </dl>

                  {!inDomain && (
                    <p role="alert" className="mt-2 text-xs text-warn-ink">
                      This point is <strong>outside the declared range</strong>, so the model is
                      extrapolating: nothing constrains the mean, and the widened ± is the only part
                      of this prediction that is honest about that.
                    </p>
                  )}

                  {str(prediction.summary) && (
                    <p className="mt-1.5 text-2xs text-ink-muted">{str(prediction.summary)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {fit.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-2xs font-medium tracking-wide text-ink-subtle uppercase">
            How well this surrogate predicts held-out runs
          </h3>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {fit.map((quality, index) => (
              <Stat
                key={index}
                label={str(quality.objective) || 'objective'}
                value={`R² ${num(quality.r2)?.toFixed(2) ?? '—'}`}
                note={`MAE ${num(quality.mae)?.toPrecision(2) ?? '—'} · ${num(quality.folds) ?? '—'} folds over ${num(quality.n_observations) ?? '—'} run(s)`}
              />
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

/**
 * The registry, in priority order. The two name-keyed entries come first because their shapes are
 * ambiguous; the rest key on the payload.
 */
const RENDERERS: (ResultRenderer & { matches: (tool: string, data: Json) => boolean })[] = [
  {
    id: 'calc-artifacts',
    generic: false,
    title: () => 'Calculation files',
    wide: true,
    // Name-keyed, and first: `fetch_artifact`'s single object is a `values` strip by shape (one
    // `byte_size`), and a file whose only rendering is its size is the dead end C4 recorded.
    matches: (tool) => CALC_ARTIFACT_TOOLS.has(tool),
    View: CalcArtifacts,
  },
  {
    id: 'campaign',
    generic: false,
    title: () => 'Campaign progress',
    wide: true,
    summary: (data) =>
      // Three states, never two: `false` with too few observations means "not asked yet".
      data.enough_observations === false
        ? { text: 'too few runs to say', tone: 'neutral' }
        : data.plateaued === true
          ? { text: 'plateaued', tone: 'warn' }
          : data.plateaued === false
            ? { text: 'still improving', tone: 'ok' }
            : null,
    matches: (tool) => tool === 'campaign_progress',
    View: CampaignProgressReading,
  },
  {
    id: 'proposals',
    generic: false,
    title: () => 'Proposed experiments',
    wide: true,
    summary: (data) => {
      const n = rows(data.candidates).length;
      return n > 0 ? { text: `${n} candidate${n === 1 ? '' : 's'}`, tone: 'neutral' } : null;
    },
    matches: (tool) => tool === 'suggest_next_experiment',
    View: SuggestionResult,
  },
  {
    id: 'prediction',
    generic: false,
    title: () => 'Predicted outcome',
    wide: true,
    // An extrapolation reads identically to an interpolation unless flagged.
    summary: (data) => (data.in_domain === false ? { text: 'extrapolated', tone: 'warn' } : null),
    matches: (tool) => tool === 'predict_outcome',
    View: SurrogateAnswerResult,
  },
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
    // Name-keyed: an ordered record list and a plain one have the same shape.
    matches: (tool, data) => tool === 'generate_screening_design' && !!firstRecordList(data),
    View: RunSheet,
  },
  {
    id: 'protocol',
    generic: false,
    title: () => 'Experiment protocol',
    wide: true,
    summary: protocolVerdict,
    // Shape-keyed (`design_id` + `checks` + `summary` together are a receipt), and above
    // `series`/`values`/`table` so a receipt never falls through to the generic table.
    matches: (_tool, data) => 'design_id' in data && 'checks' in data && 'summary' in data,
    View: ProtocolResult,
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
 * Which renderer draws this result, and the data to hand it; `null` means show the raw text. A bare
 * top-level array is wrapped so every renderer gets an object.
 */
export function rendererFor(
  tool: string,
  parsed: unknown,
): { renderer: ResultRenderer; data: Json } | null {
  if (Array.isArray(parsed)) {
    const records = rows(parsed);
    if (records.length !== parsed.length) return null;
    // `list_artifacts` answers with a bare list, and an empty one is its real answer ("this
    // calculation kept no files"), so it is claimed before the generic list's emptiness check.
    if (CALC_ARTIFACT_TOOLS.has(tool)) {
      return { renderer: RENDERERS[0]!, data: { items: records } };
    }
    if (records.length === 0) return null;
    return { renderer: BARE_LIST, data: { items: records } };
  }
  if (!isObject(parsed)) return null;
  const found = RENDERERS.find((r) => r.matches(tool, parsed));
  return found ? { renderer: found, data: parsed } : null;
}
