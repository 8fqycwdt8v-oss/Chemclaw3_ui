/**
 * The request and response models of the service, under the names this UI uses.
 *
 * Every model here is an alias of a type generated from the pinned core contract
 * (`shared/generated/api.ts`); none is declared by hand. What is written here is the part of the
 * reading that is not a fact of the document:
 *
 *  - `Served` — the document marks a field with a default as optional (it may be absent from a
 *    stored event), but the service serialises every field of a response model, so a response is
 *    read as complete. Request models are used as generated.
 *  - `Loosen` — fields this UI tolerates being absent beyond what the document promises (a
 *    rollout against an older service), so a constructor in a test or fixture need not name them.
 *  - Narrowings of a field the document types as a bare `string` where the UI reads two values.
 *
 * Imported by the SPA, the BFF and the e2e fixture service; types only, erased at build.
 */

import type { components } from './generated/api.ts';

export type Schemas = components['schemas'];

/**
 * A response model read as the service sends it: every field present, `undefined` removed, down
 * through nested models. `null` stays — it is a value the service sends.
 */
export type Served<T> = T extends readonly (infer U)[]
  ? Served<U>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { [K in keyof T]-?: Served<Exclude<T[K], undefined>> }
      : T;

/**
 * Make some keys optional to write while present to read. Several fields are always populated by
 * the service but tolerated absent here, so constructors (tests, fixtures) need not name them.
 */
export type Loosen<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

/* ── sessions and transcripts ────────────────────────────────────────────── */

export type SessionSummary = Loosen<
  Served<Schemas['SessionSummary']>,
  'created_at' | 'updated_at' | 'title'
>;
export type SessionOut = Served<Schemas['SessionOut']>;
export type Authorship = Loosen<Served<Schemas['Authorship']>, 'actor' | 'agent'>;
export type TranscriptTurnStatus = NonNullable<Schemas['TranscriptMessage']['turn_status']>;
export type TranscriptToolCall = Loosen<
  Served<Schemas['TranscriptToolCall']>,
  'result_ref' | 'result_cut'
>;
export type TranscriptMessage = Loosen<
  Omit<Served<Schemas['TranscriptMessage']>, 'tool_calls' | 'author'> & {
    tool_calls: TranscriptToolCall[];
    author: Authorship | null;
  },
  'correlation_id' | 'author' | 'turn_status'
>;
export type SessionMemberOut = Served<Schemas['SessionMemberOut']>;
export type SessionMembersOut = Served<Schemas['SessionMembersOut']>;
export type QueuedMessageOut = Served<Schemas['QueuedMessageOut']>;
export type SessionQueueOut = Served<Schemas['SessionQueueOut']>;
export type SharedSessionSummary = Loosen<
  Served<Schemas['SharedSessionSummary']>,
  'owner' | 'title'
>;
export type AttachmentSummary = Served<Schemas['AttachmentSummary']>;
export type StoredToolResult = Served<Schemas['StoredToolResult']>;

/* ── jobs, check-ins, pending requests ───────────────────────────────────── */

export type JobRecordSummary = Served<Schemas['JobRecordSummary']>;
export type DurableJobStatus = Served<Schemas['DurableJobStatus']>;
export type Digest = Served<Schemas['Digest']>;
export type CheckInOut = Served<Schemas['CheckInOut']>;
export type PendingRequest = Loosen<Served<Schemas['PendingRequestOut']>, 'reminders'>;
export type PendingRequestsOut = Omit<Served<Schemas['PendingRequestsOut']>, 'requests'> & {
  requests: PendingRequest[];
};

/* ── notes ───────────────────────────────────────────────────────────────── */

/** `artifact_refs` and `calc_refs` are sent and not read by any surface yet. */
export type NoteRef = Loosen<Served<Schemas['NoteRef']>, 'artifact_refs' | 'calc_refs'>;
export type NeighborRef = Loosen<
  Served<Schemas['NeighborRef']>,
  'artifact_refs' | 'calc_refs' | 'relations_in' | 'relations_out'
>;
export type NoteView = Omit<Served<Schemas['NoteView']>, 'note' | 'neighbors'> & {
  note: NoteRef;
  neighbors: NeighborRef[];
};

/* ── plans, proposals, skills ────────────────────────────────────────────── */

export type PlanStatusOut = Loosen<Served<Schemas['PlanStatusOut']>, 'scope' | 'author'>;
export type PendingPlan = Loosen<Served<Schemas['PendingPlan']>, 'scope' | 'owner'>;
export type PendingPlansOut = Loosen<
  Omit<Served<Schemas['PendingPlansOut']>, 'plans'> & { plans: PendingPlan[] },
  'truncated'
>;
export type ProposalOut = Loosen<Served<Schemas['ProposalOut']>, 'decided_by' | 'reason'>;
export type ProposalsOut = Served<Schemas['ProposalsOut']>;
export type LocalSkillOut = Served<Schemas['LocalSkillOut']>;
export type OrgSkillOut = Served<Schemas['OrgSkillOut']>;
export type LocalSkillsOut = Served<Schemas['LocalSkillsOut']>;
export type OrgSkillsOut = Served<Schemas['OrgSkillsOut']>;
export type OrgSkillVersion = Served<Schemas['OrgSkillVersionOut']>;
export type OrgSkillVersionsOut = Served<Schemas['OrgSkillVersionsOut']>;

/* ── requests ────────────────────────────────────────────────────────────── */

export type MessageIn = Schemas['MessageIn'];
export type PlanDecisionIn = Schemas['PlanDecisionIn'];
export type DecisionIn = Schemas['DecisionIn'];
export type PendingAnswerIn = Schemas['PendingAnswerIn'];
export type SessionIn = Schemas['SessionIn'];
export type LocalSkillIn = Schemas['LocalSkillIn'];
export type OrgSkillIn = Schemas['OrgSkillIn'];
export type OrgSkillRevertIn = Schemas['OrgSkillRevertIn'];
export type StatusIn = Schemas['StatusIn'];
export type RevisionIn = Schemas['RevisionIn'];
export type ExhibitIn = Schemas['ExhibitIn'];
export type ExhibitRevisionIn = Schemas['ExhibitRevisionIn'];
