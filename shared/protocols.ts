/**
 * The experiment-protocol contract — a hand-written mirror of the service's protocol schemas. A
 * protocol is the one thing a human edits: the agent drafts, a chemist corrects, and each
 * correction is an attributed revision (parent, change note, checks, diff).
 *
 * - `FieldBasis`: a request field is `stated` (with the chemist's `quote`), `inferred` or `absent`;
 *   never render an inference as an instruction.
 * - A failed check is not a blocking one: `ProtocolCheck.passed` is per check;
 *   `ProtocolReceipt.blocking` is the subset that stops execution.
 *
 * REST bodies and one tool-result payload only (nothing streams). Imported by the SPA and the e2e
 * fixture service; dependency-free.
 */

/** Single experiment, a screen of arms, or a multi-round campaign. */
export type DesignMode = 'single' | 'screen' | 'campaign';

/** Where a design sits between being asked for and being run. */
export type DesignStatus = 'requested' | 'draft' | 'approved' | 'executed' | 'abandoned';

/**
 * What a revision holds: the ask alone, or a procedure. Derived by the service from `has_protocol`;
 * decides which sign-offs can succeed (`legalStatusMoves`).
 */
export type RevisionKind = 'request' | 'protocol';

/** `blocker` stops execution; `warning` and `note` qualify it. */
export type CheckSeverity = 'blocker' | 'warning' | 'note';

/** Where a request field's value came from. See the note at the top of this file. */
export type FieldBasis = 'stated' | 'inferred' | 'absent';

export type SpeciesRole =
  | 'starting-material'
  | 'product'
  | 'reagent'
  | 'solvent'
  | 'catalyst'
  | 'ligand'
  | 'base'
  | 'additive'
  | 'unknown';

export type ProtocolStepKind =
  | 'charge'
  | 'addition'
  | 'temperature'
  | 'stir'
  | 'hold'
  | 'sampling'
  | 'analysis'
  | 'workup'
  | 'purification'
  | 'custom';

/**
 * One request field with its provenance; `quote` (the chemist's words) is meaningful only when
 * `basis` is `stated`.
 */
export interface RequestField {
  value: string;
  basis: FieldBasis;
  quote: string;
}

/** A species as the chemist named it, and what the agent resolved it to. */
export interface RequestedComponent {
  name_as_written: string;
  smiles: string;
  role: SpeciesRole;
  /** How the name became a structure — a corpus hit, a lookup, or a failure to resolve. */
  resolution: string;
}

/** What was asked for, structured, with every field's provenance beside it. */
export interface ExperimentRequest {
  title: string;
  goal: string;
  mode: DesignMode;
  reaction_smiles: string;
  components: RequestedComponent[];
  objectives: string[];
  scale: RequestField;
  plate_format: RequestField;
  max_runs: RequestField;
  deadline: RequestField;
  /** Conditions ruled out up front — a solvent the site cannot use, a reagent on a stop list. */
  forbidden: string[];
  prior_work: string;
  project: string;
  notes: string;
}

/** One level of one factor. `value`/`unit` are populated for a continuous factor. */
export interface FactorLevel {
  label: string;
  smiles: string;
  value: number | null;
  unit: string;
  rationale: string;
}

export interface Factor {
  name: string;
  kind: 'categorical' | 'continuous';
  role: SpeciesRole;
  levels: FactorLevel[];
  unit: string;
}

/** The conditions a protocol runs at. Every field is nullable: an unset one is not a zero. */
export interface Setpoints {
  temperature_c: number | null;
  time_h: number | null;
  pressure_bar: number | null;
  atmosphere: string;
  concentration_molar: number | null;
  solvent: string;
  ph: number | null;
}

/** One line of the charge table. `limiting` marks the species the equivalents are relative to. */
export interface ChargeLine {
  component: string;
  smiles: string;
  role: SpeciesRole;
  equivalents: number | null;
  amount_mmol: number | null;
  mass_mg: number | null;
  volume_ml: number | null;
  limiting: boolean;
  note: string;
}

/** One step of the written procedure, in the order it is performed. */
export interface ProtocolStep {
  index: number;
  kind: ProtocolStepKind;
  text: string;
  /** The `ChargeLine.component` names this step involves. */
  components: string[];
  temperature_c: number | null;
  duration_h: number | null;
}

export interface Analytic {
  name: string;
  timing: string;
  method: string;
  measures: string[];
}

/**
 * The expected outcome and its basis: `precedent` (from a record), `predicted` (from a model) or
 * `assumed`.
 */
export interface ExpectedOutcome {
  yield_percent: number | null;
  selectivity: string;
  basis: 'precedent' | 'predicted' | 'assumed';
  detail: string;
}

/** One thing the design rests on, and which parts of it that thing supports. */
export interface EvidenceRef {
  kind: 'precedent' | 'tool' | 'note' | 'record' | 'observation';
  ref: string;
  tool: string;
  summary: string;
  /** Document paths this evidence supports — the same vocabulary `FieldChange.path` uses. */
  supports: string[];
}

/** The protocol every arm is a variation of. */
export interface ProtocolBody {
  setpoints: Setpoints;
  charge: ChargeLine[];
  steps: ProtocolStep[];
  analytics: Analytic[];
  in_process_controls: string[];
  hazards: string[];
  waste: string;
  expected: ExpectedOutcome;
}

/**
 * One arm of a screen. `setpoints: null` means the base conditions; `control` marks calibration
 * runs.
 */
export interface ProtocolArm {
  arm_id: string;
  /** Factor name → the level's `label`. */
  levels: Record<string, string>;
  setpoints: Setpoints | null;
  /**
   * No per-arm charge override: an arm varying an amount declares it as a continuous factor; other
   * differences go in `note`.
   */
  control: '' | 'positive' | 'negative' | 'blank';
  /** The `arm_id` this is a replicate of, or empty. */
  replicate_of: string;
  note: string;
}

export interface Well {
  label: string;
  row: number;
  column: number;
  arm_id: string;
  run_order: number;
}

/** The plate and whether its run order was randomised; reproducible only with a `seed`. */
export interface PlateLayout {
  plate_format: number;
  rows: number;
  columns: number;
  wells: Well[];
  randomized: boolean;
  seed: number | null;
}

export interface ProtocolCheck {
  check_id: string;
  severity: CheckSeverity;
  passed: boolean;
  detail: string;
}

/** The whole document: what was asked, what was designed, and what it rests on. */
export interface ExperimentDesign {
  request: ExperimentRequest;
  base: ProtocolBody;
  factors: Factor[];
  arms: ProtocolArm[];
  layout: PlateLayout | null;
  evidence: EvidenceRef[];
}

/** One revision of a design, with the document as it stood at that revision. */
/** A revision as the history lists it — everything but the document itself. */
export interface RevisionSummary {
  revision: number;
  kind: RevisionKind;
  author_kind: 'agent' | 'human';
  author: string;
  change_note: string;
  created_at: string;
  blockers: number;
}

/**
 * One recorded lifecycle move: which revision was signed off, and why. The header `status` follows
 * the head (a new revision demotes an approval), so this is the only record of what was approved.
 */
export interface StatusEvent {
  status: DesignStatus;
  /** The head revision at the instant of the move. */
  revision: number;
  actor: string;
  reason: string;
  created_at: string;
}

/**
 * What `GET /protocols/{id}` returns: one revision, flat, with the design's header and history
 * beside it — the service's exact shape. `DesignRevision` is derived from it.
 */
export interface DesignOut {
  design_id: string;
  /** The header row — status, counts, timestamps. `null` for a design with no header yet. */
  summary: DesignSummary | null;
  revision: number;
  kind: RevisionKind;
  author_kind: 'agent' | 'human';
  author: string;
  change_note: string;
  created_at: string;
  design: ExperimentDesign;
  checks: ProtocolCheck[];
  history: RevisionSummary[];
  /** Who approved, ran or abandoned this design and at which revision. */
  status_history: StatusEvent[];
}

/** The per-revision half of `DesignOut`, derived so it cannot drift. */
export type DesignRevision = Omit<DesignOut, 'summary' | 'history' | 'status_history'>;

export interface DesignSummary {
  design_id: string;
  title: string;
  mode: DesignMode;
  status: DesignStatus;
  project: string;
  opened_by: string;
  head_revision: number;
  arms: number;
  blockers: number;
  created_at: string;
  updated_at: string;
}

/** One changed field between two revisions. `before`/`after` are already rendered as text. */
export interface FieldChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: string;
  after: string;
}

export interface DesignDiff {
  from_revision: number;
  to_revision: number;
  changes: FieldChange[];
}

/** One arm flattened for a run sheet, with its conditions resolved against the base. */
export interface ArmRow {
  arm_id: string;
  well: string;
  run_order: number;
  levels: Record<string, string>;
  temperature_c: number | null;
  time_h: number | null;
  solvent: string;
  control: string;
  replicate_of: string;
  note: string;
}

/**
 * What the protocol tools return into the conversation. `arms` is capped (`arms_omitted` says by
 * how much); the full design is at `/protocols/{design_id}`.
 */
export interface ProtocolReceipt {
  design_id: string;
  revision: number;
  title: string;
  mode: string;
  status: DesignStatus;
  /**
   * Whether the checks were graded against a procedure. At the request stage unrun checks come back
   * as passing notes, and `status` is only a proxy for the stage, so read this.
   */
  has_protocol: boolean;
  summary: string;
  checks: ProtocolCheck[];
  /** The `check_id`s that stop this design being executed. A subset of the failed checks. */
  blocking: string[];
  /** Factor name → level labels. */
  factors: Record<string, string[]>;
  arm_count: number;
  arms: ArmRow[];
  arms_omitted: number;
  plate_format: number;
  evidence_count: number;
  /** Document paths this revision changed, in the same vocabulary as `FieldChange.path`. */
  changed_paths: string[];
}

/** `read_experiment_protocol` — the receipt, the whole document, and a rendering of it. */
export interface ProtocolRead {
  receipt: ProtocolReceipt;
  design: ExperimentDesign;
  markdown: string;
}

/**
 * An arm's setpoints over the body's, field by field — a transcription of the service's
 * `ExperimentDesign.setpoints_for`. A field counts as stated when not the default (`null` for
 * numbers, `''` for strings).
 */
export function setpointsFor(base: Setpoints, arm: ProtocolArm): Setpoints {
  if (arm.setpoints === null) return base;
  const stated = Object.fromEntries(
    Object.entries(arm.setpoints).filter(([, value]) => value !== null && value !== ''),
  );
  return { ...base, ...stated };
}

/**
 * The conditions every arm agrees on, each arm resolved first — a transcription of the service's
 * `render.shared_setpoints`. Fields the arms disagree on come back at their default, so
 * `Conditions` and the run sheet complement each other.
 */
export function sharedSetpoints(design: ExperimentDesign): Setpoints {
  if (design.arms.length === 0) return design.base.setpoints;
  const resolved = design.arms.map((arm) => setpointsFor(design.base.setpoints, arm));
  const [first, ...rest] = resolved as [Setpoints, ...Setpoints[]];
  const agreed = Object.fromEntries(
    Object.entries(first).filter(([field, value]) =>
      rest.every((other) => other[field as keyof Setpoints] === value),
    ),
  );
  return { ...EMPTY_SETPOINTS, ...agreed };
}

/** Every `Setpoints` field at the model's own default — what a disagreed-about field falls back to. */
const EMPTY_SETPOINTS: Setpoints = {
  temperature_c: null,
  time_h: null,
  pressure_bar: null,
  atmosphere: '',
  concentration_molar: null,
  solvent: '',
  ph: null,
};

/** Every `DesignStatus` in lifecycle order (the order buttons render in). */
export const DESIGN_STATUSES: readonly DesignStatus[] = [
  'requested',
  'draft',
  'approved',
  'executed',
  'abandoned',
];

/**
 * Which move each status permits — a transcription of the service's `_LEGAL_MOVES`
 * (`src/chemclaw/protocols/store.py`), so only moves that can succeed are offered.
 * `tests/protocolStatusTransitions.test.ts` compares it with a sibling checkout. `draft ->
 * executed` is absent; `abandoned -> draft` is present.
 */
export const LEGAL_STATUS_MOVES: Record<DesignStatus, readonly DesignStatus[]> = {
  requested: ['draft', 'abandoned'],
  draft: ['approved', 'abandoned'],
  approved: ['executed', 'draft', 'abandoned'],
  executed: ['abandoned'],
  abandoned: ['draft'],
};

/**
 * Statuses that assert something about a procedure (the service's `_NEEDS_A_PROTOCOL`); refused for
 * a design holding only the ask.
 */
export const STATUSES_NEEDING_A_PROTOCOL: readonly DesignStatus[] = ['approved', 'executed'];

/**
 * The moves this design can be given — the service's `require_movable` as a filter: the transition
 * table, `_NEEDS_A_PROTOCOL`, and `requested` meaning the ask alone. `headKind` is the head
 * revision's. Self-transitions are omitted deliberately; a stale page gets a `status_conflict` and
 * re-reads.
 */
export function legalStatusMoves(
  current: DesignStatus,
  headKind: RevisionKind,
): readonly DesignStatus[] {
  // `?? []`: a status this build does not know yields no buttons rather than a crash.
  return (LEGAL_STATUS_MOVES[current] ?? []).filter((target) => {
    if (STATUSES_NEEDING_A_PROTOCOL.includes(target)) return headKind === 'protocol';
    if (target === 'requested') return headKind !== 'protocol';
    return true;
  });
}
