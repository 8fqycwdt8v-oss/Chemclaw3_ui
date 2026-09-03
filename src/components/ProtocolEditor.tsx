/**
 * Correcting a protocol the agent drafted.
 *
 * This is the only place in the app where a human *writes* a document rather than deciding one, and
 * the shape of it follows from that. Three rules, each of which this repository already applies to
 * its other irreversible, attributable writes.
 *
 * **A save is a new revision, never an overwrite.** The document posted carries the
 * `parent_revision` it was edited against, so a save built on a revision that is no longer the head
 * is refused by the service rather than silently rebased. That 409 is the case worth getting right
 * and is the reason the state machine below has a `conflict` branch of its own: two chemists
 * editing one design is the ordinary case in a lab, and a save that quietly discarded the other
 * one's work while reporting success is the worst outcome this screen can produce. The handling
 * mirrors `decidePlan`'s `plan_changed` exactly — say what happened, offer the reload, and never
 * re-post the same edit against the new parent, which would be writing against a document nobody
 * read.
 *
 * **A change note is required before Save is live.** Same rule as the review queue's rejection
 * reason, for the same reason: a revision that moved four setpoints and says nothing about why
 * tells the next reader — and the agent, which reads this history — nothing at all.
 *
 * **Only the fields a chemist actually changes are editable.** Setpoints, charges, step text,
 * factor levels, per-arm overrides and analytics. Not the request (that is a record of what was
 * asked, and editing it would rewrite history), not the evidence (it is what the design rests on,
 * not part of it), not the plate layout (it is derived from the arms, and hand-editing a well
 * assignment would put the map and the arms out of step with nothing to notice).
 */

import { useState } from 'react';
import { api } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import type {
  Analytic,
  DesignOut,
  ExperimentDesign,
  FactorLevel,
  ProtocolArm,
  Setpoints,
} from '../../shared/protocols.ts';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';

/** A deep copy of the document to edit. The wire shape is plain JSON, so this is lossless. */
const clone = (design: ExperimentDesign): ExperimentDesign =>
  JSON.parse(JSON.stringify(design)) as ExperimentDesign;

/**
 * A numeric field that keeps what is being typed.
 *
 * The obvious form — a controlled `type="number"` driven straight off the document — deletes the
 * value halfway through `1.5`: after `1.` the input's own `value` reads empty, the parse yields
 * `null`, and the re-render clears what the chemist was typing. So the text is local and the
 * document is only updated when the text parses. A half-typed `-` or `1.` leaves the last valid
 * value in place rather than a `null` nobody asked for.
 *
 * Empty is a real value here and means *unset*, which is not zero: an unstated pressure is not one
 * bar and an unstated pH is not neutral.
 */
/**
 * Whether the box still says this value — the question `NumberField` resynchronises on.
 *
 * Not `String(value) === text`: `05`, `1.50` and `1e5` all *say* their value while differing from
 * its canonical spelling, and rewriting them is what threw a chemist's caret to the end of the box
 * mid-edit. Text that does not parse at all is somebody part-way through typing (`1e`, `-`, `1.`)
 * and is never overwritten; it is only when the box parses to a **different** number, or sits empty
 * against a value that is not null, that the display is stale.
 */
function textStillMeans(text: string, value: number | null): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return value === null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  return parsed === value;
}

function NumberField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number | null;
  unit?: string;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value === null ? '' : String(value));
  // **The box is a draft of the field, not a second source of truth for it.** `text` was seeded
  // once and never resynchronised, and the arm `<li>` key is stable, so "Clear override" set the
  // arm's setpoints to null while the input went on showing the old number: the form displayed
  // 60 °C for an arm that would be saved inheriting the base's 80 °C, and the Save posted the null.
  //
  // **The first version keyed that on `value` changing and did disturb mid-typing**, contrary to
  // its own comment: `text` and `value` agree as *numbers* while a chemist types and not as
  // strings, so every keystroke that moved the parsed value rewrote the box with `String(value)`.
  // Measured through the real editor — `1` `e` `5` became `100000`, `0` `5` became `5`, and
  // inserting a `2` into `1.50` gave back `12.5` with the trailing zero gone and the caret thrown
  // to the end. Nothing was ever *saved* wrong; what was lost is the text the chemist was typing.
  //
  // So the question is not "did the value change" but "does this box still say the value" —
  // `textStillMeans`. Mid-typing text that does not parse (`1e`, `-`, `1.`) is the chemist's and is
  // left alone; a box that parses to something else, or is empty against a value that is not, is
  // stale and is rewritten. That covers the case this was written for and no other.
  if (!textStillMeans(text, value)) {
    setText(value === null ? '' : String(value));
  }
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink-muted">
        {label}
        {unit && <span className="text-ink-subtle"> ({unit})</span>}
      </span>
      <input
        // `inputMode` rather than `type="number"`: the spinner is useless for a setpoint and the
        // type's own value sanitising is what breaks mid-decimal typing.
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const trimmed = raw.trim();
          if (trimmed === '') {
            onChange(null);
            return;
          }
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        placeholder="unset"
        className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 font-mono tabular-nums outline-none focus-ring"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 outline-none focus-ring"
      />
    </label>
  );
}

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">{title}</h3>
      {note && <p className="text-xs text-ink-muted">{note}</p>}
      {children}
    </section>
  );
}

type State =
  | { status: 'editing' }
  | { status: 'saving' }
  | { status: 'conflict' }
  | { status: 'failed'; message: string };

export function ProtocolEditor({
  designId,
  revision,
  open,
  onOpenChange,
  onSaved,
  onReload,
}: {
  designId: string;
  /**
   * The read being edited — `GET /protocols/{id}`'s own flat shape. Its `revision` NUMBER is the
   * `parent_revision` the save posts.
   *
   * `DesignOut` rather than `DesignRevision`: the service does not return a nested revision object
   * here, and typing it as one is how `revision.design` came to be `undefined` on the document
   * page under a green suite.
   */
  revision: DesignOut;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new revision number, so the document view can move to it. */
  onSaved: (revision: number) => void;
  /** Re-read the design from the service after somebody else's revision landed. */
  onReload: () => void;
}): React.JSX.Element {
  // Seeded once per mount. The document view keys this component on the revision it opened, so a
  // reload after a conflict remounts with the new head rather than merging into a stale draft.
  const [draft, setDraft] = useState<ExperimentDesign>(() => clone(revision.design));
  const [note, setNote] = useState('');
  const [state, setState] = useState<State>({ status: 'editing' });
  const { auth } = useAuth();

  const setSetpoint = <K extends keyof Setpoints>(key: K, value: Setpoints[K]): void =>
    setDraft((d) => ({
      ...d,
      base: { ...d.base, setpoints: { ...d.base.setpoints, [key]: value } },
    }));

  const setChargeField = (
    index: number,
    key: 'equivalents' | 'amount_mmol' | 'mass_mg' | 'volume_ml',
    value: number | null,
  ): void =>
    setDraft((d) => ({
      ...d,
      base: {
        ...d.base,
        charge: d.base.charge.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
      },
    }));

  const setStepText = (index: number, text: string): void =>
    setDraft((d) => ({
      ...d,
      base: {
        ...d.base,
        steps: d.base.steps.map((step, i) => (i === index ? { ...step, text } : step)),
      },
    }));

  const setLevel = (factorIndex: number, levelIndex: number, patch: Partial<FactorLevel>): void =>
    setDraft((d) => ({
      ...d,
      factors: d.factors.map((factor, fi) =>
        fi === factorIndex
          ? {
              ...factor,
              levels: factor.levels.map((level, li) =>
                li === levelIndex ? { ...level, ...patch } : level,
              ),
            }
          : factor,
      ),
    }));

  const setArmSetpoint = (
    armIndex: number,
    key: 'temperature_c' | 'time_h',
    value: number | null,
  ): void =>
    setDraft((d) => ({
      ...d,
      arms: d.arms.map((arm, i) =>
        i === armIndex
          ? {
              ...arm,
              // An arm with no override yet gets one seeded from the base, so the override says
              // what the arm runs at rather than what it leaves unstated — a `Setpoints` with a
              // single field set and every other one null would silently unset the solvent.
              setpoints: { ...(arm.setpoints ?? d.base.setpoints), [key]: value },
            }
          : arm,
      ),
    }));

  const clearArmOverride = (armIndex: number): void =>
    setDraft((d) => ({
      ...d,
      arms: d.arms.map((arm, i) => (i === armIndex ? { ...arm, setpoints: null } : arm)),
    }));

  const setAnalytic = (index: number, patch: Partial<Analytic>): void =>
    setDraft((d) => ({
      ...d,
      base: {
        ...d.base,
        analytics: d.base.analytics.map((a, i) => (i === index ? { ...a, ...patch } : a)),
      },
    }));

  const save = async (): Promise<void> => {
    setState({ status: 'saving' });
    try {
      const written = await api.putProtocolRevision(
        designId,
        draft,
        revision.revision,
        note.trim(),
        auth,
      );
      onSaved(written.revision);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'revision_conflict') {
        setState({ status: 'conflict' });
        return;
      }
      setState({
        status: 'failed',
        message: err instanceof Error ? err.message : 'The revision was not written.',
      });
    }
  };

  const busy = state.status === 'saving';
  const armSummary = (arm: ProtocolArm): string =>
    Object.entries(arm.levels)
      .map(([name, level]) => `${name} ${level}`)
      .join(', ');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" title="Edit the protocol" className="w-[min(56rem,95vw)]">
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <p className="text-xs text-ink-muted">
            Editing revision {revision.revision} of <span className="font-mono">{designId}</span>.
            Saving writes a new revision attributed to you; nothing is overwritten.
          </p>

          {state.status === 'conflict' && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-ink"
            >
              <p>
                <strong>Somebody else edited this.</strong> Revision {revision.revision} is no
                longer the latest, so this edit was written against a document that has since moved.
                Nothing was saved — re-reading it is the only safe next step, because re-posting
                these values now would discard whatever they changed.
              </p>
              <div>
                <Button size="sm" variant="outline" onClick={onReload}>
                  Reload the design
                </Button>
              </div>
            </div>
          )}

          {state.status === 'failed' && (
            <p role="alert" className="text-sm text-danger-ink">
              {state.message}
            </p>
          )}

          <Section
            title="Conditions"
            note="The base setpoints every arm runs at unless it overrides them. An empty field is unset, which is not zero."
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <NumberField
                label="Temperature"
                unit="°C"
                value={draft.base.setpoints.temperature_c}
                onChange={(v) => setSetpoint('temperature_c', v)}
              />
              <NumberField
                label="Time"
                unit="h"
                value={draft.base.setpoints.time_h}
                onChange={(v) => setSetpoint('time_h', v)}
              />
              <NumberField
                label="Pressure"
                unit="bar"
                value={draft.base.setpoints.pressure_bar}
                onChange={(v) => setSetpoint('pressure_bar', v)}
              />
              <NumberField
                label="Concentration"
                unit="M"
                value={draft.base.setpoints.concentration_molar}
                onChange={(v) => setSetpoint('concentration_molar', v)}
              />
              <NumberField
                label="pH"
                value={draft.base.setpoints.ph}
                onChange={(v) => setSetpoint('ph', v)}
              />
              <TextField
                label="Solvent"
                value={draft.base.setpoints.solvent}
                onChange={(v) => setSetpoint('solvent', v)}
              />
              <TextField
                label="Atmosphere"
                value={draft.base.setpoints.atmosphere}
                onChange={(v) => setSetpoint('atmosphere', v)}
              />
            </div>
          </Section>

          {draft.base.charge.length > 0 && (
            <Section
              title="Charge"
              note="Equivalents are relative to the limiting species. Amounts are what actually goes into the vessel."
            >
              <ul className="flex flex-col gap-3">
                {draft.base.charge.map((line, index) => (
                  <li
                    key={`${line.component}-${index}`}
                    className="rounded-lg border border-border-subtle bg-surface-raised p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{line.component}</span>
                      <span className="text-2xs text-ink-subtle">{line.role}</span>
                      {line.limiting && (
                        <span className="text-2xs text-brand-ink">limiting species</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <NumberField
                        label={`${line.component} equivalents`}
                        value={line.equivalents}
                        onChange={(v) => setChargeField(index, 'equivalents', v)}
                      />
                      <NumberField
                        label={`${line.component} amount`}
                        unit="mmol"
                        value={line.amount_mmol}
                        onChange={(v) => setChargeField(index, 'amount_mmol', v)}
                      />
                      <NumberField
                        label={`${line.component} mass`}
                        unit="mg"
                        value={line.mass_mg}
                        onChange={(v) => setChargeField(index, 'mass_mg', v)}
                      />
                      <NumberField
                        label={`${line.component} volume`}
                        unit="mL"
                        value={line.volume_ml}
                        onChange={(v) => setChargeField(index, 'volume_ml', v)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {draft.base.steps.length > 0 && (
            <Section title="Procedure">
              <ol className="flex flex-col gap-2">
                {draft.base.steps.map((step, index) => (
                  <li key={`${step.index}-${index}`}>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-ink-muted">
                        Step {index + 1} · {step.kind}
                      </span>
                      <textarea
                        value={step.text}
                        rows={2}
                        onChange={(e) => setStepText(index, e.target.value)}
                        className="resize-y rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-sm outline-none focus-ring"
                      />
                    </label>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {draft.factors.length > 0 && (
            <Section
              title="Factors"
              note="A level's label is what the run sheet and the plate map show; the value is what a continuous factor is set to."
            >
              <ul className="flex flex-col gap-3">
                {draft.factors.map((factor, factorIndex) => (
                  <li
                    key={`${factor.name}-${factorIndex}`}
                    className="rounded-lg border border-border-subtle bg-surface-raised p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{factor.name}</span>
                      <span className="text-2xs text-ink-subtle">
                        {factor.kind}
                        {factor.unit && ` · ${factor.unit}`}
                      </span>
                    </div>
                    <ul className="mt-2 flex flex-col gap-2">
                      {factor.levels.map((level, levelIndex) => (
                        <li key={levelIndex} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <TextField
                            label={`${factor.name} level ${levelIndex + 1} label`}
                            value={level.label}
                            onChange={(v) => setLevel(factorIndex, levelIndex, { label: v })}
                          />
                          {factor.kind === 'continuous' && (
                            <NumberField
                              label={`${factor.name} level ${levelIndex + 1} value`}
                              unit={factor.unit || level.unit}
                              value={level.value}
                              onChange={(v) => setLevel(factorIndex, levelIndex, { value: v })}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {draft.arms.length > 0 && (
            <Section
              title="Arm overrides"
              note="An arm with no override runs at the base conditions above. Setting one here seeds it from the base, so the arm states what it runs at rather than unsetting everything else."
            >
              <ul className="flex flex-col gap-3">
                {draft.arms.map((arm, index) => (
                  <li
                    key={arm.arm_id || index}
                    className="rounded-lg border border-border-subtle bg-surface-raised p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">
                        <span className="font-mono">{arm.arm_id}</span>{' '}
                        <span className="text-ink-muted">{armSummary(arm)}</span>
                      </span>
                      {arm.setpoints && (
                        <Button size="xs" variant="ghost" onClick={() => clearArmOverride(index)}>
                          Clear override
                        </Button>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <NumberField
                        label={`${arm.arm_id} temperature`}
                        unit="°C"
                        value={arm.setpoints?.temperature_c ?? null}
                        onChange={(v) => setArmSetpoint(index, 'temperature_c', v)}
                      />
                      <NumberField
                        label={`${arm.arm_id} time`}
                        unit="h"
                        value={arm.setpoints?.time_h ?? null}
                        onChange={(v) => setArmSetpoint(index, 'time_h', v)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {draft.base.analytics.length > 0 && (
            <Section title="Analytics">
              <ul className="flex flex-col gap-3">
                {draft.base.analytics.map((analytic, index) => (
                  <li
                    key={index}
                    className="grid grid-cols-1 gap-3 rounded-lg border border-border-subtle bg-surface-raised p-3 sm:grid-cols-3"
                  >
                    <TextField
                      label={`Analytic ${index + 1} name`}
                      value={analytic.name}
                      onChange={(v) => setAnalytic(index, { name: v })}
                    />
                    <TextField
                      label={`Analytic ${index + 1} timing`}
                      value={analytic.timing}
                      onChange={(v) => setAnalytic(index, { timing: v })}
                    />
                    <TextField
                      label={`Analytic ${index + 1} method`}
                      value={analytic.method}
                      onChange={(v) => setAnalytic(index, { method: v })}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="font-medium">
                Change note <span className="font-normal text-ink-subtle">(required)</span>
              </span>
              {/* Required before Save is live, exactly as the review queue's rejection reason is:
                  a revision that moved four setpoints and says nothing about why tells the next
                  reader, and the agent that reads this history, nothing. */}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What you changed, and why"
                className="resize-y rounded-lg border border-border-subtle bg-surface px-2.5 py-2 outline-none focus-ring"
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <ConfirmDialog
                trigger={
                  <Button size="sm" disabled={busy || !note.trim()}>
                    Save a new revision
                  </Button>
                }
                title="Save this as a new revision?"
                description="The edited protocol is written as a new revision attributed to you, with your change note beside it. Earlier revisions are kept and remain readable; this revision cannot be edited away."
                confirmLabel="Save revision"
                onConfirm={() => void save()}
              />
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
