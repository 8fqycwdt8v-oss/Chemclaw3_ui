/**
 * Getting a structure into a message.
 *
 * Every chemistry tool on this backend takes SMILES. A bench chemist has a structure — on paper, in
 * a MOL file, in ChemDraw, or as a compound they can name — and until this component existed the
 * only way in was to type SMILES into the message box by hand and hope. That is the wrong way round
 * for the person this whole effort is aimed at.
 *
 * Three ways in, **one** result. Paste or type SMILES, drop a `.mol`/`.sdf`, or draw it: the file
 * reader and the sketcher both write canonical SMILES into the same field, so there is a single
 * validation path and a single thing on screen to check. A structure that arrived three different
 * ways cannot be trusted three different amounts.
 *
 * ## The confirmation is the point
 *
 * Nothing is inserted until RDKit has read it and drawn it back. "This is what I understood you to
 * mean" is the entire affordance — a chemist must never send a structure they have not seen. So the
 * Insert control is bound to the *drawing*, not to the text: while the field says something RDKit
 * has not accepted, there is nothing to insert and no picture to mislead anyone. `Molecule.tsx`
 * holds up its end (it will show the string it refused rather than an empty box), and this file
 * never hands it anything but a canonicalised string that already round-tripped.
 *
 * ## A name is not a structure
 *
 * `4-bromoanisole` is the single most likely thing to be typed into a SMILES box, and the backend
 * genuinely can resolve it — `resolve_compound` is RDKit plus a vendored dataset. But it is an
 * *agent tool*: reachable inside a turn, with no HTTP route behind it. So this panel cannot look a
 * name up, and the two tempting fixes are both worse than saying so. Inventing an endpoint puts a
 * capability in the BFF whitelist that the service does not expose; shipping a name table to the
 * browser means a second, smaller, drifting copy of the dataset answering questions the agent would
 * answer differently.
 *
 * There is a third option, and it is the one taken here. The agent can answer, and this app already
 * knows how to make it answer: `chemclaw:prefill` composes a message on the chemist's behalf, which
 * is what a citation chip does when a note will not resolve. So the panel offers the question as a
 * button instead of instructing a chemist to retype it. That is not a name lookup — the agent still
 * does the resolving, and the answer still comes back in the conversation — it just stops charging
 * the chemist a sentence for it. The return leg is the `Use in my message` control on the structure
 * the answer draws (`src/components/chem/UseStructure.tsx`).
 */

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, FileUp, PenLine, Sparkles, X } from 'lucide-react';
import {
  MAX_PARSED_SMILES_CHARS,
  canonicalSmiles,
  canonicalSmilesFromMolblock,
  moleculesFromMolfile,
  rdkitAvailable,
  tooLongToParse,
  type MolfileRecords,
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
 * What RDKit said about one particular string.
 *
 * It carries the text it is about (`of`), and "checking" is *derived* from that not matching what
 * is in the field rather than being written into state when a keystroke arrives. Two reasons, and
 * the second is the one that would bite: a verdict that did not name its subject could be shown
 * beside text it was not about for as long as the debounce lasts, and setting state synchronously
 * from an effect is exactly what the hooks lint forbids — it is a second render pass per keystroke
 * that computing the value would have avoided.
 */
interface Verdict {
  of: string;
  status: 'ok' | 'name' | 'invalid' | 'unavailable' | 'too-large';
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
  /** Past `MAX_PARSED_SMILES_CHARS`. Also not a refusal about the chemistry — `src/chem/rdkit.ts`
   *  declines to hand the parser a string long enough to trap the WASM, and the range it declines
   *  starts well below the one that actually traps. */
  | { status: 'too-large' };

function checkOf(raw: string, verdict: Verdict | null): Check {
  const text = raw.trim();
  if (!text) return { status: 'empty' };
  if (!verdict || verdict.of !== text) return { status: 'checking' };
  if (verdict.status === 'ok') return { status: 'ok', canonical: verdict.canonical ?? text };
  return { status: verdict.status };
}

/** Long enough that a paste is checked in one go rather than character by character, short enough
 *  that it feels like typing. The first check also waits on a 6.9 MB WASM download, which dwarfs
 *  this either way. */
const DEBOUNCE_MS = 180;

export const FIELD_PLACEHOLDER = 'Paste SMILES, drop a .mol or .sdf, or draw it';

/**
 * What the sketcher dialog says it is not.
 *
 * The canvas is a third-party WASM editor driven by a pointer. Nothing in this repository can make
 * it navigable by keyboard or legible to a screen reader — that is the editor's own markup, not
 * ours — so the honest thing is to say out loud that drawing is one of three doors and the other
 * two are text. This is the dialog's `aria-description`, so it is announced on open rather than
 * being a sentence somebody has to go looking for, and it is visible for the same reason.
 *
 * Exported because two tests assert on it and a string typed twice is a string that drifts once.
 */
export const SKETCHER_ALTERNATIVE =
  'Drawing needs a pointer. Cancel to paste SMILES or drop a MOL or SDF file instead — every route ends at the same structure, confirmed the same way.';

/**
 * What this panel can read.
 *
 * Exported because the composer routes a dropped file by the same rule — anything else is a
 * working file for the attachment route — and two lists of extensions would be one rule with two
 * spellings, of which the stale one is free to drift.
 *
 * The check belongs here rather than on the controls: the picker's `accept=` filters the picker
 * only, and the panel takes anything dropped on it.
 */
export const STRUCTURE_FILE = /\.(mol|sdf|mdl)$/i;

/**
 * The most a structure file may weigh.
 *
 * The whole file is materialised as a string and every record is parsed in WASM on this thread —
 * there is no worker and nothing cancels it — so an unbounded read is an unbounded freeze. The
 * bound is stated to the chemist rather than enforced silently, because "split it" is a thing they
 * can act on and a hung tab is not.
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

/** The three ways reading a structure file can end. Named rather than collapsed into `| null`,
 *  because "this is not a file I read", "I could not read it" and "here is what was in it" are
 *  three different sentences to a chemist. */
type FileOutcome =
  | { kind: 'records'; records: MolfileRecords }
  | { kind: 'refused'; why: string }
  | { kind: 'unreadable' };

/** A structure the chemist has seen drawn and accepted. */
export interface AcceptedStructure {
  /** What goes into the message and what keys the entity. RDKit's, always. */
  canonical: string;
  /** What was in the field — the chemist's own spelling when they typed one, and the canonical
   *  form when a file or the sketcher put it there. Carried so the rail can show a chemist the
   *  string they recognise beside the one RDKit prefers. */
  raw: string;
  source: UserStructureSource;
  /**
   * The file this came from holds more than one structure, so the panel should stay open.
   *
   * Carried out with the structure rather than left for the composer to work out, because the
   * composer has no idea a file was involved. Inserting record 2 of 12 used to cost a full reopen
   * — hexagon, re-drop, step, Insert — once per record.
   */
  moreRecords: boolean;
}

interface StructureInputProps {
  onAccept: (structure: AcceptedStructure) => void;
  onClose: () => void;
  /**
   * A structure file dropped on the composer, to be read as if it had been dropped here.
   *
   * Wrapped with the drop it arrived on rather than passed bare: two drops of the same `File`
   * object are two intentions, and an effect keyed on the file alone would ignore the second.
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
   * The records of a multi-structure SDF, held so the chemist can step through them.
   *
   * Carries the load it came in on. `RecordStepper` keeps its position in component state, so a
   * second file has to *remount* it — otherwise the index survives and a three-record file dropped
   * after a ten-record one reads "8 / 3" while showing record 1. Two files can hold identical
   * structures, so the identity of the load is the counter and not the contents.
   */
  const [records, setRecords] = useState<{ load: number; smiles: string[] } | null>(null);
  /** Canonical strings already inserted from the record set on screen. See `accept`. */
  const [inserted, setInserted] = useState<string[]>([]);
  const loads = useRef(0);
  /**
   * Which claim on the field is the newest one.
   *
   * Every source that writes the field takes a number first — typing, the picker, either drop, a
   * pasted molblock — and an asynchronous one drops its result when the number has moved on. A
   * file read is a file-system round trip plus a full RDKit pass, and nothing cancelled it: drop a
   * large `.sdf`, get bored, type your own structure, and the read landed on top of it. The field
   * is the confirmation surface, so a write from a source the chemist has moved on from replaces
   * the structure under review.
   */
  const claim = useRef(0);

  // How the current candidate arrived. A ref rather than state because it never affects the
  // rendering — it is carried out with the accepted structure so the rail can say where it came
  // from — and making it state would re-render the panel on every keystroke for nothing.
  const source = useRef<UserStructureSource>('paste');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  // Focus moved in an effect rather than with `autoFocus`. The attribute is linted out of this
  // codebase because it steals focus wherever a component happens to mount; here the panel only
  // exists because the chemist just asked for it, so moving focus once on mount is what they
  // expect, and doing it explicitly keeps that a decision rather than a default.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const check = checkOf(raw, verdict);

  useEffect(() => {
    const text = raw.trim();
    if (!text) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void canonicalSmiles(text).then(async (canonical) => {
        // The await crossed a keystroke: a later string may already be in the field, and letting
        // this answer land would report on text nobody can see any more.
        if (cancelled) return;
        if (canonical) {
          setVerdict({ of: text, status: 'ok', canonical });
          return;
        }
        // "Not a molecule" is a claim about the string, and it is only ours to make if the toolkit
        // that would have read it is here at all. It was not, once, and this panel told a chemist
        // that `CCO` is not a molecule. The same applies to a string we declined to parse: the
        // length cap starts at 600 and the WASM trap it avoids is at ~1,100, so this panel used to
        // call a perfectly readable 700-character polymer not a molecule.
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
   * Everything a molfile turns into, worked out without touching state.
   *
   * Split from applying it so the dropped-file effect below can `await` this before it writes
   * anything — an effect whose body calls setState synchronously is a cascading render, and the
   * React Compiler lint is right to refuse it. The split earns its place twice over: the reading
   * is the part worth testing, and it has no React in it.
   *
   * Async all the way through, including the refusals, for the same reason: a caller that got an
   * answer without suspending would be back to writing state inside the effect body.
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
      // A file that got past the size bound can still exhaust the heap in WASM. `file.text()` was
      // guarded and this was not, so the failure arrived as an unhandled rejection and the panel
      // sat on "Reading …" for ever.
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
    const { smiles, unreadable, skipped, unavailable } = outcome.records;

    if (unavailable) {
      // Not "none of which RDKit could read": RDKit read nothing at all, and the file is very
      // probably fine.
      setFileNote(
        `Could not check ${file.name} — the structure toolkit could not be loaded. Nothing is wrong with the file.`,
      );
      return;
    }

    if (smiles.length === 0) {
      // Clear the field only if a *file* put the current candidate there. Otherwise a chemist who
      // typed a SMILES and then dropped the wrong file loses their own input; leaving it would
      // instead park a structure from an earlier file next to this file's failure note, which
      // reads as "here is what I found in it".
      if (source.current === 'file') setRaw('');
      // Named rather than generic: a `.csv` dropped on a molfile target and a corrupt `.mol` are
      // different mistakes, and the count is what distinguishes them.
      setFileNote(
        unreadable > 0
          ? `${file.name} holds ${unreadable} record${unreadable === 1 ? '' : 's'}, none of which RDKit could read as a structure.`
          : `No structure found in ${file.name}.`,
      );
      return;
    }

    source.current = 'file';
    loads.current += 1;
    setRecords(smiles.length > 1 ? { load: loads.current, smiles } : null);
    setInserted([]);
    setRaw(smiles[0] ?? '');
    setFileNote(
      [
        `${file.name}: ${smiles.length} structure${smiles.length === 1 ? '' : 's'}`,
        unreadable > 0 ? `, ${unreadable} record${unreadable === 1 ? '' : 's'} unreadable` : '',
        // Named rather than dropped: a file read down to its cap and a file read whole are
        // different facts, and only one of them means "this is everything in it".
        skipped > 0 ? `, ${skipped} past the first ${smiles.length + unreadable} not read` : '',
        smiles.length > 1 ? '. One goes into the message at a time.' : '.',
      ].join(''),
    );
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
   * A molblock pasted into the field.
   *
   * The field is an `<input type="text">`, so a browser strips the newlines out of a multi-line
   * paste and leaves one unparseable line of MDL. That made the second door a dead end for exactly
   * the payload ChemDraw, Ketcher and Marvin put on the clipboard — while the drop path reads
   * byte-identical content happily — so the paste is taken over rather than allowed through.
   */
  const takeMolblock = async (molblock: string): Promise<void> => {
    const mine = (claim.current += 1);
    setFileNote('Reading the pasted molfile…');
    const canonical = await canonicalSmilesFromMolblock(molblock);
    if (!canonical) {
      const available = await rdkitAvailable();
      if (mine !== claim.current) return;
      setFileNote(
        available
          ? 'That looks like a molfile, but RDKit could not read a structure from it.'
          : 'That looks like a molfile, but the structure toolkit could not be loaded to read it.',
      );
      return;
    }
    if (mine !== claim.current) return;
    // 'file' rather than 'paste': what lands in the field is RDKit's canonical form, not a
    // spelling the chemist typed, which is exactly the distinction `raw` carries out of here.
    source.current = 'file';
    setRecords(null);
    setInserted([]);
    setRaw(canonical);
    setFileNote('Read the pasted molfile.');
  };

  // A file dropped on the composer, read as if it had been dropped here. Keyed on the drop's
  // timestamp rather than the File, so dropping the same file twice reads it twice — the second
  // drop is a second intention, usually after the chemist changed their mind about a record.
  //
  // The read is awaited before anything is written, which is why `readMolfile` and `applyMolfile`
  // are two functions: `takeFile` would set three pieces of state in this effect's body.
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
    // Only the drop. The two helpers are redeclared every render and listing them would re-read
    // the file on every keystroke; nothing else about a drop changes after it has happened.
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
    // Only meaningful while the panel survives the insert, which is exactly when `moreRecords`
    // is true. It tells a chemist stepping through a screening file which records they have
    // already taken, because the field alone cannot — record 3 looks identical before and after.
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
            {/* The canonical form is shown even when it matches what was typed: the chemist is
                about to send this string, and it is not always the one they wrote. */}
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
            {/* Drawn from the canonical string, never from what was typed — this picture is the
                confirmation, so it has to depict the thing that will actually be sent. */}
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
          {/* Outside the preview block on purpose: stepping to the next record puts the field back
              into "checking" for a moment, and a stepper that unmounted there would lose its place
              on every press. */}
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
        // What the panel has already confirmed, so "draw, insert, notice a missing methyl, press
        // Draw" continues the drawing instead of starting a second one. Correcting one bond in a
        // thirty-atom molecule used to mean redrawing it from scratch, and two drawings are two
        // independent chances to get it wrong.
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
 * Step through the structures of a multi-record SDF.
 *
 * The whole file is parsed (see `moleculesFromMolfile` for why taking only the first record was
 * rejected), but one structure goes into a message at a time — a message that carried forty SMILES
 * would defeat the confirmation this panel exists to provide, since nobody checks forty drawings.
 *
 * The panel now stays open while a record set is on screen, so stepping and inserting is a loop
 * rather than a reopen per record, and the count of what has already been taken is shown here
 * because record 3 looks exactly the same before and after it was inserted.
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
 * The sketcher, in a modal dialog.
 *
 * A centred modal rather than the app's `Sheet`, which is an edge drawer at most 20rem wide: a
 * drawing canvas needs real room — Ketcher below about 600×420 is a toolbar with a stamp-sized
 * canvas under it — and the composer sits at the bottom of a chat pane that has none.
 *
 * Built on Radix's Dialog rather than a hand-rolled overlay, and that is worth naming because the
 * hand-rolled one had a specific bug: its Escape handler sat on the overlay `div`, which is not
 * focusable, so Escape did nothing until the user had clicked *inside* — precisely the moment they
 * have not yet done. The primitive owns the focus trap, the Escape key and the `aria-modal`
 * bookkeeping, so there is no version of that mistake left to make.
 *
 * The editor is reached only through `src/chem/sketcher.ts`, so this component names no drawing
 * library and cares about exactly two things: mount into a div, and later ask for a molblock. The
 * molblock goes to RDKit, because a structure that has not been through RDKit is not a structure
 * this application will show anybody.
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
          {/* Mounted only while open, so closing the dialog tears the editor's React tree down
              through the effect cleanup rather than leaving it attached to a hidden node.

              It does **not** tear down the WASM heap, and this comment used to say it did.
              Verified against the installed `ketcher-standalone@3.17.2`: Indigo runs in a worker
              the package creates at *module* scope and shares between every struct service, and
              nothing in `ketcher-react` terminates it — so the ~11.79 MB is retained from the
              first Draw click for the life of the page whatever this dialog does.
              `sketcher.ketcher.tsx`'s `destroy()` carries the reading, including why the teardown
              the package *does* expose is deliberately not called. */}
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
        // Closed while a 12 MB WASM editor was loading. Mount it and immediately tear it down
        // rather than leaving a live editor attached to a detached node.
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
    // Mount-time only: the dialog remounts this per open, so the structure to start from is read
    // once, and re-running on it would tear a live editor down mid-drawing.
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
    const canonical = await canonicalSmilesFromMolblock(molblock);
    if (!canonical) {
      // Covers the empty canvas too — a sketcher exports that as a valid molblock with no atoms,
      // and RDKit reads it as the empty SMILES. The panel does not need to tell "empty" from
      // "unreadable", because the only thing it is entitled to say is that there is no structure.
      setProblem('Nothing on the canvas that RDKit can read as a molecule.');
      return;
    }
    onDrawn(canonical);
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

      {/* `data-sketcher-canvas` marks the one region of this app the axe pass does not scan, and
          the attribute is the whole record of that exemption: everything inside is Ketcher's own
          markup, which this repository neither writes nor can fix. `e2e/a11y.spec.ts` excludes it
          by this selector and scans the rest of the dialog — the title, the description above, and
          the two controls — precisely so the alternative stays checked while the canvas does not
          pretend to be. `ISSUES.md` carries the limitation. */}
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
