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

/**
 * What a revision holds: the structured ask alone, or a procedure.
 *
 * Not decoration on a badge. The service derives this column from `has_protocol` at the instant the
 * revision is written, and `require_movable` reads it to decide whether a design has a procedure to
 * approve — so it is half of the answer to "which sign-off buttons can succeed". See
 * `legalStatusMoves` at the foot of this file.
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
 * `DesignRevision` below is *derived* from this rather than declared beside it, for the same
 * reason: it used to be a hand-written interface carrying a `parent_revision` the service never
 * sends on any read, and every fixture spread it into a `DesignOut` — where TypeScript's
 * excess-property check does not fire on a spread, so the invented field rode along silently.
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

/**
 * The per-revision half of `DesignOut` — what differs from one revision to the next.
 *
 * An alias rather than an interface so it cannot drift from what the service actually returns:
 * `summary`, `history` and `status_history` are facts about the *design*, and a fixture that
 * builds one revision does not want to restate them.
 */
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
  /**
   * Whether the checks below were graded against a *procedure*.
   *
   * At the request stage the service reports every protocol-only check as a **passing** note
   * reading "not checked yet — this design holds only the ask", precisely so a UI would not look
   * like it had skipped them. So a reader that counts passes has to know which stage it is reading,
   * and `status` is only a proxy for that: `advanced()` decides the status and `has_protocol`
   * decides the stage, independently. A `draft` or `approved` design edited back down to the bare
   * ask keeps its status, and the receipt card then showed a green "15 checks passed" over a design
   * with no charge table, no procedure and no evidence.
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
 * An arm's own setpoints over the shared body's, **field by field**.
 *
 * The one authority on this is the service's `ExperimentDesign.setpoints_for`, and this is a
 * transcription of it rather than a second opinion. `arm.setpoints ?? design.base.setpoints` — what
 * this replaced — falls back only when the arm states *nothing*, so an arm overriding one field
 * lost every other: an arm setting `temperature_c: 60` rendered a run-sheet row with no reaction
 * time and no solvent, beside rows that had both. That is the bug the service measured, fixed and
 * documented, reimplemented on the surface a chemist actually reads.
 *
 * A field counts as stated when it is not the model's default: `null` for the numbers, `''` for the
 * two strings.
 */
export function setpointsFor(base: Setpoints, arm: ProtocolArm): Setpoints {
  if (arm.setpoints === null) return base;
  const stated = Object.fromEntries(
    Object.entries(arm.setpoints).filter(([, value]) => value !== null && value !== ''),
  );
  return { ...base, ...stated };
}

/**
 * The conditions **every arm agrees on**, each arm resolved against the shared body first.
 *
 * A transcription of the service's `render.shared_setpoints`, and the same argument holds on this
 * surface: `Conditions` rendered `design.base.setpoints` — what the body happens to hold, which is
 * not what anybody runs the moment an arm overrides it — while the run sheet carries a column only
 * where the arms *disagree*. So a field every arm overrode to the same value fell through both.
 * Measured on the service with three arms all set to `N2` over a body reading `air`: the page said
 * "Atmosphere: air", there was no atmosphere column, and the atmosphere the design is run under
 * appeared nowhere on a document a chemist runs from.
 *
 * A field the arms disagree about comes back at its default, so the caller drops it and the run
 * sheet shows it per row. That is what makes the two sections complements rather than two lists
 * somebody keeps in step by hand.
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

/**
 * Every `DesignStatus`, in lifecycle order.
 *
 * The order is the lifecycle's, not the alphabet's, because it is what the sign-off panel renders
 * in: a chemist reading three buttons left to right is reading the design's remaining path.
 */
export const DESIGN_STATUSES: readonly DesignStatus[] = [
  'requested',
  'draft',
  'approved',
  'executed',
  'abandoned',
];

/**
 * Which lifecycle move each status permits — a **transcription of `_LEGAL_MOVES`** in the service's
 * `src/chemclaw/protocols/store.py`, read by `require_movable` and enforced nowhere else.
 *
 * This is the second definition of something another repository owns, and it is here for the same
 * reason `setpointsFor` is: the surface a chemist acts on cannot ask the service what it would
 * accept before drawing a button. Before it existed, `ProtocolDocument` rendered a *Mark X* button
 * for all five statuses whatever the design was, so a draft protocol offered *Mark requested* and
 * *Mark executed* — two clicks that can only ever be refused, on the one screen where a refusal
 * reads as "your sign-off did not happen".
 *
 * The drift this creates is real and is why `tests/protocolStatusTransitions.test.ts` exists: it
 * reads the service's own module out of a sibling checkout and fails on any difference, and says
 * out loud when there is no checkout to read rather than passing on a check it did not perform.
 *
 * Two edges are worth knowing without opening the service: `draft -> executed` is **absent**
 * because it is running an experiment nobody signed off, and `abandoned -> draft` is **present**
 * because reviving a design somebody retired is a thing a person does.
 */
export const LEGAL_STATUS_MOVES: Record<DesignStatus, readonly DesignStatus[]> = {
  requested: ['draft', 'abandoned'],
  draft: ['approved', 'abandoned'],
  approved: ['executed', 'draft', 'abandoned'],
  executed: ['abandoned'],
  abandoned: ['draft'],
};

/**
 * The statuses that assert something about a *procedure* — the service's `_NEEDS_A_PROTOCOL`.
 *
 * A design holding only the structured ask has no procedure, so neither word can be true of it and
 * the service refuses both with a 422 whatever the table above says.
 */
export const STATUSES_NEEDING_A_PROTOCOL: readonly DesignStatus[] = ['approved', 'executed'];

/**
 * The moves this design can actually be given, from where it is and from what its head holds.
 *
 * A transcription of the service's `require_movable`, read as a filter rather than as a refusal:
 * the three rules it enforces are the transition table, `_NEEDS_A_PROTOCOL` (a status about a
 * procedure needs a procedure), and its mirror image (`requested` means the ask *alone*, so a
 * protocol head contradicts it).
 *
 * **`headKind` is the head revision's, not the one on screen.** They are the same whenever a move
 * can succeed at all — a sign-off names the revision it was made on and the service refuses
 * anything but the head — so a reader looking at an older revision is offered the head's moves and
 * gets a `revision_conflict` if they take one, which is the honest refusal for what they did.
 *
 * **Every `X -> X` repeat is deliberately absent**, and that is this repository's decision rather
 * than the service's: `require_movable` exempts a self-transition from the table so that pressing
 * a button twice is a 204 rather than a 422. A button reading *Mark draft* on a design that is
 * already draft is not a move a chemist is choosing between, though, so the panel does not carry
 * one. What is left is a page that has not caught up — where the client sends the status it was
 * showing, and `require_unmoved` refuses it as a `status_conflict` rather than taking it as a
 * repeat — and `ProtocolDocument` answers that by re-reading the design, so the chemist sees the
 * move that already landed instead of being offered the chance to make it twice.
 */
export function legalStatusMoves(
  current: DesignStatus,
  headKind: RevisionKind,
): readonly DesignStatus[] {
  // `?? []` for the reason `STATUS_TONE` carries one: `DesignStatus` is closed here and open on
  // the wire, and a status this build has never heard of must cost a chemist an empty button row
  // rather than the document page they were reading.
  return (LEGAL_STATUS_MOVES[current] ?? []).filter((target) => {
    if (STATUSES_NEEDING_A_PROTOCOL.includes(target)) return headKind === 'protocol';
    if (target === 'requested') return headKind !== 'protocol';
    return true;
  });
}
