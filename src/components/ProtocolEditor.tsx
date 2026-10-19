/**
 * Correcting a protocol the agent drafted — the one place a human writes a document.
 *
 * - A save is a new revision against `parent_revision`; a stale base gets a 409 (`conflict` state):
 *   say so, offer a reload, never re-post the same edit against the new head.
 * - A change note is required before Save.
 * - Only what a chemist changes is editable (setpoints, charges, steps, factor levels, arm
 *   overrides, analytics) — not the request, evidence or plate layout.
 */

import { useEffect, useState } from 'react';
import { produce, type Draft } from 'immer';
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

/**
 * A deep copy of the document to edit (plain JSON, lossless). Kept with immer: seeding straight
 * from the page's object would let auto-freeze freeze the page's own state.
 */
const clone = (design: ExperimentDesign): ExperimentDesign =>
  JSON.parse(JSON.stringify(design)) as ExperimentDesign;

/**
 * Whether the box still says this value: compared numerically, so `05`, `1.50` and `1e5` are left
 * as typed; unparseable in-progress text (`1e`, `-`, `1.`) is never overwritten. Only a different
 * number, or empty against a non-null value, is stale.
 */
function textStillMeans(text: string, value: number | null): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return value === null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  return parsed === value;
}

/**
 * A numeric field that keeps what is being typed: the text is local and the document updates only
 * when it parses, so `1.` mid-typing is not cleared. Empty means unset, not zero.
 */
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
  // The box is a draft of the field: resync only when it no longer says the value
  // (`textStillMeans`), e.g. after "Clear override", never mid-typing.
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

/**
 * Whether anything was actually edited: a JSON compare against the seed revision, so changing a
 * value and back is not dirty. Runs on close attempts only.
 */
const isDirty = (draft: ExperimentDesign, original: ExperimentDesign, note: string): boolean =>
  note.trim() !== '' || JSON.stringify(draft) !== JSON.stringify(original);

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
   * The read being edited (`DesignOut`, flat); its `revision` number is the `parent_revision` the
   * save posts.
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
  /** Set when a close was refused because of unsaved edits; cleared by either answer. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const { auth } = useAuth();

  const dirty = (): boolean => isDirty(draft, revision.design, note);

  /**
   * Guard every way of closing an edited form (Escape, overlay click): closing unmounts the editor
   * and loses the draft. A refusal-then-confirm banner in the panel rather than a nested modal.
   */
  const requestClose = (next: boolean): void => {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Not conditioned on `confirmingDiscard`: a second Escape must not discard. Discarding goes
    // through the banner's own button.
    if (dirty()) {
      setConfirmingDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  // The browser's own version of the same guard, for the reload and the closed tab. The text is the
  // browser's to choose — every engine ignores a custom string — so this only asks for the prompt.
  useEffect(() => {
    if (!open) return;
    const warn = (e: BeforeUnloadEvent): void => {
      if (!dirty()) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  /**
   * One edit to the draft via immer's `produce`, which copies exactly the written path. `isDirty`
   * must stay a JSON compare: `produce` returns a new reference even for a value changed and back.
   */
  const edit = (recipe: (draft: Draft<ExperimentDesign>) => void): void =>
    setDraft((current) => produce(current, recipe));

  const setSetpoint = <K extends keyof Setpoints>(key: K, value: Setpoints[K]): void =>
    edit((d) => {
      d.base.setpoints[key] = value;
    });

  // Indexed setters guard the lookup (`noUncheckedIndexedAccess`); a missing index is a no-op.
  const setChargeField = (
    index: number,
    key: 'equivalents' | 'amount_mmol' | 'mass_mg' | 'volume_ml',
    value: number | null,
  ): void =>
    edit((d) => {
      const line = d.base.charge[index];
      if (line) line[key] = value;
    });

  const setStepText = (index: number, text: string): void =>
    edit((d) => {
      const step = d.base.steps[index];
      if (step) step.text = text;
    });

  const setLevel = (factorIndex: number, levelIndex: number, patch: Partial<FactorLevel>): void =>
    edit((d) => {
      const level = d.factors[factorIndex]?.levels[levelIndex];
      if (level) Object.assign(level, patch);
    });

  const setArmSetpoint = (
    armIndex: number,
    key: 'temperature_c' | 'time_h',
    value: number | null,
  ): void =>
    edit((d) => {
      const arm = d.arms[armIndex];
      if (!arm) return;
      // An arm's first override is seeded from the base, so unset fields are not silently cleared.
      arm.setpoints ??= { ...d.base.setpoints };
      arm.setpoints[key] = value;
    });

  const clearArmOverride = (armIndex: number): void =>
    edit((d) => {
      const arm = d.arms[armIndex];
      if (arm) arm.setpoints = null;
    });

  const setAnalytic = (index: number, patch: Partial<Analytic>): void =>
    edit((d) => {
      const analytic = d.base.analytics[index];
      if (analytic) Object.assign(analytic, patch);
    });

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
    <Sheet open={open} onOpenChange={requestClose}>
      <SheetContent
        side="right"
        title="Edit the protocol"
        className="w-[min(56rem,95vw)]"
        // Radix closes on both of these before `onOpenChange` can decline, so the interception has
        // to happen here as well as there.
        onEscapeKeyDown={(e) => {
          // No `confirmingDiscard` in the condition — see `requestClose`. A repeated Escape must
          // keep being refused, not pass on the second press.
          if (dirty()) {
            e.preventDefault();
            setConfirmingDiscard(true);
          }
        }}
        onPointerDownOutside={(e) => {
          if (dirty()) {
            e.preventDefault();
            setConfirmingDiscard(true);
          }
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <p className="text-xs text-ink-muted">
            Editing revision {revision.revision} of <span className="font-mono">{designId}</span>.
            Saving writes a new revision attributed to you; nothing is overwritten.
          </p>

          {confirmingDiscard && (
            <div
              role="alertdialog"
              aria-label="Discard your edits?"
              // Focused and scrolled into view, so the refused close is seen (and announced:
              // `alertdialog` only announces on focus).
              tabIndex={-1}
              ref={(el) => {
                el?.focus();
                el?.scrollIntoView({ block: 'nearest' });
              }}
              className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-ink"
            >
              <p>
                <strong>You have edits that have not been saved.</strong> Closing this panel throws
                them away — there is no draft and nothing to undo.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmingDiscard(false)}>
                  Keep editing
                </Button>
                <Button
                  size="sm"
                  variant="outline-destructive"
                  onClick={() => {
                    setConfirmingDiscard(false);
                    onOpenChange(false);
                  }}
                >
                  Discard my edits
                </Button>
              </div>
            </div>
          )}

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
              {/* Required before Save: a revision should say why it changed. */}
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
              <Button size="sm" variant="outline" onClick={() => requestClose(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
