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
 * answer differently. What is left is one sentence that tells the truth and points at the thing
 * that can actually do it.
 */

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, FileUp, PenLine, X } from 'lucide-react';
import {
  canonicalSmiles,
  canonicalSmilesFromMolblock,
  moleculesFromMolfile,
} from '../chem/rdkit.ts';
import { looksLikeCompoundName } from '../chem/recognise.ts';
import type { UserStructureSource } from '../chem/entities.ts';
import { loadSketcher, type SketcherSession } from '../chem/sketcher.ts';
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
  status: 'ok' | 'name' | 'invalid';
  canonical?: string;
}

type Check =
  | { status: 'empty' }
  | { status: 'checking' }
  | { status: 'ok'; canonical: string }
  /** Refused, and shaped like a compound name — the one refusal worth explaining differently. */
  | { status: 'name' }
  | { status: 'invalid' };

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

/** A structure the chemist has seen drawn and accepted. */
export interface AcceptedStructure {
  /** What goes into the message and what keys the entity. RDKit's, always. */
  canonical: string;
  /** What was in the field — the chemist's own spelling when they typed one, and the canonical
   *  form when a file or the sketcher put it there. Carried so the rail can show a chemist the
   *  string they recognise beside the one RDKit prefers. */
  raw: string;
  source: UserStructureSource;
}

interface StructureInputProps {
  onAccept: (structure: AcceptedStructure) => void;
  onClose: () => void;
}

export function StructureInput({ onAccept, onClose }: StructureInputProps): React.JSX.Element {
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
  const loads = useRef(0);

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
      void canonicalSmiles(text).then((canonical) => {
        // The await crossed a keystroke: a later string may already be in the field, and letting
        // this answer land would report on text nobody can see any more.
        if (cancelled) return;
        if (canonical) setVerdict({ of: text, status: 'ok', canonical });
        else setVerdict({ of: text, status: looksLikeCompoundName(text) ? 'name' : 'invalid' });
      });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [raw]);

  const typed = (text: string): void => {
    source.current = 'paste';
    setRecords(null);
    setFileNote(null);
    setRaw(text);
  };

  const takeFile = async (file: File): Promise<void> => {
    setRecords(null);
    setFileNote(`Reading ${file.name}…`);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileNote(`Could not read ${file.name}.`);
      return;
    }

    const { smiles, unreadable } = await moleculesFromMolfile(text);
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
    setRaw(smiles[0] ?? '');
    setFileNote(
      [
        `${file.name}: ${smiles.length} structure${smiles.length === 1 ? '' : 's'}`,
        unreadable > 0 ? `, ${unreadable} record${unreadable === 1 ? '' : 's'} unreadable` : '',
        smiles.length > 1 ? '. One goes into the message at a time.' : '.',
      ].join(''),
    );
  };

  const accept = (): void => {
    if (check.status !== 'ok') return;
    onAccept({ canonical: check.canonical, raw: raw.trim(), source: source.current });
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
        {check.status === 'name' && (
          <span className="text-warn-ink">
            That looks like a compound name, and a name is not a structure — this panel has no name
            lookup, so ask the agent to resolve it (“give me the SMILES for {raw.trim()}”) and paste
            what it returns.
          </span>
        )}
      </p>

      {check.status === 'ok' && (
        <div className="mt-1 flex items-start gap-3">
          <div className="rounded-lg border border-border-subtle bg-surface p-1">
            {/* Drawn from the canonical string, never from what was typed — this picture is the
                confirmation, so it has to depict the thing that will actually be sent. */}
            <Molecule smiles={check.canonical} maxWidth={200} />
          </div>
          <Button size="sm" onClick={accept}>
            Insert
          </Button>
        </div>
      )}

      {(fileNote || records) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {/* Outside the preview block on purpose: stepping to the next record puts the field back
              into "checking" for a moment, and a stepper that unmounted there would lose its place
              on every press. */}
          {records && <RecordStepper key={records.load} records={records.smiles} onPick={setRaw} />}
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
        onDrawn={(smiles) => {
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
 */
function RecordStepper({
  records,
  onPick,
}: {
  records: string[];
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDrawn: (smiles: string) => void;
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
          {/* Mounted only while open, so closing the dialog tears the editor down through the
              effect cleanup rather than leaving a live WASM heap behind a hidden node. */}
          {open && <SketcherBody onDrawn={onDrawn} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SketcherBody({ onDrawn }: { onDrawn: (smiles: string) => void }): React.JSX.Element {
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
        const session = await mount(host);
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

      {state === 'unavailable' && (
        <p className="mb-2 text-xs text-danger-ink">
          The structure editor could not be loaded. Paste SMILES or drop a MOL file instead — both
          reach the same place.
        </p>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border-subtle">
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
