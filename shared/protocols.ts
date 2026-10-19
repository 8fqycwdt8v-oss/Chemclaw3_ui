/**
 * The experiment-protocol contract. A protocol is the one thing a human edits: the agent drafts, a
 * chemist corrects, and each correction is an attributed revision (parent, change note, checks,
 * diff).
 *
 * The document models are generated from the pinned core contract (`shared/generated/api.ts`) and
 * aliased here under the names the UI uses; what is written by hand is the lifecycle logic below
 * and the one narrowing noted at `RevisionKind`.
 *
 * - `FieldBasis`: a request field is `stated` (with the chemist's `quote`), `inferred` or `absent`;
 *   never render an inference as an instruction.
 * - A failed check is not a blocking one: `ProtocolCheck.passed` is per check;
 *   `ProtocolReceipt.blocking` is the subset that stops execution.
 *
 * REST bodies and one tool-result payload only (nothing streams). Imported by the SPA and the e2e
 * fixture service; dependency-free.
 */

import type { Loosen, Schemas, Served } from './wire.ts';

/** Single experiment, a screen of arms, or a multi-round campaign. */
export type DesignMode = Schemas['DesignSummary']['mode'];

/** Where a design sits between being asked for and being run. */
export type DesignStatus = Schemas['StatusIn']['status'];

/**
 * What a revision holds: the ask alone, or a procedure. Derived by the service from `has_protocol`;
 * decides which sign-offs can succeed (`legalStatusMoves`). The contract types it as a bare string;
 * these are the two values it carries.
 */
export type RevisionKind = 'request' | 'protocol';

/** `blocker` stops execution; `warning` and `note` qualify it. */
export type CheckSeverity = Schemas['ProtocolCheck']['severity'];

/** Where a request field's value came from. See the note at the top of this file. */
export type FieldBasis = Schemas['RequestField']['basis'];

export type SpeciesRole = Schemas['SpeciesRole'];
export type ProtocolStepKind = Schemas['ProtocolStepKind'];

/**
 * One request field with its provenance; `quote` (the chemist's words) is meaningful only when
 * `basis` is `stated`.
 */
export type RequestField = Served<Schemas['RequestField']>;

/** A species as the chemist named it, and what the agent resolved it to. */
export type RequestedComponent = Served<Schemas['RequestedComponent']>;

/** What was asked for, structured, with every field's provenance beside it. */
export type ExperimentRequest = Served<Schemas['ExperimentRequest']>;

/** One level of one factor. `value`/`unit` are populated for a continuous factor. */
export type FactorLevel = Served<Schemas['FactorLevel']>;
export type Factor = Served<Schemas['Factor']>;

/** The conditions a protocol runs at. Every field is nullable: an unset one is not a zero. */
export type Setpoints = Served<Schemas['Setpoints']>;

/** One line of the charge table. `limiting` marks the species the equivalents are relative to. */
export type ChargeLine = Served<Schemas['ChargeLine']>;

/** One step of the written procedure, in the order it is performed. */
export type ProtocolStep = Served<Schemas['ProtocolStep']>;
export type Analytic = Served<Schemas['Analytic']>;

/**
 * The expected outcome and its basis: `precedent` (from a record), `predicted` (from a model) or
 * `assumed`.
 */
export type ExpectedOutcome = Served<Schemas['ExpectedOutcome']>;

/** One thing the design rests on, and which parts of it that thing supports. */
export type EvidenceRef = Served<Schemas['EvidenceRef']>;

/** The protocol every arm is a variation of. */
export type ProtocolBody = Served<Schemas['ProtocolBody']>;

/**
 * One arm of a screen. `setpoints: null` means the base conditions; `control` marks calibration
 * runs. There is no per-arm charge override: an arm varying an amount declares it as a continuous
 * factor; other differences go in `note`.
 */
export type ProtocolArm = Served<Schemas['ProtocolArm']>;

export type Well = Served<Schemas['Well']>;

/** The plate and whether its run order was randomised; reproducible only with a `seed`. */
export type PlateLayout = Served<Schemas['PlateLayout']>;

export type ProtocolCheck = Served<Schemas['ProtocolCheck']>;

/** The whole document: what was asked, what was designed, and what it rests on. */
export type ExperimentDesign = Served<Schemas['ExperimentDesign']>;

/** A revision as the history lists it — everything but the document itself. */
export type RevisionSummary = Omit<Served<Schemas['RevisionSummary']>, 'kind'> & {
  kind: RevisionKind;
};

/**
 * One recorded lifecycle move: which revision was signed off, and why. The header `status` follows
 * the head (a new revision demotes an approval), so this is the only record of what was approved.
 */
export type StatusEvent = Served<Schemas['StatusEvent']>;

export type DesignSummary = Served<Schemas['DesignSummary']>;

/**
 * What `GET /protocols/{id}` returns: one revision, flat, with the design's header and history
 * beside it — the service's exact shape. `DesignRevision` is derived from it.
 */
export type DesignOut = Omit<Served<Schemas['DesignOut']>, 'kind' | 'history'> & {
  kind: RevisionKind;
  history: RevisionSummary[];
};

/** The per-revision half of `DesignOut`, derived so it cannot drift. */
export type DesignRevision = Omit<DesignOut, 'summary' | 'history' | 'status_history'>;

/** `GET /protocols`: the envelope `listProtocols` unwraps. */
export type DesignListOut = Served<Schemas['DesignListOut']>;

/** What `POST /protocols/{id}/revisions` answers with: the revision it wrote, re-checked. */
export type RevisionOut = Served<Schemas['RevisionOut']>;

/** One changed field between two revisions. `before`/`after` are already rendered as text. */
export type FieldChange = Served<Schemas['FieldChange']>;
export type DesignDiff = Served<Schemas['DesignDiff']>;

/**
 * One arm flattened for a run sheet, with its conditions resolved against the base. The setpoints
 * the sheet does not draw (`atmosphere`, `concentration_molar`, `ph`, `pressure_bar`) are sent and
 * not read.
 */
export type ArmRow = Loosen<
  Served<Schemas['ArmRow']>,
  'atmosphere' | 'concentration_molar' | 'ph' | 'pressure_bar'
>;

/**
 * What the protocol tools return into the conversation. `arms` is capped (`arms_omitted` says by
 * how much); the full design is at `/protocols/{design_id}`.
 */
export type ProtocolReceipt = Omit<Served<Schemas['ProtocolReceipt']>, 'arms'> & {
  arms: ArmRow[];
};

/** `read_experiment_protocol` — the receipt, the whole document, and a rendering of it. */
export type ProtocolRead = Omit<Served<Schemas['ProtocolReadout']>, 'receipt'> & {
  receipt: ProtocolReceipt;
};

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
 * The pinned contract does not carry it (`ISSUES.md`). `draft -> executed` is absent;
 * `abandoned -> draft` is present.
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
