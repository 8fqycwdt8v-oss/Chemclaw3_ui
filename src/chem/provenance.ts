/**
 * Provenance: what a number came from, and by what method. Three jobs, no React or DOM:
 *
 * 1. Grounding: match the answer's figures against `tool_result.numbers` (untruncated values the
 * tools returned). 2. Method: which method a tool name implies (semiempirical, cited table,
 * surrogate). 3. Lost capability: a degraded connector as what it means for the answer.
 *
 * Rule: under-flag. A false "unmatched" mark teaches chemists to ignore marks, so every ambiguous
 * case resolves to grounded and whole classes of figure are never flagged. `tool_result.preview` is
 * never read.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Node, Parent } from 'unist';
import type { TraceEntry } from '../state/types.ts';

interface TextNode extends Node {
  type: 'text';
  value: string;
}

interface LinkNode extends Node {
  type: 'link';
  url: string;
  children: Node[];
}

/* ------------------------------------------------------------------ grounding */

/**
 * The figures a turn's tools returned, deduplicated. Empty means the turn has no basis for the
 * check (see `remarkGrounding`), not that every figure is unsupported.
 */
export function returnedFigures(trace: readonly TraceEntry[]): number[] {
  const seen = new Set<number>();
  for (const entry of trace) {
    for (const value of entry.toolCall?.numbers ?? []) {
      if (Number.isFinite(value)) seen.add(value);
    }
  }
  return [...seen];
}

/**
 * Scale factors a written figure may differ by and still be the same value (no units on the wire):
 * percent ↔ fraction and the m/k and µ/M steps. A closed list, or everything would match at some
 * scale.
 */
const SCALE_FACTORS = [1, 1e2, 1e-2, 1e3, 1e-3, 1e6, 1e-6] as const;

/**
 * Relative slack on top of the written precision, for values derived through intermediates; tight
 * enough that 4 600 does not ground 5 000.
 */
export const RELATIVE_SLACK = 0.005;

/**
 * How far a figure written as `literal` may differ from a returned value: half a unit in the last
 * written place (0.005 for "4.76", 0.5 for an integer; `1.2e3` gives 50). Trailing zeros count as
 * significant.
 */
export function writtenTolerance(literal: string): number {
  const plain = literal.replace(/,/g, '');
  const [mantissa = plain, exponent = '0'] = plain.split(/[eE]/);
  const decimals = mantissa.includes('.') ? (mantissa.split('.')[1]?.length ?? 0) : 0;
  const lastPlace = 10 ** (Number(exponent) - decimals);
  return lastPlace / 2;
}

/**
 * Whether `value`, written as `literal`, matches any returned value under any scale factor, within
 * the looser of written precision and relative slack.
 */
export function isGroundedFigure(
  literal: string,
  value: number,
  returned: readonly number[],
): boolean {
  const precision = writtenTolerance(literal);
  return returned.some((returnedValue) =>
    SCALE_FACTORS.some((factor) => {
      const scaled = returnedValue * factor;
      const allowed = Math.max(
        precision,
        RELATIVE_SLACK * Math.max(Math.abs(value), Math.abs(scaled)),
        // Floating point noise, so an exact value does not fail on its own representation.
        1e-9,
      );
      return Math.abs(value - scaled) <= allowed;
    }),
  );
}

/**
 * Digit runs that could be a quantity (boundaries checked in `figuresIn`). No sign: a leading `-`
 * depends on context (`5-10` vs `≈ -4.76`). A comma counts only as a thousands separator before
 * exactly three digits, so locants like `1,2-dichloroethane` are not numbers.
 */
const DIGIT_RUN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Characters that make the preceding position part of a word. `-` is not one (ranges, identifiers).
 */
const WORD_BEFORE = /[A-Za-z0-9_.]/;

export interface Figure {
  /** Exactly as written, including any sign, commas and exponent. */
  text: string;
  value: number;
  start: number;
  end: number;
}

/**
 * The quantity-shaped literals in plain text, with offsets. Rejects runs glued to a preceding word
 * (`GFN2-xTB`, `pH7`), after `.` (`1.2.3`), with a leading zero (`08`), followed by a word
 * character, either half of a non-thousands `digit,digit` pair (locants), and anything over 15
 * digits.
 */
export function figuresIn(text: string): Figure[] {
  const found: Figure[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0];
    const at = match.index ?? 0;
    const before = text[at - 1] ?? '';
    const twoBefore = text[at - 2] ?? '';
    const after = text[at + digits.length] ?? '';
    const twoAfter = text[at + digits.length + 1] ?? '';
    if (WORD_BEFORE.test(before)) continue;
    if (/\w/.test(after)) continue;
    if (/^0\d/.test(digits)) continue;
    // A bare comma between digits is a locant list; neither half is a number.
    if (after === ',' && /\d/.test(twoAfter)) continue;
    if (before === ',' && /\d/.test(twoBefore)) continue;
    if (digits.replace(/\D/g, '').length > 15) continue;

    // A `-` is a sign only where a number could start: after whitespace, an opening bracket, or
    // nothing. Between two digits it is a range, and both ends are positive.
    const signed = before === '-' && !/[A-Za-z0-9_.]/.test(twoBefore);
    const start = signed ? at - 1 : at;
    const literal = text.slice(start, at + digits.length);
    const value = Number(literal.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    found.push({ text: literal, value, start, end: at + digits.length });
  }
  return found;
}

/**
 * Whether a figure may be flagged as unmatched: only decimals and exponents. Bare integers are
 * mostly counts, equivalents, steps or years.
 */
export const isCheckableFigure = (literal: string): boolean => /[.]\d|[eE][+-]?\d/.test(literal);

/**
 * The overlay's verdict on one literal. `unmatched`, not "unsupported": it may be derived or
 * converted.
 */
export type FigureGrounding = 'grounded' | 'unmatched';

export function groundingOf(figure: Figure, returned: readonly number[]): FigureGrounding | null {
  if (isGroundedFigure(figure.text, figure.value, returned)) return 'grounded';
  return isCheckableFigure(figure.text) ? 'unmatched' : null;
}

/** The href scheme `<Markdown>` renders as a figure mark, mirroring `#cite/` in `citations.ts`. */
export const FIGURE_HREF = '#figure/';

/**
 * Remark plugin marking the answer's figures against the returned values. Visits text nodes only,
 * so code spans, SMILES and citation chips are never touched. An empty `returned` disables it.
 */
export function remarkGrounding(returned: readonly number[]) {
  return (tree: Node): void => {
    if (returned.length === 0) return;

    visit(tree, 'text', (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      // Never inside a link: that covers the citation chips `remarkCitations` has already emitted,
      // whose text is a note id and not a quantity.
      if (parent.type === 'link' || parent.type === 'inlineCode' || parent.type === 'code') {
        return SKIP;
      }

      const value = node.value;
      const marks = figuresIn(value)
        .map((figure) => ({ figure, grounding: groundingOf(figure, returned) }))
        .filter((m): m is { figure: Figure; grounding: FigureGrounding } => m.grounding !== null);
      if (marks.length === 0) return;

      const children: Node[] = [];
      let cursor = 0;
      for (const { figure, grounding } of marks) {
        if (figure.start > cursor) {
          children.push({ type: 'text', value: value.slice(cursor, figure.start) } as TextNode);
        }
        children.push({
          type: 'link',
          url: `${FIGURE_HREF}${grounding}`,
          children: [{ type: 'text', value: figure.text } as TextNode],
        } as LinkNode);
        cursor = figure.end;
      }
      if (cursor < value.length) {
        children.push({ type: 'text', value: value.slice(cursor) } as TextNode);
      }

      parent.children.splice(index, 1, ...(children as Parent['children']));
      // Skip past what we just inserted so the visitor does not re-scan our own mark text.
      return [SKIP, index + children.length];
    });
  };
}

/* -------------------------------------------------------------------- method */

/**
 * What produced a value and the caveat its authors attached, quoted or compressed from the
 * backend's `connector.yaml` and tool descriptions. Nothing invented: a tool whose manifest says
 * nothing gets no caveat; an unknown tool gets neither.
 */
export interface ToolMethod {
  method: string;
  caveat?: string;
}

const XTB = 'GFN2-xTB · semiempirical';
const TABLE = 'Cited reference table';
const RDKIT = 'RDKit';
const SURROGATE = 'BoFire surrogate';
const LEDGER = 'Calibration ledger';
const STORE = 'Calculation store';
const RETRIEVAL = 'Knowledge-graph retrieval';

/**
 * Keyed on the tool name as the wire spells it; an unknown tool has no entry and no badge. Every
 * entry is sourced from the backend's own manifests.
 */
const TOOL_METHOD: Record<string, ToolMethod> = {
  // calc — inline GFN2-xTB calculators. Bundle manifest: "Fast cached property calculators …
  // Every method here is semiempirical (GFN2-xTB via tblite, CREST) — there is no DFT tier."
  compute_xtb_energy: {
    method: XTB,
    caveat:
      'A fast semiempirical single point. There is no DFT tier above it, so where the decision ' +
      'turns on a difference inside its error bar the number cannot settle it.',
  },
  compute_electronic_properties: {
    method: XTB,
    caveat:
      'Semiempirical values on a force-field geometry: compare them across similar structures ' +
      'rather than quoting one as an absolute measurement.',
  },
  predict_site_reactivity: {
    method: XTB,
    caveat:
      'Read the ranking as a hypothesis, not a prediction of yield: it ranks sites within this ' +
      'molecule only, and sterics, the reagent and the solvent are not in the model.',
  },
  optimize_geometry: {
    method: XTB,
    caveat:
      'It finds the nearest minimum, not the best one: a flexible molecule has many conformers ' +
      'and this relaxes into whichever basin it started in.',
  },
  compute_thermochemistry: {
    method: XTB,
    caveat:
      'Frequencies are semiempirical and systematically a few percent off, so compare patterns ' +
      'and orderings rather than positions — and everything describes one conformer, not the ' +
      'molecule’s real population.',
  },
  predict_pka: {
    method: XTB,
    caveat:
      'Acids carry about 1.6 units of uncertainty and bases ±1.0, and base coverage is aromatic ' +
      'and aryl nitrogen only — an aliphatic amine is refused rather than estimated.',
  },
  predict_solubility: {
    method: 'Fitted property model',
    caveat:
      'The result reports an uncertainty that should be passed on rather than treating the value ' +
      'as exact.',
  },
  predict_logd: {
    method: XTB,
    caveat:
      'Derived from predict_pka, and defined only where a single equilibrium describes the ' +
      'molecule at that pH; it carries the pKa model’s uncertainty and is not an exact value.',
  },
  predict_developability_profile: {
    method: RDKIT,
    caveat:
      'Rule-of-Five and Veber are widely used oral-bioavailability heuristics, not developability ' +
      'verdicts — flags to weigh, never a pass/fail gate on their own.',
  },
  calculator_trust: {
    method: LEDGER,
    caveat:
      'How far this calculator’s predictions have actually been off — measured, not asserted.',
  },
  calculator_outliers: {
    method: LEDGER,
    caveat:
      'Each row is a measurement someone made, so a short list means few measurements, not a ' +
      'well-behaved calculator.',
  },
  find_calculations: { method: STORE },
  list_artifacts: { method: STORE },
  fetch_artifact: { method: STORE },
  report_measurement: { method: LEDGER },

  // calc — the durable jobs. Caveats are the per-job `description:` fields verbatim.
  compute_reaction_energy: {
    method: XTB,
    caveat:
      'A negative ΔG means products are favoured at equilibrium — it says nothing about rate, ' +
      'since there are no transition states here. A semiempirical reaction free energy is for ' +
      'comparing related reactions, not for a number in a report; quote the reported uncertainty.',
  },
  compare_solvents: {
    method: XTB,
    caveat:
      'The differences between solvents are more trustworthy than any single value; it is a ' +
      'ranking, not a set of absolute numbers.',
  },
  scan_coordinate: {
    method: XTB,
    caveat:
      'A conformational profile or rotational barrier, not a reaction path: the barrier it ' +
      'reports is an upper bound on the ground-state profile and is not a transition state.',
  },
  sample_conformers: {
    method: 'CREST + GFN2-xTB',
    caveat:
      'A Boltzmann-weighted ensemble rather than one arbitrary geometry. Needs the optional CREST ' +
      'binary; without it the job reports the search as unavailable rather than returning a ' +
      'single conformer.',
  },
  compute_interaction_energy: {
    method: 'CREST NCI + GFN2-xTB',
    caveat:
      'Semiempirical and in continuum solvent, so treat it as a ranking between candidate ' +
      'partners, not an absolute binding energy.',
  },

  // safety — three cited tables, each with the limit its own manifest states.
  screen_hazards: {
    method: TABLE,
    caveat:
      'An empty result means no rule in the table matched — it does NOT mean the chemistry is ' +
      'safe. Nothing here assesses toxicity, exposure, thermal stability or scale, and it is ' +
      'never a safety clearance.',
  },
  screen_genotoxic_alerts: {
    method: TABLE,
    caveat:
      'A flag is an alert, not a classification: no ICH M7 class, acceptable intake or purge ' +
      'factor follows from it. An empty result is equally not a negative prediction — the table ' +
      'is nine alerts long.',
  },
  ich_impurity_limit: {
    method: 'ICH Q3C / Q3D tables',
    caveat:
      'The tables give the number a judgement needs; they are not the judgement. A miss means ' +
      'these tables do not carry the substance, not that no limit exists.',
  },

  // chem — pure RDKit, no store and no network.
  resolve_compound: {
    method: RDKIT,
    caveat:
      'An unrecognised name comes back as nothing rather than a guessed structure, because a ' +
      'wrong structure would silently corrupt every downstream calculation.',
  },
  stoichiometry_table: { method: RDKIT },
  render_structure: { method: RDKIT },
  green_metrics: {
    method: RDKIT,
    caveat:
      'E-factor is kg waste per kg product and PMI total input mass per kg product. Omitting ' +
      'solvent is the usual way these numbers get flattered.',
  },

  // molfp / rxnfp — search over an index that may simply be empty.
  similar_molecules: {
    method: 'ECFP4 Tanimoto over the indexed corpus',
    caveat:
      'An empty result on an empty index means the question was not answered — it is not a ' +
      'finding of novelty. A truncated one is a lower bound, not a total.',
  },
  substructure_matches: {
    method: 'SMARTS match over the indexed corpus',
    caveat:
      'An empty result on an empty index means the question was not answered, not that no ' +
      'molecule bears the fragment.',
  },
  similar_reactions: {
    method: 'DRFP Tanimoto over the indexed corpus',
    caveat:
      'An empty result on an empty index is never “we have no precedent”; a truncated one is a ' +
      'lower bound on the precedent on file, not the amount of it.',
  },

  // bo — a surrogate model's opinion, which is not a result.
  suggest_next_experiment: {
    method: SURROGATE,
    caveat:
      'These are proposals a human runs, not results. For a multi-objective problem there is no ' +
      'single best point — the trade-off front is the answer.',
  },
  predict_outcome: {
    method: SURROGATE,
    caveat:
      'This endorses nothing: a prediction is an answer about a point you chose, not the ' +
      'optimizer’s recommendation.',
  },
  campaign_progress: {
    method: 'Arithmetic over the runs supplied',
    caveat:
      'It reads the runs it was given and nothing else, so it can never show a global optimum ' +
      'was reached — only that recent points in the region already explored have not beaten the ' +
      'assay noise.',
  },
  generate_screening_design: {
    method: 'Factorial design',
    caveat:
      'A continuous factor is held at the two ends of its declared range and nothing between, ' +
      'which is what a two-level screen is.',
  },
  resume_campaign: {
    method: 'Campaign record',
    caveat:
      'A campaign id is a hash of the decision space, not a serial number, so an id that does ' +
      'not resolve means the space has changed and the new space is a different campaign.',
  },
  start_optimization_campaign: {
    method: SURROGATE,
    caveat:
      'A durable multi-round campaign: it proposes, evaluates against a registered objective, and ' +
      'records its recommendation as an agent-authored note, readable at once.',
  },

  // core, in-process. Retrieval rather than computation — no manifest, so no caveat.
  gather_evidence: { method: RETRIEVAL },
  find_notes: { method: RETRIEVAL },
  expand_note: { method: RETRIEVAL },
  find_knowledge_gaps: { method: RETRIEVAL },
  recall_observations: { method: RETRIEVAL },
};

/** The method behind a tool, or null (no badge — a wrong method claim is worse than none). */
export const methodFor = (tool: string): ToolMethod | null =>
  (TOOL_METHOD as Record<string, ToolMethod | undefined>)[tool] ?? null;

/**
 * The distinct methods a turn's tools used, in first-use order, shown once per answer so the method
 * is visible without opening the trace (the caveats stay in the trace). Deduplicated by method
 * string; unknown tools contribute nothing.
 */
export function methodsUsed(trace: readonly TraceEntry[]): string[] {
  const seen: string[] = [];
  for (const entry of trace) {
    const tool = entry.toolCall?.tool;
    if (!tool) continue;
    const method = methodFor(tool)?.method;
    if (method && !seen.includes(method)) seen.push(method);
  }
  return seen;
}

/* ---------------------------------------------------------- lost capability */

/**
 * What a missing capability means for the answer, in chemistry terms ("no precedent search"), keyed
 * by connector name. `durable-jobs (Temporal)` is not a bundle but is reported the same way.
 */
const CAPABILITY_LOSS: Record<string, string> = {
  safety: 'no hazard screen, no genotoxicity alerts and no ICH impurity limits',
  calc: 'no computed properties — no xTB energies, pKa, solubility, logD or thermochemistry',
  molfp: 'no molecule precedent search — no similarity and no substructure lookup',
  rxnfp: 'no reaction precedent search',
  chem: 'no structure resolution, no charge table and no green metrics',
  bo: 'no experiment design and no surrogate predictions',
  'durable-jobs (Temporal)':
    'no durable job could be started, so every long calculation was out of reach',
};

/** A sentence for one degraded capability; unknown names get an honest generic fallback. */
export function capabilityLoss(connector: string): string {
  return CAPABILITY_LOSS[connector] ?? `nothing only ${connector} can reach`;
}
