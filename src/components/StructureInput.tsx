/**
 * Getting a structure into a message: paste or type SMILES, drop a `.mol`/`.sdf`, or draw it. All
 * three write canonical SMILES into one field, so there is one validation path.
 *
 * Nothing is inserted until RDKit has read and drawn it: Insert is bound to the drawing, never to
 * unaccepted text.
 *
 * A compound name cannot be looked up here (`resolve_compound` is an agent tool with no HTTP
 * route), so the panel offers to ask the agent via `chemclaw:prefill`; the answer's structure comes
 * back with "Use in my message" (`src/components/chem/UseStructure.tsx`).
 */

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, FileUp, PenLine, Sparkles, X } from 'lucide-react';
import {
  MAX_PARSED_SMILES_CHARS,
  moleculesFromMolfile,
  rdkitAvailable,
  readCanonicalSmiles,
  readCanonicalSmilesFromMolblock,
  tooLongToParse,
  type MolfileRecords,
  type NotAChemicalVerdict,
} from '../chem/rdkit.ts';
import { looksLikeCompoundName, looksLikeMolblock } from '../chem/recognise.ts';
import type { UserStructureSource } from '../chem/entities.ts';
import { loadSketcher, type SketcherSession } from '../chem/sketcher.ts';
import { prefill } from '../state/composerEvents.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/chem/Feedback';
import { Molecule } from './Molecule.tsx';

/**
 * What RDKit said about one particular string (`of`). "Checking" is derived from `of` not matching
 * the field, so a verdict is never shown beside text it is not about.
 */
interface Verdict {
  of: string;
  /**
   * The last member is `NotAChemicalVerdict`, so a new refusal in `rdkit.engine.ts` must be handled
   * (see the `never` binding below).
   */
  status: 'ok' | 'name' | 'invalid' | 'unavailable' | 'too-large' | NotAChemicalVerdict;
  canonical?: string;
}

type Check =
  | { status: 'empty' }
  | { status: 'checking' }
  | { status: 'ok'; canonical: string }
  /** Refused, and shaped like a compound name — the one refusal worth explaining differently. */
  | { status: 'name' }
  | { status: 'invalid' }
  /** RDKit never loaded. Not a refusal: nothing here read the string at all. */
  | { status: 'unavailable' }
  /** Past `MAX_PARSED_SMILES_CHARS`: declined before parsing, not a chemical refusal. */
  | { status: 'too-large' }
  /**
   * Inside the cap, read as a molecule, but RDKit ran out of stack naming it (`Refused` in
   * `src/chem/rdkit.engine.ts`).
   */
  | { status: NotAChemicalVerdict };

function checkOf(raw: string, verdict: Verdict | null): Check {
  const text = raw.trim();
  if (!text) return { status: 'empty' };
  if (!verdict || verdict.of !== text) return { status: 'checking' };
  if (verdict.status === 'ok') return { status: 'ok', canonical: verdict.canonical ?? text };
  return { status: verdict.status };
}

/** Long enough that a paste is checked once, short enough to feel like typing. */
const DEBOUNCE_MS = 180;

export const FIELD_PLACEHOLDER = 'Paste SMILES, drop a .mol or .sdf, or draw it';

/**
 * What both checking surfaces say about a molecule RDKit read and could not name; each appends one
 * clause of its own. The limit is the JS stack at the moment of the call, so a second check may
 * differ — said plainly, with no retry button (`scripts/measure-rdkit-rangeerror.mjs`;
 * `tests/rdkitTooComplex.test.tsx`, `e2e/rdkit-too-complex.spec.ts`).
 */
export const TOO_COMPLEX_EXPLANATION =
  'RDKit read this as a molecule and then ran out of stack naming it, so it is too complex to ' +
  'name here. Nothing is wrong with it as chemistry: it is a limit of the JavaScript stack at ' +
  'the moment of the check rather than of the structure, so checking the same structure again ' +
  'may give a different answer.';

/** `n record` / `n records`. */
const recordCount = (n: number): string => `${n} record${n === 1 ? '' : 's'}`;

/**
 * The note for a file that produced no structure, counting unreadable and too-complex records apart
 * (the latter are molecules). Exported for tests.
 */
export function noStructureNote(fileName: string, unreadable: number, tooComplex: number): string {
  if (tooComplex === 0) {
    return unreadable > 0
      ? `${fileName} holds ${recordCount(unreadable)}, none of which RDKit could read as a structure.`
      : `No structure found in ${fileName}.`;
  }
  const complex =
    `${recordCount(tooComplex)} RDKit read as ${tooComplex === 1 ? 'a molecule' : 'molecules'} but ` +
    'could not name here — a limit of the JavaScript stack at the moment of the check, not of ' +
    'the structure';
  return unreadable > 0
    ? `${fileName} holds ${recordCount(unreadable)} RDKit could not read as a structure, and ${complex}.`
    : `${fileName} holds ${complex}.`;
}

/**
 * The summary line for a file that produced at least one structure. "Past the first N" counts every
 * record read.
 */
export function recordsNote(
  fileName: string,
  { smiles, unreadable, tooComplex, skipped }: Omit<MolfileRecords, 'unavailable'>,
): string {
  const read = smiles.length + unreadable + tooComplex;
  return [
    `${fileName}: ${smiles.length} structure${smiles.length === 1 ? '' : 's'}`,
    unreadable > 0 ? `, ${recordCount(unreadable)} unreadable` : '',
    tooComplex > 0 ? `, ${recordCount(tooComplex)} too complex to name here` : '',
    // Named rather than dropped: a file read down to its cap and a file read whole are different
    // facts, and only one of them means "this is everything in it".
    skipped > 0 ? `, ${skipped} past the first ${read} not read` : '',
    smiles.length > 1 ? '. One goes into the message at a time.' : '.',
  ].join('');
}

/**
 * What the sketcher dialog says it is not: the canvas (third-party) is not keyboard- or
 * screen-reader-accessible, so the dialog's `aria-description` names the text alternatives.
 * Exported for tests.
 */
export const SKETCHER_ALTERNATIVE =
  'Drawing needs a pointer. Cancel to paste SMILES or drop a MOL or SDF file instead — every route ends at the same structure, confirmed the same way.';

/**
 * Structure file extensions this panel reads; shared with the composer's drop routing. Checked here
 * because the picker's `accept=` does not filter drops.
 */
export const STRUCTURE_FILE = /\.(mol|sdf|mdl)$/i;

/**
 * The largest structure file read; the whole file is parsed, so the bound is stated to the chemist
 * ("split it") rather than risking a frozen tab.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;

/** Why this file cannot be read here, or `null`. Pure, so the picker and the two drop targets
 *  cannot disagree about it. */
function fileRefusal(file: File): string | null {
  if (!STRUCTURE_FILE.test(file.name)) {
    return `${file.name} is not a structure file — this panel reads .mol, .sdf or .mdl.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${mb(file.size)}, and this panel reads structure files up to ${mb(MAX_FILE_BYTES)} — the whole file is parsed here, on this thread. Split it, or drop the records you need.`;
  }
  return null;
}

/** The three ways reading a structure file can end: not ours, unreadable, or its contents. */
type FileOutcome =
  | { kind: 'records'; records: MolfileRecords }
  | { kind: 'refused'; why: string }
  | { kind: 'unreadable' };

/** A structure the chemist has seen drawn and accepted. */
export interface AcceptedStructure {
  /** What goes into the message and what keys the entity. RDKit's, always. */
  canonical: string;
  /**
   * What was in the field (the chemist's spelling, or canonical from a file or the sketcher), so
   * the rail can show the string they recognise.
   */
  raw: string;
  source: UserStructureSource;
  /** The file holds more structures, so the panel should stay open after Insert. */
  moreRecords: boolean;
}

interface StructureInputProps {
  onAccept: (structure: AcceptedStructure) => void;
  onClose: () => void;
  /**
   * A structure file dropped on the composer, read as if dropped here; wrapped with its drop so the
   * same file twice is read twice.
   */
  initialFile?: { at: number; file: File } | null;
}

export function StructureInput({
  onAccept,
  onClose,
  initialFile = null,
}: StructureInputProps): React.JSX.Element {
  const [raw, setRaw] = useState('');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  /**
   * The records of a multi-structure SDF, with the load counter so a new file remounts
   * `RecordStepper` and resets its position.
   */
  const [records, setRecords] = useState<{ load: number; smiles: string[] } | null>(null);
  /** Canonical strings already inserted from the record set on screen. See `accept`. */
  const [inserted, setInserted] = useState<string[]>([]);
  const loads = useRef(0);
  /**
   * Which claim on the field is newest. Every source that writes the field takes a number, and an
   * async result is dropped once the number has moved on.
   */
  const claim = useRef(0);

  // How the current candidate arrived (a ref: it never affects rendering).
  const source = useRef<UserStructureSource>('paste');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  // Focus moved once on mount: the panel exists because the chemist just opened it (`autoFocus` is
  // linted out).
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const check = checkOf(raw, verdict);

  useEffect(() => {
    const text = raw.trim();
    if (!text) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void readCanonicalSmiles(text).then(async (read) => {
        // The await crossed a keystroke: a later string may already be in the field, and letting
        // this answer land would report on text nobody can see any more.
        if (cancelled) return;
        switch (read.status) {
          case 'named':
            setVerdict({ of: text, status: 'ok', canonical: read.canonical });
            return;
          // Checked first: the string is inside the cap and the toolkit is present, so the later
          // checks would wrongly say "not a molecule".
          case 'too-complex':
            setVerdict({ of: text, status: 'too-complex' });
            return;
          // The chemical negative, which the three checks below are allowed to qualify.
          case 'unreadable':
            break;
          default: {
            // Exhaustiveness: an unhandled refusal must fail to compile rather than be shown as
            // "not a molecule".
            const unanswered: never = read;
            return unanswered;
          }
        }
        // "Not a molecule" is only ours to say if the toolkit loaded and the string was within the
        // parse cap.
        if (tooLongToParse(text)) {
          setVerdict({ of: text, status: 'too-large' });
          return;
        }
        const available = await rdkitAvailable();
        if (cancelled) return;
        if (!available) setVerdict({ of: text, status: 'unavailable' });
        else setVerdict({ of: text, status: looksLikeCompoundName(text) ? 'name' : 'invalid' });
      });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [raw]);

  const typed = (text: string): void => {
    claim.current += 1;
    source.current = 'paste';
    setRecords(null);
    setInserted([]);
    setFileNote(null);
    setRaw(text);
  };

  /**
   * Everything a molfile turns into, computed without touching state, so the drop effect can await
   * it before writing (no setState in an effect body). Async throughout for the same reason.
   */
  const readMolfile = async (file: File): Promise<FileOutcome> => {
    const why = fileRefusal(file);
    if (why) return { kind: 'refused', why };
    let text: string;
    try {
      text = await file.text();
    } catch {
      return { kind: 'unreadable' };
    }
    try {
      return { kind: 'records', records: await moleculesFromMolfile(text) };
    } catch {
      // WASM can still exhaust the heap on a large file; report unreadable rather than hang.
      return { kind: 'unreadable' };
    }
  };

  /** Put a read file on screen. */
  const applyMolfile = (file: File, outcome: FileOutcome): void => {
    if (outcome.kind === 'refused') {
      setFileNote(outcome.why);
      return;
    }
    if (outcome.kind === 'unreadable') {
      setFileNote(`Could not read ${file.name}.`);
      return;
    }
    const { smiles, unreadable, tooComplex, unavailable } = outcome.records;

    if (unavailable) {
      // Not "none of which RDKit could read": RDKit read nothing at all, and the file is very
      // probably fine.
      setFileNote(
        `Could not check ${file.name} — the structure toolkit could not be loaded. Nothing is wrong with the file.`,
      );
      return;
    }

    if (smiles.length === 0) {
      // Clear the field only if a file put the current candidate there, so a typed SMILES survives
      // a bad drop.
      if (source.current === 'file') setRaw('');
      // Named rather than generic: a `.csv` dropped on a molfile target and a corrupt `.mol` are
      // different mistakes, and the count is what distinguishes them.
      setFileNote(noStructureNote(file.name, unreadable, tooComplex));
      return;
    }

    source.current = 'file';
    loads.current += 1;
    setRecords(smiles.length > 1 ? { load: loads.current, smiles } : null);
    setInserted([]);
    setRaw(smiles[0] ?? '');
    setFileNote(recordsNote(file.name, outcome.records));
  };

  const takeFile = async (file: File): Promise<void> => {
    const mine = (claim.current += 1);
    setRecords(null);
    setInserted([]);
    setFileNote(`Reading ${file.name}…`);
    const outcome = await readMolfile(file);
    if (mine !== claim.current) return;
    applyMolfile(file, outcome);
  };

  /**
   * A molblock pasted into the field: a text input would strip its newlines, so the paste is taken
   * over and parsed.
   */
  const takeMolblock = async (molblock: string): Promise<void> => {
    const mine = (claim.current += 1);
    setFileNote('Reading the pasted molfile…');
    const read = await readCanonicalSmilesFromMolblock(molblock);
    if (read.status === 'too-complex') {
      // Before `rdkitAvailable`, which would pass — RDKit is here and read it — and the sentence
      // below would then call a molecule unreadable.
      if (mine !== claim.current) return;
      setFileNote(TOO_COMPLEX_EXPLANATION);
      return;
    }
    if (read.status !== 'named') {
      const available = await rdkitAvailable();
      if (mine !== claim.current) return;
      setFileNote(
        available
          ? 'That looks like a molfile, but RDKit could not read a structure from it.'
          : 'That looks like a molfile, but the structure toolkit could not be loaded to read it.',
      );
      return;
    }
    const canonical = read.canonical;
    if (mine !== claim.current) return;
    // 'file' rather than 'paste': what lands in the field is RDKit's canonical form, not a
    // spelling the chemist typed, which is exactly the distinction `raw` carries out of here.
    source.current = 'file';
    setRecords(null);
    setInserted([]);
    setRaw(canonical);
    setFileNote('Read the pasted molfile.');
  };

  // Read a composer drop, keyed on the drop's timestamp so the same file dropped twice is re-read.
  // Awaited before any state is written.
  const dropAt = initialFile?.at ?? null;
  const dropFile = initialFile?.file ?? null;
  useEffect(() => {
    if (dropAt === null || !dropFile) return;
    const mine = (claim.current += 1);
    let cancelled = false;
    void readMolfile(dropFile).then((outcome) => {
      if (!cancelled && mine === claim.current) applyMolfile(dropFile, outcome);
    });
    return () => {
      cancelled = true;
    };
    // Only the drop; the helpers are recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropAt]);

  const accept = (): void => {
    if (check.status !== 'ok') return;
    const moreRecords = (records?.smiles.length ?? 0) > 1;
    onAccept({
      canonical: check.canonical,
      raw: raw.trim(),
      source: source.current,
      moreRecords,
    });
    // Track records already inserted, since the field looks identical before and after.
    if (moreRecords) setInserted((taken) => [...new Set([...taken, check.canonical])]);
  };

  /** Hand the name to the agent, which is the only thing here that can resolve one. */
  const askAgentToResolve = (): void => {
    prefill(`Give me the canonical SMILES for ${raw.trim()}.`);
    onClose();
  };

  return (
    <div
      className={cn(
        'mb-2 rounded-xl border bg-surface-raised p-3 transition-colors',
        dragging ? 'border-brand' : 'border-border-subtle',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void takeFile(file);
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium">Insert a structure</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close the structure panel"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <label htmlFor="structure-input" className="sr-only-live">
        SMILES
      </label>
      <input
        id="structure-input"
        ref={fieldRef}
        type="text"
        value={raw}
        spellCheck={false}
        onChange={(e) => typed(e.target.value)}
        onPaste={(e) => {
          // CRLF normalised the way a control does on the way in, so the sniff sees the same four
          // header lines the parser will.
          const clip = e.clipboardData.getData('text').replace(/\r\n/g, '\n');
          if (!looksLikeMolblock(clip)) return;
          e.preventDefault();
          void takeMolblock(clip);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && check.status === 'ok') {
            e.preventDefault();
            accept();
          }
        }}
        placeholder={FIELD_PLACEHOLDER}
        className={cn(
          'w-full rounded-lg border bg-surface px-2.5 py-1.5 font-mono outline-none focus-ring',
          'placeholder:font-sans placeholder:text-ink-subtle',
          // >=16px on small screens, or iOS zooms the whole page in on focus.
          'text-[1rem] sm:text-sm',
          check.status === 'ok' ? 'border-ok' : 'border-border-subtle',
        )}
      />

      <p aria-live="polite" className="mt-1.5 min-h-4 text-xs">
        {check.status === 'checking' && <span className="text-ink-muted">Checking…</span>}
        {check.status === 'ok' && (
          <span className="text-ok-ink">
            {/* The canonical form is shown even when it matches what was typed: it is what will be sent. */}
            RDKit read this as <span className="font-mono">{check.canonical}</span>
          </span>
        )}
        {check.status === 'invalid' && (
          <span className="text-danger-ink">RDKit could not read this as a molecule.</span>
        )}
        {check.status === 'unavailable' && (
          <span className="text-warn-ink">
            The structure toolkit could not be loaded, so nothing here can be checked. Nothing is
            wrong with what you typed — reopen this panel to try again.
          </span>
        )}
        {check.status === 'name' && (
          <span className="text-warn-ink">
            That looks like a compound name, and a name is not a structure. This panel has no name
            lookup — the agent does.
          </span>
        )}
        {check.status === 'too-large' && (
          <span className="text-warn-ink">
            That is longer than this panel will parse — {raw.trim().length} characters, against a
            limit of {MAX_PARSED_SMILES_CHARS}. Nothing is wrong with it as chemistry; the toolkit
            is unstable on strings that long, so it is not read here.
          </span>
        )}
        {check.status === 'too-complex' && (
          // Warn, not danger: this is about the thread, not the molecule. The shared
          // `TOO_COMPLEX_EXPLANATION` comes first, then this panel's own consequence.
          <span className="text-warn-ink">
            {TOO_COMPLEX_EXPLANATION} Without that name there is nothing to file it under.
          </span>
        )}
      </p>

      {check.status === 'name' && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="xs" onClick={askAgentToResolve}>
            <Sparkles />
            Ask the agent for the SMILES
          </Button>
          <span className="text-2xs text-ink-subtle">
            It answers in the conversation; the structure it draws has a “use in my message”
            control.
          </span>
        </div>
      )}

      {check.status === 'ok' && (
        <div className="mt-1 flex items-start gap-3">
          <div className="rounded-lg border border-border-subtle bg-surface p-1">
            {/* Drawn from the canonical string, never the typed one: this picture is the confirmation. */}
            <Molecule smiles={check.canonical} maxWidth={200} />
          </div>
          <div className="flex flex-col items-start gap-1">
            <Button size="sm" onClick={accept}>
              Insert
            </Button>
            {inserted.includes(check.canonical) && (
              <span className="text-2xs text-ok-ink">Already in the message</span>
            )}
          </div>
        </div>
      )}

      {(fileNote || records) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {/* Outside the preview so stepping (which briefly re-checks) does not unmount the stepper. */}
          {records && (
            <RecordStepper
              key={records.load}
              records={records.smiles}
              inserted={inserted.length}
              onPick={setRaw}
            />
          )}
          {fileNote && <p className="text-xs text-ink-muted">{fileNote}</p>}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".mol,.sdf,.mdl,chemical/x-mdl-molfile,chemical/x-mdl-sdfile"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void takeFile(file);
            e.target.value = '';
          }}
        />
        <Button variant="outline" size="xs" onClick={() => fileRef.current?.click()}>
          <FileUp />
          Choose a MOL/SDF file
        </Button>
        <Button variant="outline" size="xs" onClick={() => setDrawing(true)}>
          <PenLine />
          Draw
        </Button>
        <span className="text-2xs text-ink-subtle">…or drop a file anywhere on this panel.</span>
      </div>

      <SketcherDialog
        open={drawing}
        onOpenChange={setDrawing}
        // Start the sketcher from the confirmed structure, so a correction continues the drawing.
        initial={check.status === 'ok' ? check.canonical : undefined}
        onDrawn={(smiles) => {
          claim.current += 1;
          source.current = 'sketch';
          setRecords(null);
          setFileNote(null);
          setRaw(smiles);
          setDrawing(false);
        }}
      />
    </div>
  );
}

/**
 * Step through a multi-record SDF; one structure per message (nobody checks forty drawings). Shows
 * how many have been inserted.
 */
function RecordStepper({
  records,
  inserted,
  onPick,
}: {
  records: string[];
  /** How many of them are already in the message. A chemist working through a screening file
   *  needs to know where they are in it, and the record index alone does not say. */
  inserted: number;
  onPick: (smiles: string) => void;
}): React.JSX.Element {
  const [index, setIndex] = useState(0);

  const step = (delta: number): void => {
    const next = (index + delta + records.length) % records.length;
    setIndex(next);
    onPick(records[next] ?? '');
  };

  return (
    <div className="flex items-center gap-1 text-xs text-ink-muted">
      <Button
        variant="outline"
        size="icon-xs"
        aria-label="Previous structure in this file"
        onClick={() => step(-1)}
      >
        <ChevronLeft />
      </Button>
      <span className="tabular-nums">
        {index + 1} / {records.length}
        {inserted > 0 && <span className="ml-1 text-ok-ink">· {inserted} inserted</span>}
      </span>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label="Next structure in this file"
        onClick={() => step(1)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

type SketcherState = 'loading' | 'ready' | 'unavailable';

/**
 * The sketcher in a Radix modal dialog (a canvas needs more room than the side sheet), which owns
 * focus trap, Escape and `aria-modal`. The editor is reached only through `src/chem/sketcher.ts`,
 * and its molblock goes through RDKit before anything is shown.
 */
function SketcherDialog({
  open,
  onOpenChange,
  onDrawn,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDrawn: (smiles: string) => void;
  /** The structure to open the canvas on, if there is one. */
  initial?: string;
}): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'flex h-[min(80vh,42rem)] w-[min(92vw,60rem)] flex-col',
            'rounded-xl border border-border-subtle bg-surface-raised p-3 shadow-lg',
          )}
        >
          {/* Mounted only while open, so closing tears down the editor's React tree. Indigo's worker is a page-wide singleton and stays (see `sketcher.ketcher.tsx` `destroy()`). */}
          {open && <SketcherBody onDrawn={onDrawn} initial={initial} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SketcherBody({
  onDrawn,
  initial,
}: {
  onDrawn: (smiles: string) => void;
  initial?: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<SketcherSession | null>(null);
  const [state, setState] = useState<SketcherState>('loading');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const mount = await loadSketcher();
      const host = hostRef.current;
      if (cancelled || !host) return;
      if (!mount) {
        setState('unavailable');
        return;
      }
      try {
        const session = await mount(host, initial);
        // Closed while the editor was loading: mount and immediately tear it down.
        if (cancelled) {
          session.destroy();
          return;
        }
        sessionRef.current = session;
        setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
    // Mount-time only: the dialog remounts per open, and re-running would tear down a live editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const use = async (): Promise<void> => {
    setProblem(null);
    const molblock = await sessionRef.current?.read();
    if (!molblock) {
      setProblem('Nothing is drawn yet.');
      return;
    }
    // Not the sketcher's own SMILES export: one toolkit decides what a molecule is here, and it is
    // the same one that decides everywhere else in this application.
    const read = await readCanonicalSmilesFromMolblock(molblock);
    if (read.status === 'too-complex') {
      // A drawing RDKit read as a molecule and could not name is not "nothing on the canvas", and
      // the chemist who drew it knows that — the sentence below would be the one that is wrong.
      setProblem(TOO_COMPLEX_EXPLANATION);
      return;
    }
    if (read.status !== 'named') {
      // Also covers an empty canvas (a valid zero-atom molblock).
      setProblem('Nothing on the canvas that RDKit can read as a molecule.');
      return;
    }
    onDrawn(read.canonical);
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Dialog.Title className="text-sm font-medium">Draw a structure</Dialog.Title>
        <div className="flex items-center gap-2">
          {problem && (
            <span role="status" className="text-xs text-warn-ink">
              {problem}
            </span>
          )}
          <Button size="sm" disabled={state !== 'ready'} onClick={() => void use()}>
            Use this structure
          </Button>
          <Dialog.Close asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </Dialog.Close>
        </div>
      </div>

      <Dialog.Description className="mb-2 text-xs text-ink-muted">
        {SKETCHER_ALTERNATIVE}
      </Dialog.Description>

      {state === 'unavailable' && (
        // The alternative is not repeated here: `SKETCHER_ALTERNATIVE` above already names it,
        // for every reader rather than only the one whose editor failed.
        <p className="mb-2 text-xs text-danger-ink">The structure editor could not be loaded.</p>
      )}

      {/* `data-sketcher-canvas` marks the one region the axe pass skips (Ketcher's own markup); `e2e/a11y.spec.ts` scans the rest of the dialog. */}
      <div
        data-sketcher-canvas
        role="group"
        aria-label="Structure editor"
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border-subtle"
      >
        {state === 'loading' && (
          <Loading className="absolute inset-0 justify-center">
            Loading the structure editor…
          </Loading>
        )}
        {/* Owned by the sketcher module from here down: React must not render children into it,
            because the adapter mounts its own root inside. */}
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </>
  );
}
