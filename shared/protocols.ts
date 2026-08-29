/**
 * The experiment-protocol contract — a mirror of the service's protocol schemas.
 *
 * A protocol is the one thing in this system that a human *edits*. Everything else the service
 * produces is a reading (a hazard screen, a pKa, a Pareto front) that a chemist consults and does
 * not change; a design is a document the agent drafts and a chemist then corrects, and every
 * correction is a new revision attributable to whoever wrote it. That is why the types below carry
 * so much apparatus that a plain "result" shape would not: a parent revision, a change note, a
 * check list, a diff.
 *
 * Two properties of this contract decide how the UI is built on it, and both are easy to lose:
 *
 * **`FieldBasis` is the honesty story, not a decoration.** A request field is `stated` (the chemist
 * said it, and `quote` is the words they used), `inferred` (the agent filled it in from context) or
 * `absent`. Rendering an inferred scale the same as a stated one turns the agent's guess into the
 * chemist's instruction, which is the single most consequential thing this document can get wrong —
 * a scale nobody stated is a vessel charge nobody agreed to.
 *
 * **A check that failed is not the same as a check that blocks.** `ProtocolCheck.passed` is per
 * check; `ProtocolReceipt.blocking` is the subset that stops the design being executed. A surface
 * that collapsed the two would either alarm on a note or stay quiet on a blocker.
 *
 * Kept in `shared/` beside `events.ts` for the same reason that file is: it is a contract owned by
 * another repository, mirrored here by hand, and imported by both the SPA (bundled by Vite) and the
 * e2e fixture service (run under Node's type stripping). Keep it dependency-free.
 *
 * Nothing here streams. These types describe REST bodies (`/protocols…`) and one *tool result*
 * payload (`ProtocolReceipt`), so `shared/events.ts` is deliberately untouched — an event type
 * added without a branch in `normalizeEvent` is deleted in transit, and there is no event to add.
 */

/** Single experiment, a screen of arms, or a multi-round campaign. */
export type DesignMode = 'single' | 'screen' | 'campaign';

/** Where a design sits between being asked for and being run. */
export type DesignStatus = 'requested' | 'draft' | 'approved' | 'executed' | 'abandoned';

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
 * One field of the structured request, with where it came from.
 *
 * `quote` is the chemist's own words and is only meaningful when `basis` is `stated` — it is what
 * lets a reader check the transcription rather than trust it.
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
 * What the design is expected to produce, and on what grounds.
 *
 * `basis` is the load-bearing field: a `precedent` yield is a number from a record, a `predicted`
 * one came from a model, and an `assumed` one is somebody's expectation. They read identically as
 * a percentage.
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
 * One arm of a screen — a point in the factor space, plus whatever it overrides.
 *
 * `setpoints: null` means "the base conditions", not "no conditions". `control` distinguishes the
 * runs that exist to calibrate the others from the runs being screened.
 */
export interface ProtocolArm {
  arm_id: string;
  /** Factor name → the level's `label`. */
  levels: Record<string, string>;
  setpoints: Setpoints | null;
  /**
   * There is deliberately no per-arm charge override. An arm that varies an *amount* declares that
   * amount as a continuous factor, which says the same thing in the vocabulary the design already
   * has; the field existed, had no producer, and inlined the whole `ChargeLine` model into every
   * tool schema. A control that genuinely differs says so in `note`.
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

/**
 * The plate, and whether its run order was randomised.
 *
 * `randomized` with a `seed` is what makes a layout reproducible; a randomised layout with no seed
 * cannot be reproduced and the map says so rather than implying it can.
 */
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
export interface DesignRevision {
  design_id: string;
  revision: number;
  kind: 'request' | 'protocol';
  author_kind: 'agent' | 'human';
  author: string;
  parent_revision: number;
  change_note: string;
  design: ExperimentDesign;
  checks: ProtocolCheck[];
  created_at: string;
}

/** A revision as the history lists it — everything but the document itself. */
export interface RevisionSummary {
  revision: number;
  kind: 'request' | 'protocol';
  author_kind: 'agent' | 'human';
  author: string;
  change_note: string;
  created_at: string;
  blockers: number;
}

/**
 * One recorded lifecycle move: which revision somebody signed off on, and why.
 *
 * The header's `status` describes the HEAD and moves with it — a revision landing on an approved
 * design demotes it back to `draft`, because an approval is a statement about a document and the
 * document changed. So the badge can never say which document a chemist actually approved, and
 * this is the only thing that can.
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
 * What `GET /protocols/{id}` returns: one revision, FLAT, with the design's header and history
 * beside it.
 *
 * Transcribed from the service rather than shaped for the screen, which is the whole point.
 * `client.ts` used to declare this as `{ revision: DesignRevision; history: RevisionSummary[] }`,
 * and every fixture and stub in this repository emitted that nested shape — so `revision.design`
 * was `undefined` against the real service and the document page threw on its first field, under a
 * green unit suite and a green end-to-end run. A fixture is only evidence when it is the service's
 * shape.
 *
 * Not `extends DesignRevision`: the service does not send `parent_revision` here, and inheriting
 * the field would put the same class of invented promise back one level down.
 */
export interface DesignOut {
  design_id: string;
  /** The header row — status, counts, timestamps. `null` for a design with no header yet. */
  summary: DesignSummary | null;
  revision: number;
  kind: 'request' | 'protocol';
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

/**
 * One arm flattened for a run sheet — the row a chemist works from at the bench.
 *
 * Deliberately not `ProtocolArm`: it resolves the arm's conditions against the base, so `solvent`
 * and `temperature_c` here are what that arm actually runs at rather than what it overrides.
 */
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
 * What the protocol tools return into the conversation.
 *
 * `arms` is capped and `arms_omitted` says by how much, so a card built from this can never be
 * mistaken for the whole run sheet — the full design is behind `/protocols/{design_id}`.
 */
export interface ProtocolReceipt {
  design_id: string;
  revision: number;
  title: string;
  mode: string;
  status: DesignStatus;
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
