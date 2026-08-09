/**
 * Deciding what a tool result *is*, from the result rather than from the tool that produced it.
 *
 * The study that asked for these cards also named the way they go wrong: a renderer per tool is a
 * fifteen-card treadmill, and the backend has thirty-seven tools. So the unit here is the **shape**
 * of a result — "a list of cited flags", "a ranked comparison", "a table of rows", "a value with
 * an uncertainty" — which is four renderers covering eleven tools, and covers a twelfth the day a
 * connector returns one of those shapes from a tool this file has never heard of.
 *
 * **Detection is structural wherever structure can carry it.** A `ScreenResult` is recognised by
 * having an array of objects that each carry an explanation, a citation and what they matched;
 * nothing consults the tool name to reach that conclusion, so `screen_hazards` and
 * `screen_genotoxic_alerts` are one detector rather than two entries in a table.
 *
 * **One place keys off the tool name, and it is marked.** `VALUE_FIELDS` exists because a scalar
 * result cannot be recognised structurally without guessing: `{"pka": 4.76, "uncertainty": 0.6}`
 * and `{"log_s_mol_per_l": -2.1, "uncertainty_log": 0.75}` share no field, and a rule like "the
 * number next to the field called uncertainty" would pair `uncertainty_log` with whichever key
 * happened to sort first. A tool absent from that map falls through to the next detector and then
 * to the raw preview — it never renders as a value with a guessed unit.
 *
 * **Every field is probed.** The payload crossed a process boundary and arrived as text; a shape
 * that does not hold up returns `null` from its detector and the caller shows the `<pre>` it
 * already had. Nothing here throws, and nothing here fills a missing field with a plausible value:
 * a hazard card that invented a severity, or a charge table that quietly dropped a row it could
 * not read, would be worse than no card at all.
 */

import { resultCandidates } from '../../chem/results.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** Finite only. JSON gives `null` for a non-finite float, and `Number(null)` is 0 — a value the
 *  tool never returned, rendered as if it had. */
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

/**
 * A number as a chemist would read it back.
 *
 * Six significant digits rather than a fixed decimal count, because one card shows a pKa (two
 * digits mean something), a Hartree (six do) and a mass in grams. Rounding to a fixed width would
 * be this module inventing a precision claim the calculator never made.
 */
export const formatNumber = (value: number): string =>
  value.toLocaleString(undefined, { maximumSignificantDigits: 6 });

/** A signed difference, where the sign is half the information (a bias, a ΔΔG, a residual). */
export const formatSigned = (value: number): string =>
  `${value > 0 ? '+' : ''}${formatNumber(value)}`;

// ---------------------------------------------------------------------------------------------
// A list of cited flags — `screen_hazards`, `screen_genotoxic_alerts`.
// ---------------------------------------------------------------------------------------------

export type Severity = 'high' | 'medium' | 'low';

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const severityOf = (value: unknown): Severity | null =>
  value === 'high' || value === 'medium' || value === 'low' ? value : null;

export interface CitedFlag {
  /** `rule_id` or `alert_id` — what fired, quotable back at the rule table. */
  id: string;
  /**
   * `null` for a genotoxicity alert, and deliberately not defaulted to anything.
   *
   * `GenotoxAlert` has no severity because ranking published alert sets would be the first half of
   * a classification the tables do not make. A card that filled the gap with "low" would be making
   * that classification on the backend's behalf, in the softening direction.
   */
  severity: Severity | null;
  /** The alert's motif name, when it has one. Not a SMARTS pattern — a chemist's name for it. */
  motif: string | null;
  explanation: string;
  citation: string;
  /** The input this rule fired on: one structure, or `"a + b"` for an incompatibility pair. */
  matched: string;
  /**
   * The SMARTS the rule matched, if the result ever carries one.
   *
   * **Not on the wire today.** `HazardFlag` is `rule_id`, `severity`, `explanation`, `citation`,
   * `matched` — the pattern stays in the rule table (`_StructuralRule.smarts`) and is not echoed.
   * It is probed rather than assumed because drawing *where* on the molecule an alert fired is the
   * difference between a citation a chemist can check and one they must take on faith, and the day
   * the backend echoes it this lights up with no other change. Until then nothing is highlighted,
   * because a fabricated motif drawn on a real structure is worse than an undecorated structure.
   */
  smarts: string | null;
}

export interface CitedFlagList {
  kind: 'cited-flags';
  /** Which of the two screens this is, decided by which key carried the list. */
  subject: 'hazard' | 'genotox';
  flags: CitedFlag[];
  /** The canonical SMILES of everything the screen looked at — including on a clean result, which
   *  is the case it was added for: `{"flags": []}` named nothing it had screened. */
  screened: string[];
  /** The backend's own one-line summary. Rendered verbatim: on an empty result it is the sentence
   *  that stops "no rule matched" being read as a clearance. */
  verdict: string;
}

const flagFrom = (raw: Record<string, unknown>): CitedFlag | null => {
  const explanation = str(raw.explanation);
  const citation = str(raw.citation);
  const matched = str(raw.matched);
  // All three are `min_length=1` upstream. A row missing one is a row we cannot show honestly —
  // an unexplained flag or an uncited one is exactly what these tables exist not to produce.
  if (!explanation || !citation || !matched) return null;
  return {
    id: str(raw.rule_id) ?? str(raw.alert_id) ?? '',
    severity: severityOf(raw.severity),
    motif: str(raw.motif),
    explanation,
    citation,
    matched,
    smarts: str(raw.smarts),
  };
};

function detectCitedFlags(node: unknown): CitedFlagList | null {
  if (!isRecord(node)) return null;
  const subject = Array.isArray(node.flags) ? 'hazard' : Array.isArray(node.alerts) ? 'genotox' : null;
  if (!subject) return null;

  const raw = records(subject === 'hazard' ? node.flags : node.alerts);
  const flags = raw.map(flagFrom).filter((f): f is CitedFlag => f !== null);
  // A list that lost rows on the way in is not this result. Rendering the survivors would be the
  // silent-truncation failure the backend refuses whole results to avoid.
  if (flags.length !== raw.length) return null;

  const verdict = str(node.verdict);
  const screened = strings(node.screened);
  // An empty list is the dangerous case and must still card — but only when the payload says what
  // it looked at or what the absence means. With neither, this is some other object that happens
  // to have an empty array under a familiar key.
  if (flags.length === 0 && !verdict && screened.length === 0) return null;

  return {
    kind: 'cited-flags',
    subject,
    // Worst first. `Array.prototype.sort` is stable, so alerts — which have no severity and must
    // not be ranked — keep the table order they arrived in.
    flags: [...flags].sort(
      (a, b) =>
        (a.severity ? SEVERITY_RANK[a.severity] : 3) - (b.severity ? SEVERITY_RANK[b.severity] : 3),
    ),
    screened,
    verdict: verdict ?? '',
  };
}

// ---------------------------------------------------------------------------------------------
// A ranked comparison — `compare_solvents`, `similar_molecules`, `similar_reactions`.
// ---------------------------------------------------------------------------------------------

export interface RankedItem {
  label: string;
  /** The ranking quantity as it should be read: a difference from the leader, or a similarity. */
  score: string;
  /** What that number is. Shown once, in the header, not repeated per row. */
  detail: string | null;
  /** Drawn when present. A molecule hit's structure, or a solvent's — never parsed out of prose. */
  smiles: string | null;
  /** A reaction SMILES, drawn as a reaction. */
  reactionSmiles: string | null;
  /** The knowledge note to cite for this row, when the search gives one. */
  noteId: string | null;
}

export interface RankedComparison {
  kind: 'ranked';
  title: string;
  /** What the ranking column means, in the header rather than on every row. */
  scoreLabel: string;
  items: RankedItem[];
  /**
   * The sentence that says how far this ranking may be trusted, and whether it is a warning.
   *
   * For a solvent screen it is the manifest's own position — the differences are more trustworthy
   * than any absolute value — sharpened into a warning when the spread does not exceed the
   * method's uncertainty, because a screen that has not distinguished its solvents must not be
   * read as having ranked them. For a similarity search it is the payload's own `verdict`, which
   * exists precisely so an unbuilt index cannot render as "we have never made anything like this".
   */
  framing: string;
  framingIsWarning: boolean;
  /** Anything else the result flagged about itself. */
  warnings: string[];
}

/** `compare_solvents` — `SolventComparisonResult`, ranked by ΔG where it has one and ΔE otherwise. */
function detectSolventRanking(node: unknown): RankedComparison | null {
  if (!isRecord(node)) return null;
  const raw = records(node.effects);
  if (raw.length === 0) return null;

  const uncertainty = num(node.uncertainty_kcal);
  const spread = num(node.spread_kcal);

  // Which quantity every row is ranked on. Mixed rows would compare a ΔG against a ΔE, so the
  // level is decided once for the whole screen: free energy only when every solvent reports one.
  const usesFreeEnergy = raw.every((row) => num(row.delta_g_kcal) !== null);
  const valueOf = (row: Record<string, unknown>): number | null =>
    usesFreeEnergy ? num(row.delta_g_kcal) : num(row.delta_e_kcal);

  const rows = raw
    .map((row) => ({ solvent: str(row.solvent) ?? 'gas phase', value: valueOf(row) }))
    .filter((row): row is { solvent: string; value: number } => row.value !== null);
  if (rows.length !== raw.length) return null;

  const ordered = [...rows].sort((a, b) => a.value - b.value);
  const leader = ordered[0];
  if (!leader) return null;
  const symbol = usesFreeEnergy ? 'ΔΔG' : 'ΔΔE';

  const undistinguished = spread !== null && uncertainty !== null && spread <= uncertainty;
  return {
    kind: 'ranked',
    title: 'Solvents ranked',
    scoreLabel: `${symbol} vs ${leader.solvent} (kcal/mol)`,
    items: ordered.map((row) => ({
      label: row.solvent,
      // The difference, not the absolute — the manifest's instruction rendered rather than
      // restated: "the differences between solvents are more trustworthy than any single value".
      score: formatSigned(row.value - leader.value),
      detail: `${usesFreeEnergy ? 'ΔG' : 'ΔE'} ${formatNumber(row.value)} kcal/mol`,
      smiles: null,
      reactionSmiles: null,
      noteId: null,
    })),
    framing: undistinguished
      ? `The spread across these solvents (${formatNumber(spread)} kcal/mol) does not exceed the ` +
        `method's own uncertainty (${formatNumber(uncertainty)} kcal/mol). This calculation has ` +
        'not distinguished them; do not read the order as a ranking.'
      : 'Read the differences, not the absolute values — a semiempirical solvation energy carries ' +
        'the method’s full error, and the comparison between solvents does not.' +
        (uncertainty !== null ? ` Stated uncertainty ±${formatNumber(uncertainty)} kcal/mol.` : ''),
    framingIsWarning: undistinguished,
    warnings: strings(node.warnings),
  };
}

/** `similar_molecules`, `similar_reactions`, `substructure_matches` — `FingerprintSearch`. */
function detectSearchRanking(node: unknown): RankedComparison | null {
  if (!isRecord(node) || !Array.isArray(node.hits)) return null;
  const subject = str(node.subject);
  const verdict = str(node.verdict);
  // `hits` alone is too common a key to claim on its own; the search payload always carries what
  // it searched over and the sentence saying what an empty answer means.
  if (!subject && !verdict) return null;

  const raw = records(node.hits);
  const items = raw.map((hit): RankedItem => {
    const similarity = num(hit.similarity);
    const smiles = str(hit.smiles);
    // A reaction hit carries the reaction SMILES as its `label`; a molecule hit carries none, and
    // its structure is the label a chemist reads.
    const label = str(hit.label);
    const isReaction = subject === 'reaction' || (label !== null && label.includes('>'));
    return {
      label: label ?? smiles ?? str(hit.id) ?? 'hit',
      score: similarity === null ? '—' : formatNumber(similarity),
      detail: null,
      smiles: isReaction ? null : smiles,
      reactionSmiles: isReaction ? label : null,
      noteId: str(hit.compound_note_id) ?? (isReaction ? str(hit.id) : null),
    };
  });

  const empty = boolOrNull(node.index_empty) === true;
  const truncated = boolOrNull(node.scan_truncated) === true || boolOrNull(node.hits_truncated) === true;
  return {
    kind: 'ranked',
    title: `Similar ${subject ?? 'record'}s, most similar first`,
    scoreLabel: 'similarity',
    items,
    // The payload's own sentence, verbatim. It distinguishes "we have no precedent" from "nothing
    // has been indexed" and from "the scan stopped early", which is the whole reason it exists —
    // and a rewording here would be this file re-deciding which of the three a chemist is looking
    // at.
    framing: verdict ?? '',
    framingIsWarning: empty || truncated,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------------------------
// A table of rows — `stoichiometry_table`, `ich_impurity_limit`, `calculator_outliers`.
// ---------------------------------------------------------------------------------------------

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface TableNotice {
  tone: 'danger' | 'warn';
  text: string;
}

export interface RowTable {
  kind: 'rows';
  title: string;
  /** What the table is of — the basis of a charge table, the substance of a limit lookup. */
  caption: string | null;
  columns: TableColumn[];
  rows: Record<string, string>[];
  /** Structures for the rows that have one, positionally. `null` where a row has none. */
  structures: (string | null)[];
  /** Load-bearing, not decoration: a dropped reagent makes a charge table wrong, silently. */
  notices: TableNotice[];
  /** The payload's own verdict, when it carries one. */
  verdict: string | null;
}

const cell = (value: unknown): string => {
  const n = num(value);
  if (n !== null) return formatNumber(n);
  const s = str(value);
  if (s !== null) return s;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return '—';
};

/** `stoichiometry_table` — `ChargeTable`. */
function detectChargeTable(node: unknown): RowTable | null {
  if (!isRecord(node)) return null;
  const raw = records(node.rows);
  const basis = str(node.basis_name);
  if (raw.length === 0 || !basis) return null;
  // Every row of a charge table is a thing to weigh out. One that cannot state its own name and
  // mass is not a row a chemist can act on, and a table missing one is a wrong table.
  if (!raw.every((row) => str(row.name) !== null && num(row.mass_g) !== null)) return null;

  const unresolved = strings(node.unresolved);
  const basisMass = num(node.basis_mass_g);
  return {
    kind: 'rows',
    title: 'Charge table',
    caption:
      basisMass === null
        ? `Basis: ${basis}`
        : `Basis: ${basis}, ${formatNumber(basisMass)} g — every other species is scaled to it.`,
    columns: [
      { key: 'name', label: 'Species' },
      { key: 'role', label: 'Role' },
      { key: 'equivalents', label: 'Equiv', numeric: true },
      { key: 'molecular_weight', label: 'MW', numeric: true },
      { key: 'moles_mmol', label: 'mmol', numeric: true },
      { key: 'mass_g', label: 'Mass (g)', numeric: true },
      { key: 'density_g_per_ml', label: 'ρ (g/mL)', numeric: true },
      { key: 'volume_ml', label: 'Volume (mL)', numeric: true },
    ],
    rows: raw.map((row) => ({
      name: cell(row.name),
      role: cell(row.role),
      equivalents: cell(row.equivalents),
      molecular_weight: cell(row.molecular_weight),
      moles_mmol: cell(row.moles_mmol),
      mass_g: cell(row.mass_g),
      density_g_per_ml: cell(row.density_g_per_ml),
      volume_ml: cell(row.volume_ml),
    })),
    structures: raw.map((row) => str(row.smiles)),
    notices:
      unresolved.length > 0
        ? [
            {
              tone: 'danger',
              // `unresolved` names the reagents that did NOT make it into the table. Reading the
              // rows without it is reading a charge for a different reaction.
              text: `Not resolved, and therefore absent from every row above: ${unresolved.join(', ')}. This table is not the whole charge.`,
            },
          ]
        : [],
    verdict: null,
  };
}

/** `ich_impurity_limit` — `ImpurityLimitLookup`, whose miss is the load-bearing half. */
function detectImpurityLimit(node: unknown): RowTable | null {
  if (!isRecord(node)) return null;
  const query = str(node.query);
  const verdict = str(node.verdict);
  if (!query || !verdict || !('limit' in node)) return null;

  const limit = isRecord(node.limit) ? node.limit : null;
  const values = limit ? records(limit.limits) : [];
  const caption = limit
    ? [str(limit.substance), str(limit.guideline), str(limit.limit_class), str(limit.class_meaning)]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : `No transcribed row for ${query}.`;

  return {
    kind: 'rows',
    title: 'ICH impurity limit',
    caption,
    columns: [
      { key: 'basis', label: 'Basis' },
      { key: 'value', label: 'Limit', numeric: true },
      { key: 'unit', label: 'Unit' },
    ],
    rows: values.map((row) => ({
      basis: cell(row.basis),
      value: cell(row.value),
      unit: cell(row.unit),
    })),
    structures: values.map(() => null),
    notices: limit
      ? []
      : [
          // A miss is not "no limit exists", and the payload is careful to say so. Rendering the
          // empty table without the distinction would invite exactly the guess the tool exists to
          // prevent.
          { tone: 'warn', text: verdict },
        ],
    verdict: limit ? verdict : null,
  };
}

/** `calculator_outliers` — `OutlierReport`, where an empty list has three meanings. */
function detectOutlierReport(node: unknown): RowTable | null {
  if (!isRecord(node)) return null;
  const calcType = str(node.calc_type);
  const verdict = str(node.verdict);
  if (!calcType || !verdict || !Array.isArray(node.residuals)) return null;

  const raw = records(node.residuals);
  const measured = num(node.measured);
  const matching = str(node.matching);
  const enabled = boolOrNull(node.enabled);

  return {
    kind: 'rows',
    title: `Where ${calcType} was most wrong`,
    caption: [
      measured === null ? null : `${formatNumber(measured)} measurement(s) in the ledger`,
      matching === null ? null : `filtered to molecules containing ${matching}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    columns: [
      { key: 'smiles', label: 'Molecule' },
      { key: 'predicted', label: 'Predicted', numeric: true },
      { key: 'observed', label: 'Observed', numeric: true },
      { key: 'error', label: 'Error', numeric: true },
      { key: 'unit', label: 'Unit' },
      { key: 'within_uncertainty', label: 'Within ±1σ' },
    ],
    rows: raw.map((row) => {
      const error = num(row.error);
      return {
        smiles: cell(row.smiles),
        predicted: cell(row.predicted),
        observed: cell(row.observed),
        // Signed, matching the reported bias: consistently high is correctable, scattered is not.
        error: error === null ? '—' : formatSigned(error),
        unit: cell(row.unit),
        // `null` upstream means the prediction claimed no uncertainty, which is not a miss.
        within_uncertainty: boolOrNull(row.within_uncertainty) === null ? 'not claimed' : cell(row.within_uncertainty),
      };
    }),
    structures: raw.map((row) => str(row.smiles)),
    // The ledger being off makes an empty list say nothing about the calculator, and the payload
    // spells that out. It is a warning here rather than a caption because a reader who takes the
    // short list at face value has drawn the opposite conclusion from the true one.
    notices: enabled === false ? [{ tone: 'warn', text: verdict }] : [],
    verdict: enabled === false ? null : verdict,
  };
}

// ---------------------------------------------------------------------------------------------
// A value with an uncertainty — `predict_pka`, `predict_solubility`, `compute_xtb_energy`.
// ---------------------------------------------------------------------------------------------

export interface ValueWithUncertainty {
  kind: 'value';
  title: string;
  /** The structure the number is about, drawn beside it. From the payload, never from prose. */
  subject: string | null;
  value: number;
  unit: string;
  /** `null` when the calculator stated none — which is not the same as zero, and must not read
   *  as an exact answer. */
  uncertainty: number | null;
  /** Where the uncertainty came from, in the backend's own words. */
  uncertaintyBasis: string | null;
  method: string | null;
  /** `null` = the calculator declares no applicability domain, so the question was not asked.
   *  A consumer that reads `null` as `true` is the bug the third value exists to expose. */
  inDomain: boolean | null;
  domainReasons: string[];
  /** Whatever else the result carried, so a card never silently drops a field it did not model. */
  extras: { label: string; value: string }[];
}

/**
 * Which field carries the number, per tool — **the one place this file keys off a tool name**.
 *
 * Structure cannot answer this one. `predict_pka` and `predict_solubility` share no field, their
 * uncertainty keys are spelled differently, and neither states its unit in the payload; a
 * structural rule would have to guess which number is the answer, and a card that guesses is a
 * card that eventually shows a deprotonation energy labelled as a pKa. A tool that is not here
 * falls through to the raw preview, which is the honest outcome for a result nobody has modelled.
 *
 * `unit` is written here rather than read from the payload because these results genuinely do not
 * carry one — it is the calculator's own documented unit, not an inference.
 */
const VALUE_FIELDS: Record<
  string,
  { value: string; unit: string; uncertainty?: string; method?: string }
> = {
  predict_pka: { value: 'pka', unit: 'pKa units', uncertainty: 'uncertainty', method: 'method' },
  predict_solubility: {
    value: 'log_s_mol_per_l',
    unit: 'log S (mol/L)',
    uncertainty: 'uncertainty_log',
    method: 'model',
  },
  // No uncertainty field at all: `XtbResult` states none, and the card says so rather than
  // rendering a bare number as if it were exact.
  compute_xtb_energy: { value: 'total_energy_hartree', unit: 'hartree', method: 'method' },
};

/** `Estimate.method`, in the words the backend renders it with. */
const UNCERTAINTY_BASIS: Record<string, string> = {
  reported: 'the model’s own reported error',
  conformal: 'conformal, over this deployment’s recorded residuals',
  propagated: 'propagated from the inputs',
  none: 'no uncertainty established',
};

/** Everything the card did not model, so a field is never dropped without being shown. */
function extrasFrom(node: Record<string, unknown>, consumed: Set<string>): { label: string; value: string }[] {
  const extras: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (consumed.has(key)) continue;
    if (isRecord(value) || Array.isArray(value)) continue;
    const rendered = cell(value);
    if (rendered === '—') continue;
    extras.push({ label: key.replace(/_/g, ' '), value: rendered });
  }
  return extras;
}

function detectValue(tool: string, node: unknown): ValueWithUncertainty | null {
  if (!isRecord(node)) return null;

  const subject = str(node.smiles);
  const named = VALUE_FIELDS[tool];
  // The uniform envelope, when the calculator produces one. Preferred over the domain fields
  // because it is the only shape that says where the uncertainty came from and whether the
  // molecule is one this calculator can speak about at all — and it is recognised structurally, so
  // a calculator that grows one is carded without being named anywhere.
  const estimate = isRecord(node.estimate) ? node.estimate : null;
  if (estimate) {
    const value = num(estimate.value);
    const unit = str(estimate.unit);
    if (value !== null && unit !== null) {
      const basis = str(estimate.method);
      // The calculator's own spelling of the same number is consumed too, when we know it: a card
      // that showed `log_s_mol_per_l` under "other fields" beside the value it *is* would read as
      // two results.
      const consumed = new Set(['smiles', 'estimate', 'method', 'model']);
      if (named) {
        consumed.add(named.value);
        if (named.uncertainty) consumed.add(named.uncertainty);
      }
      return {
        kind: 'value',
        title: tool,
        subject,
        value,
        unit,
        uncertainty: num(estimate.uncertainty),
        uncertaintyBasis: basis === null ? null : (UNCERTAINTY_BASIS[basis] ?? basis),
        method: str(node.method) ?? str(node.model),
        inDomain: boolOrNull(estimate.in_domain),
        domainReasons: strings(estimate.domain_reasons),
        extras: extrasFrom(node, consumed),
      };
    }
  }

  if (!named) return null;
  const value = num(node[named.value]);
  if (value === null) return null;

  const consumed = new Set(['smiles', named.value]);
  if (named.uncertainty) consumed.add(named.uncertainty);
  if (named.method) consumed.add(named.method);

  return {
    kind: 'value',
    title: tool,
    subject,
    value,
    unit: named.unit,
    uncertainty: named.uncertainty ? num(node[named.uncertainty]) : null,
    uncertaintyBasis: null,
    method: named.method ? str(node[named.method]) : null,
    inDomain: null,
    domainReasons: [],
    extras: extrasFrom(node, consumed),
  };
}

// ---------------------------------------------------------------------------------------------

export type DetectedResult = CitedFlagList | RankedComparison | RowTable | ValueWithUncertainty;

/**
 * The shape of `payload`, or `null` when nothing here recognises it.
 *
 * `null` is the common case and a supported one: eleven tools card, thirty-seven exist, and the
 * rest keep the `<pre>` they have always had. Detectors are tried outermost envelope first (see
 * `resultCandidates`) so a durable job's own result is found inside the envelope that carried it
 * without any detector knowing the envelope exists.
 */
export function detectResult(tool: string, payload: unknown): DetectedResult | null {
  for (const node of resultCandidates(payload)) {
    const detected =
      detectCitedFlags(node) ??
      detectChargeTable(node) ??
      detectImpurityLimit(node) ??
      detectOutlierReport(node) ??
      detectSolventRanking(node) ??
      detectSearchRanking(node) ??
      detectValue(tool, node);
    if (detected) return detected;
  }
  return null;
}
