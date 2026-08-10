/**
 * Provenance: what a number came from, and by what method.
 *
 * Three separate jobs, kept in one module because they answer one question — *how far does this
 * answer's authority actually reach* — and because none of them may touch React or the DOM.
 *
 * 1. **Grounding.** `tool_result.numbers` is the untruncated, deduplicated list of every numeric
 *    value a turn's tools actually returned. Matching the answer's figures against it is the only
 *    structured check the wire currently affords.
 * 2. **Method.** A tool name is the only thing that says whether a value is semiempirical, DFT, a
 *    cited table row or a surrogate's guess. The map below is the lookup.
 * 3. **Lost capability.** A connector name means nothing to a chemist; "no hazard screen" does.
 *
 * ## The rule that governs all of it: under-flag
 *
 * The backend documented what over-flagging costs. Its own live grounding check scored citations
 * against the *truncated* preview and graded 19 of 36 answers as fabrication; nine of nine verdicts
 * checked by hand were false — every one an id the tool really had returned. A surface that
 * accuses a real figure of being invented teaches a chemist to ignore the mark, and an ignored
 * mark is worse than no mark. So every ambiguous case here resolves to "grounded", and whole
 * classes of figure are never flagged at all.
 *
 * Nothing in this file reads `tool_result.preview`. That string is cut at an arbitrary byte and is
 * off limits for chemistry (see `recognise.ts`); `numbers` exists precisely so it does not have to
 * be mined.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Node, Parent } from 'unist';
import type { KnownTool } from '../../shared/events.ts';
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
 * The figures a turn's tools actually returned, deduplicated across every call.
 *
 * Per message rather than per call, because the answer is written after all of them and does not
 * say which call a number came from. An empty result is the load-bearing case: it means this turn
 * has *no* basis for the check, which is not the same as every figure being unsupported — see
 * `remarkGrounding`.
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
 * Scale factors a written figure may differ from a returned one by, and still be the same value.
 *
 * Units are **not on the wire**. `numbers` carries 0.45 with no way to say whether the tool called
 * it a fraction or the answer will call it 45%, and a molar concentration reported in µM is the
 * same measurement as the same value in M. Refusing those would flag correct arithmetic as
 * fabrication, which is the one failure this module may not have.
 *
 * A *closed* list rather than "any power of ten", because the point of the check is lost if every
 * figure matches every other figure at some scale. These are the conversions this domain writes
 * constantly: percent ↔ fraction, and the two metric prefix steps (m/k and µ/M).
 */
const SCALE_FACTORS = [1, 1e2, 1e-2, 1e3, 1e-3, 1e6, 1e-6] as const;

/**
 * Relative slack applied on top of the written precision.
 *
 * The precision rule below already absorbs honest rounding, so this only has to cover what it
 * cannot see: a value that reached the answer through an intermediate the wire never carried (a
 * mean, a difference, a float round-trip through JSON). Half a percent is loose enough for those
 * and tight enough that 4 600 does not ground a claimed 5 000.
 */
export const RELATIVE_SLACK = 0.005;

/**
 * How much a figure written as `literal` is allowed to differ from a returned value.
 *
 * The principled half of the rule is **the precision it was written to**. "4.8" asserts one
 * decimal place and nothing finer, so a tool that returned 4.7601 said exactly that figure; "4.76"
 * asserts two, and 4.7601 is still exactly it; "5000" and 5000.0 are the same number. Half a unit
 * in the last written place is therefore the honest tolerance, and it scales itself — it is 0.005
 * for a two-decimal figure and 0.5 for an integer, with no constant to tune.
 *
 * `1.2e3` is read the same way: one decimal in the mantissa, so the last written place is 100 and
 * the tolerance is 50.
 *
 * What this deliberately does NOT do is treat trailing zeros as insignificant. "5000" could be one
 * significant figure, and reading it that way would let anything from 4 500 to 5 500 ground it —
 * generous in the safe direction, but so generous that the highlight would stop meaning anything.
 */
export function writtenTolerance(literal: string): number {
  const plain = literal.replace(/,/g, '');
  const [mantissa = plain, exponent = '0'] = plain.split(/[eE]/);
  const decimals = mantissa.includes('.') ? (mantissa.split('.')[1]?.length ?? 0) : 0;
  const lastPlace = 10 ** (Number(exponent) - decimals);
  return lastPlace / 2;
}

/**
 * Is `value`, written as `literal`, one of the figures the turn's tools returned?
 *
 * Ties every ambiguity to "yes". A figure is grounded if it matches ANY returned value under ANY
 * of the scale factors, within the looser of the written precision and the relative slack.
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
 * Digit runs that could be a quantity. Boundaries are checked separately, in `figuresIn`.
 *
 * No sign in the pattern: a leading `-` is decided by what precedes it, because `5-10` is a range
 * of two positive numbers and `≈ -4.76` is one negative one, and a regex that swallows the hyphen
 * cannot tell them apart.
 *
 * **A comma is a thousands separator or it is not part of the number.** This used to read
 * `\d[\d,]*`, which swallowed any comma between digits — so `1,2-dichloroethane` yielded the
 * literal `1,2`, `Number("12")` read it as twelve, and the compound's *name* rendered as a grounded
 * figure the moment any tool in the turn returned 12, 1.2 or 1 200 under one of the scale factors.
 * Locant lists are not an edge case in chemistry prose: `2,6-lutidine`, `1,3-butadiene`,
 * `1,2,4-trimethylbenzene`. So a comma counts only in front of exactly three digits, and
 * `figuresIn` drops the survivors of a `digit,digit` pair outright.
 */
const DIGIT_RUN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Characters that make a preceding position part of a word rather than a boundary. A `-` is NOT
 *  one: it separates a range, and it also joins an identifier — the leading-zero and
 *  never-flag-an-integer rules below are what keep `compound-123` harmless. */
const WORD_BEFORE = /[A-Za-z0-9_.]/;

export interface Figure {
  /** Exactly as written, including any sign, commas and exponent. */
  text: string;
  value: number;
  start: number;
  end: number;
}

/**
 * The quantity-shaped literals in a run of plain text, with their offsets.
 *
 * Rejects, in order of how often each fires on real answers:
 *
 * - a run glued to a preceding word character — `GFN2-xTB`, `Q3D`, `pH7` — where the digits are
 *   part of a name and not a measurement at all;
 * - a run following `.` — the third component of `1.2.3`, which is a version and not a decimal;
 * - a leading zero followed by another digit — `08` in a date, `007` in an id;
 * - a run followed by a word character, which is a unit or an identifier glued on;
 * - either half of a `digit,digit` pair the thousands rule did not accept — the locants of
 *   `1,2-dichloroethane` and `2,6-lutidine`, which are positions on a ring and not quantities;
 * - anything longer than 15 digits, which no calculator in this system reports.
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
    // A bare comma between two digits, on either side. `DIGIT_RUN` has already claimed every
    // comma that separates thousands, so what is left is a locant list — and one half of `1,2`
    // read as the number 1 is no better than the whole of it read as 12.
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
 * Whether a figure may be flagged as *not* found among the returned values.
 *
 * Only figures written with a fractional part or an exponent. A bare integer in a chemistry answer
 * is overwhelmingly a count, an equivalent, a step number, a temperature in whole kelvin or a
 * literature year — none of which any tool returns and none of which is a fabricated measurement.
 * Flagging them would bury the one mark that matters under a dozen that do not, which is the
 * clutter failure the design brief names.
 *
 * A decimal is different: writing 4.76 is a claim to have measured or computed something to that
 * precision, and that is exactly the claim `numbers` can check.
 */
export const isCheckableFigure = (literal: string): boolean => /[.]\d|[eE][+-]?\d/.test(literal);

/** What the overlay concluded about one literal. `unmatched` is deliberately not called
 *  "unsupported": a figure can be legitimately derived or unit-converted from what a tool
 *  returned, and the wire carries no units to prove otherwise. */
export type FigureGrounding = 'grounded' | 'unmatched';

export function groundingOf(
  figure: Figure,
  returned: readonly number[],
): FigureGrounding | null {
  if (isGroundedFigure(figure.text, figure.value, returned)) return 'grounded';
  return isCheckableFigure(figure.text) ? 'unmatched' : null;
}

/** The href scheme `<Markdown>` renders as a figure mark, mirroring `#cite/` in `citations.ts`. */
export const FIGURE_HREF = '#figure/';

/**
 * Remark plugin: mark the answer's figures against what the turn's tools returned.
 *
 * A remark plugin and not a regex over rendered HTML, for the same reason `remarkCitations` is one:
 * a post-hoc regex would happily rewrite the digits inside a code fence, inside an inline `code`
 * span holding a SMILES string, or inside a citation chip's own text. Visiting text nodes makes
 * all three impossible rather than merely unlikely.
 *
 * **`returned` being empty disables the plugin entirely.** A turn that called no tool, or whose
 * tools returned no numbers, has nothing to check against — painting its every figure as unmatched
 * would be an accusation manufactured out of the absence of evidence.
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
 * What produced a value, and the caveat the method's own authors attached to it.
 *
 * `method` is the badge: short enough to sit beside a tool name without pushing it off the line.
 * `caveat` is the expandable half, and every one of them is quoted or compressed from the
 * backend's own connector manifests (`connector.yaml`) and MCP tool descriptions.
 * **Nothing here is invented.** A caveat about chemistry that this frontend made up would be
 * indistinguishable, to a reader, from one the method's authors wrote — so a tool whose manifest
 * says nothing gets a method and no caveat, and a tool absent from the map gets neither.
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

/** Keyed on `KnownTool` — the tool list in `shared/events.ts` — so a method attributed to a tool
 *  the backend does not have will not compile. Partial, because a tool with no sourced method
 *  belongs here as an absence: `methodFor` returns null and no badge renders. */
const TOOL_METHOD: Partial<Record<KnownTool, ToolMethod>> = {
  // calc — inline GFN2-xTB calculators. Bundle manifest: "Fast cached property calculators …
  // heavy QM goes through the durable compute_dft_energy instead."
  compute_xtb_energy: {
    method: XTB,
    caveat: 'A fast semiempirical single point; heavy QM goes through compute_dft_energy instead.',
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
    caveat: 'How far this calculator’s predictions have actually been off — measured, not asserted.',
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

  // qm
  compute_dft_energy: {
    method: 'DFT on the HPC cluster',
    caveat:
      'The heavy path: a durable single-point at a named level of theory, minutes to days. Used ' +
      'when semiempirical xTB is not accurate enough for the decision at hand.',
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
      'opens its recommendation as a PR-gated note for human review.',
  },

  // core, in-process. Retrieval rather than computation — no manifest, so no caveat.
  gather_evidence: { method: RETRIEVAL },
  find_notes: { method: RETRIEVAL },
  expand_note: { method: RETRIEVAL },
  find_knowledge_gaps: { method: RETRIEVAL },
  recall_observations: { method: RETRIEVAL },
};

/** The method behind a tool, or null for one this map does not know. Null renders no badge:
 *  a wrong method claim is worse than a missing one. Takes a plain string, because the name came
 *  off the wire and the backend adds tools without asking this repo. */
export const methodFor = (tool: string): ToolMethod | null =>
  (TOOL_METHOD as Record<string, ToolMethod | undefined>)[tool] ?? null;

/* ---------------------------------------------------------- lost capability */

/**
 * What the absence of a capability means for the answer, in chemistry rather than in infrastructure.
 *
 * "molfp was unreachable" is a fact about a pod. "This answer contains no precedent search" is the
 * same fact stated as what the reader must now do about it, which is the entire point of the event
 * (`CapabilityDegradedEvent`: "the ELN says nothing about that batch" and "the ELN was unreachable"
 * otherwise arrive as the same sentence).
 *
 * `durable-jobs (Temporal)` is deliberately in this map and is **not** a bundle: the backend puts
 * the durable execution layer in the same list because a surface does the identical thing with the
 * name, and it is prefixed so it cannot be mistaken for one in the registry.
 */
const CAPABILITY_LOSS: Record<string, string> = {
  safety: 'no hazard screen, no genotoxicity alerts and no ICH impurity limits',
  calc: 'no computed properties — no xTB energies, pKa, solubility, logD or thermochemistry',
  qm: 'no DFT',
  molfp: 'no molecule precedent search — no similarity and no substructure lookup',
  rxnfp: 'no reaction precedent search',
  chem: 'no structure resolution, no charge table and no green metrics',
  bo: 'no experiment design and no surrogate predictions',
  'durable-jobs (Temporal)': 'no durable job could be started, so every long calculation was out of reach',
};

/**
 * A sentence for one degraded capability.
 *
 * The fallback names the connector and says what follows from it in general terms. It has to stay
 * honest rather than guess: the event's own contract warns that a name here need not resolve in the
 * registry, so a deployment can legitimately send one this map has never seen.
 */
export function capabilityLoss(connector: string): string {
  return CAPABILITY_LOSS[connector] ?? `nothing only ${connector} can reach`;
}
