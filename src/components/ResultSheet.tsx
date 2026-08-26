/**
 * What a tool actually returned, rather than the model's paraphrase of it.
 *
 * `ToolResultEvent.preview` is 200 characters and the service says it will stay that way — "never
 * a whole evidence sweep streamed to a browser". So the event carries a content-addressed
 * reference and this panel pulls the one result a reader asked for, through
 * `GET /sessions/{id}/tool-results/{ref}`.
 *
 * Two rules shape everything below, and both come from the service rather than from taste.
 *
 * **`text` is not promised to be JSON.** Upstream types it as text on purpose: a tool result is
 * whatever the framework handed back, and a store that promised JSON would have to fail or lie
 * about the ones that are not. So every renderer parses defensively and the fallback is the raw
 * text, never an error.
 *
 * **A `verdict` or `summary` renders before the data it qualifies.** Several of these results
 * carry one, and it is load-bearing in a way that is easy to lose: an empty `flags` list means
 * "no rule matched", which is explicitly *not* a clearance; an empty fingerprint hit list can mean
 * "the index is empty" rather than "no analogue exists". A table with nothing in it reads as
 * "nothing found" unless the sentence above it says otherwise.
 *
 * The typed renderers cover the results where a table changes a decision. Everything else falls
 * through to a generic table when the shape allows and to raw text when it does not — which is
 * still strictly more than the 200 characters this panel replaces.
 *
 * One of them is keyed on **shape** rather than on tool name: `StructureHits`, for the three
 * searches whose entire output is structures. They used to fall through to the generic table, so
 * the one question a bench chemist asks that is purely about chemistry answered with a column of
 * SMILES strings.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.tsx';
import { api, type StoredToolResult } from '../api/client.ts';
import { toolLabel } from '../lib/format.ts';
import { Molecule } from './Molecule.tsx';
import { UseStructure } from '@/components/chem/UseStructure';
import { mightBeStructure } from '../chem/structure.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { EmptyState, Loading } from '@/components/chem/Feedback';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: StoredToolResult }
  | { status: 'failed'; message: string };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rows = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

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
 * quote or a newline is quoted, and an embedded quote is doubled. A run sheet retyped into Excel
 * by hand is where the transcription error enters a campaign, and a chemist handed a markdown
 * table has no other option.
 */
function toCsv(headers: string[], records: Json[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...records.map((r) => headers.map((h) => cell(r[h])).join(','))].join(
    '\r\n',
  );
}

function DownloadCsv({
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

/**
 * `screen_hazards` and `screen_genotoxic_alerts` — a severity table with its citations.
 *
 * The caveat is pinned above the table and rendered whether or not anything matched, because the
 * dangerous reading of this result is the empty one. The service says it in the payload for the
 * same reason; repeating it here is not redundancy, it is the sentence the chemist acts on.
 */
function HazardScreen({ data, onUsed }: { data: Json; onUsed: () => void }): React.JSX.Element {
  const flags = rows(data.flags);
  const screened = Array.isArray(data.screened) ? data.screened.map(String) : [];

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
            {screened.map((smiles) => (
              <li key={smiles} className="flex flex-col items-end gap-1">
                <Molecule smiles={smiles} maxWidth={180} />
                <UseStructure smiles={smiles} onUsed={onUsed} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {flags.length === 0 ? (
        <p className="text-sm text-ink-muted">No rule in the table matched what was screened.</p>
      ) : (
        <Table
          label="Hazard rules that matched"
          headers={['Severity', 'Rule', 'Matched', 'Why', 'Citation']}
          body={flags.map((flag, i) => (
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
      )}
    </>
  );
}

/**
 * `ich_impurity_limit` — the number, and the guideline it is a number *from*.
 *
 * The provenance is the whole point of this renderer. This table was added to the service to end
 * a measured failure where a palladium PDE was recited from training as though it were the
 * record; a limit shown without its guideline, revision and table is that failure again with an
 * extra step. A miss is shown as a miss for the same reason.
 */
function ImpurityLimit({ data }: { data: Json }): React.JSX.Element {
  const limit = isObject(data.limit) ? data.limit : null;
  if (!limit) {
    return (
      <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-sm">
        No transcribed row for <span className="font-mono">{str(data.query)}</span>. That means this
        service has no limit on file — <strong>not</strong> that no limit exists.
      </p>
    );
  }
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
        body={rows(limit.limits).map((row, i) => (
          <tr key={`${str(row.basis)}-${i}`}>
            <Cell>{str(row.basis)}</Cell>
            <Cell numeric>{num(row.value)?.toLocaleString() ?? '—'}</Cell>
            <Cell>{str(row.unit)}</Cell>
          </tr>
        ))}
      />

      <p className="text-2xs text-ink-muted">
        {str(limit.guideline)} · {str(limit.citation)}
      </p>
    </>
  );
}

/**
 * `stoichiometry_table` — the charge table, with what it could not resolve stated.
 *
 * **Each row draws its species.** `ChargeRow` has carried `smiles` all along and this renderer read
 * every other field of it, so the one column saying *what* you are weighing out was on the wire and
 * dropped. This is the table a chemist reads at the bench while charging a vessel, and it is the
 * one where confusing two species has a physical consequence — a name is what a reagent is called,
 * a structure is what it is.
 *
 * Drawn small and inside the species cell rather than in a column of its own: a full-size depiction
 * per row would make a ten-reagent table taller than the sheet, and the structure belongs beside
 * the name it qualifies rather than at the other end of seven columns.
 */
function ChargeTable({ data }: { data: Json }): React.JSX.Element {
  const unresolved = Array.isArray(data.unresolved) ? data.unresolved.map(String) : [];
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

      <Table
        label="Charge table"
        headers={['Species', 'Role', 'Equiv', 'MW', 'mmol', 'Mass (g)', 'Volume (mL)']}
        body={rows(data.rows).map((row, i) => (
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
    </>
  );
}

/**
 * A search whose answer *is* structures — `similar_molecules`, `substructure_matches`,
 * `similar_reactions`.
 *
 * These three were the sharpest gap in this panel. Their entire output is chemistry, and they fell
 * through to `AutoTable`, which rendered a note id, a SMILES and a decimal as three text cells. The
 * one question a bench chemist asks that is purely about structures — "have we made anything like
 * this" — was answered with a table of strings.
 *
 * ## Keyed on shape, with two field names
 *
 * `docs/chemistry-aware-frontend.md` predicted the renderers should key on result *shape* rather
 * than on tool name, and that held for the four already here. It holds for this one too, with one
 * concession: the two fingerprint domains spell the same two fields differently, because their hits
 * are genuinely different models upstream — `MoleculeHit` carries `smiles` and cites a compound
 * note, `Match` carries `label` and an index id the reaction tool rewrites into a note id. So the
 * shape test is "a `hits` array whose rows carry a structure-shaped string", and the alias table is
 * two entries rather than a tool list that would need editing for the next search tool.
 *
 * ## The empty result is the dangerous one, and it is not this component's to interpret
 *
 * `FingerprintSearch` exists so that "we have no precedent for this structure" and "nothing has
 * been indexed" cannot arrive as the same empty list — a live run answered `{"result": []}` off an
 * unbackfilled index and it was read as "we have never made anything like this". The payload
 * carries `verdict` as a computed field for exactly that reason, and `<Verdict>` above renders it
 * verbatim.
 *
 * So this renders the flags rather than re-deriving a sentence from them. Writing our own "no
 * analogue found" here would be the same failure with a nicer typeface: the service already says
 * the true thing, and a second, softer sentence beside it is the one a reader would believe.
 */
function StructureHits({
  data,
  tool,
  onUsed,
}: {
  data: Json;
  tool: string;
  onUsed: () => void;
}): React.JSX.Element {
  const hits = rows(data.hits);
  const subject = str(data.subject) || 'record';
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
        // No sentence of our own. `<Verdict>` above carries the service's, which distinguishes the
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

          <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {hits.map((hit, i) => {
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
                    <span className="font-mono text-2xs break-all">{'\u2014'}</span>
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
        </>
      )}
    </>
  );
}

/**
 * Anything shaped like a list of flat records, whatever produced it.
 *
 * Deliberately generic. The alternative — a renderer per tool — means every new tool on the
 * service is invisible here until someone writes one, and there are roughly fifty. Columns come
 * from the union of the keys present, so a tool that adds a field shows it without a change here.
 * Nested values are not flattened: they are shown as JSON in the cell, which is worse than a real
 * renderer and much better than hiding them.
 */
function AutoTable({ records, tool }: { records: Json[]; tool: string }): React.JSX.Element {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return (
    <>
      <div className="flex justify-end">
        <DownloadCsv headers={headers} records={records} name={tool} />
      </div>
      <Table
        label="The tool's result, as a table"
        headers={headers}
        body={records.map((record, i) => (
          <tr key={i}>
            {headers.map((key) => {
              const value = record[key];
              const asNumber = num(value);
              if (asNumber !== null)
                return (
                  <Cell key={key} numeric>
                    {asNumber.toLocaleString()}
                  </Cell>
                );
              if (typeof value === 'string' || typeof value === 'boolean')
                return <Cell key={key}>{String(value)}</Cell>;
              if (value === undefined || value === null) return <Cell key={key}>—</Cell>;
              return (
                <Cell key={key}>
                  <span className="font-mono text-2xs">{JSON.stringify(value)}</span>
                </Cell>
              );
            })}
          </tr>
        ))}
      />
    </>
  );
}

/** The floor: exactly what the tool returned, unparsed. Still the whole thing, not 200 chars. */
function RawText({ text }: { text: string }): React.JSX.Element {
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label="The tool's full output"
      className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap focus-ring"
    >
      {text}
    </pre>
  );
}

/** The one sentence that qualifies everything under it, when the result carries one. */
function Verdict({ data }: { data: Json }): React.JSX.Element | null {
  const line = str(data.verdict) || str(data.summary);
  if (!line) return null;
  return <p className="text-sm font-medium">{line}</p>;
}

/**
 * Is this a fingerprint search — a `hits` list whose rows carry a structure?
 *
 * Shape, not tool name, so a fourth search tool renders without an edit here. The structure test is
 * syntactic on purpose: `Molecule` is the arbiter and shows the string it refused rather than an
 * empty box, so a row whose label is not really a structure degrades to visible text rather than to
 * a lie. What this must not do is claim a `hits` list of something else — a job listing, a set of
 * candidates — so an empty `hits` array only counts when the payload also carries the fingerprint
 * search's own flags.
 */
function isStructureSearch(parsed: Json): boolean {
  if (!Array.isArray(parsed.hits)) return false;
  const hits = rows(parsed.hits);
  if (hits.length === 0) return 'index_empty' in parsed;
  return hits.every((hit) => mightBeStructure(str(hit.smiles) || str(hit.label)));
}

function Body({
  result,
  onUsed,
}: {
  result: StoredToolResult;
  /** Called when a structure in here was put into the message — the sheet closes, because the
   *  message being edited is behind it. */
  onUsed: () => void;
}): React.JSX.Element {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return <RawText text={result.text} />;
  }

  // A bare list, which several search tools return at the top level.
  if (Array.isArray(parsed)) {
    const records = rows(parsed);
    return records.length === parsed.length && records.length > 0 ? (
      <AutoTable records={records} tool={result.tool} />
    ) : (
      <RawText text={result.text} />
    );
  }

  if (!isObject(parsed)) return <RawText text={result.text} />;

  const typed =
    result.tool === 'screen_hazards' || result.tool === 'screen_genotoxic_alerts' ? (
      <HazardScreen data={parsed} onUsed={onUsed} />
    ) : result.tool === 'ich_impurity_limit' ? (
      <ImpurityLimit data={parsed} />
    ) : result.tool === 'stoichiometry_table' ? (
      <ChargeTable data={parsed} />
    ) : isStructureSearch(parsed) ? (
      <StructureHits data={parsed} tool={result.tool} onUsed={onUsed} />
    ) : null;

  if (typed) {
    return (
      <>
        <Verdict data={parsed} />
        {typed}
      </>
    );
  }

  // No typed renderer: show the verdict, then the first list of records the object holds, then
  // the raw text underneath so nothing the generic pass could not model is silently dropped.
  const listKey = Object.keys(parsed).find((k) => rows(parsed[k]).length > 0);
  return (
    <>
      <Verdict data={parsed} />
      {listKey && <AutoTable records={rows(parsed[listKey])} tool={result.tool} />}
      <details className="group">
        <summary className="tap-target cursor-pointer list-none rounded-sm text-2xs text-ink-muted hover:text-ink focus-ring">
          Everything the tool returned
        </summary>
        <div className="mt-1.5">
          <RawText text={result.text} />
        </div>
      </details>
    </>
  );
}

export function ResultSheet({
  sessionId,
  resultRef,
  tool,
  open,
  onOpenChange,
}: {
  sessionId: string;
  resultRef: string;
  tool: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [state, setState] = useState<State>({ status: 'idle' });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (open && loadedFor !== resultRef) {
    setLoadedFor(resultRef);
    setState({ status: 'loading' });
    api
      .getToolResult(sessionId, resultRef, auth)
      .then((result) => setState({ status: 'ready', result }))
      .catch((err: unknown) =>
        setState({
          status: 'failed',
          message: err instanceof Error ? err.message : 'Could not read that result.',
        }),
      );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title={`${toolLabel(tool)} — full result`}
        className="w-[min(48rem,95vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <h2 className="font-medium">{toolLabel(tool)}</h2>
            <p className="font-mono text-2xs text-ink-subtle">{tool}</p>
          </div>

          {state.status === 'loading' && <Loading>Reading the full result…</Loading>}

          {state.status === 'failed' && (
            <EmptyState title="That result could not be read">
              {state.message} Stored results are retained for a limited time, so an old turn’s
              result may no longer be there.
            </EmptyState>
          )}

          {state.status === 'ready' && (
            <>
              <Body result={state.result} onUsed={() => onOpenChange(false)} />
              {/* The join a GxP reviewer asks for, and the one a reference alone cannot make. */}
              <p className="border-t border-border-subtle pt-3 text-2xs text-ink-subtle">
                {state.result.byte_size.toLocaleString()} bytes · correlation{' '}
                <span className="font-mono">{state.result.correlation_id || 'not recorded'}</span>
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
