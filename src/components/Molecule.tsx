/**
 * SMILES rendering.
 *
 * **RDKit-WASM, not smiles-drawer — and that reverses a decision this file used to argue for.**
 * The old docstring said a 2D depiction was all this ever needed and RDKit's payload was two
 * orders of magnitude larger than the rest of the bundle. Both halves were true and the conclusion
 * was right for the UI that wrote it: the only structures on screen came from a job summary and an
 * opt-in toggle on inline code spans, and depiction was genuinely the whole job.
 *
 * It is not the whole job any more, and the three things that changed have no smiles-drawer answer:
 *
 *  - **Canonical identity.** `src/chem/entities.ts` indexes what a conversation is *about*, keyed
 *    on the compound. `COc1ccc(Br)cc1` and `BrC1=CC=C(OC)C=C1` have to collapse to one row or the
 *    rail shows one bromoanisole twice and can never join a computed value to the structure it was
 *    computed for. smiles-drawer parses a SMILES; it cannot canonicalise one, and no string
 *    handling gets there.
 *  - **Validation.** `src/chem/recognise.ts` is now deliberately looser than the rule it replaced,
 *    because that rule rejected `CCO`. A looser recogniser is only safe if something else can say
 *    "that is not a molecule" before it is drawn. smiles-drawer cannot be that arbiter: the object
 *    that refuses a string is the same object that draws it, so a refusal is indistinguishable
 *    from a rendering failure, and `entities.ts` needs the answer with no renderer in the room.
 *  - **Molblock parsing.** `StructureInput`'s file drop reads `.mol`/`.sdf`. smiles-drawer speaks
 *    SMILES and nothing else.
 *
 * The bundle argument survives intact and is answered structurally: `src/chem/rdkit.ts` is behind a
 * dynamic `import()`, so the WASM is its own chunk and index.html preloads none of it. Measured
 * across the swap alone, the entry chunk went 485.86 kB → 485.78 kB — the 6.9 MB binary and its
 * 74 kB loader are separate emitted assets, fetched the first time a structure appears. That
 * *delta* is what the argument rests on and it is still true; the 485 kB absolute this used to
 * carry is not, and `chem/rdkit.ts` published 509 kB for the same chunk in the same breath. No
 * current size replaces them — measured twice in one afternoon the entry moved by 4 kB with
 * nothing here touched, so `chem/rdkit.ts` records why that number does not belong in prose. The
 * invariant to read is the structural one: no chemistry in the entry but the dynamic import that
 * reaches it, which `tests/entryChunk.test.ts` asserts.
 *
 * Keeping smiles-drawer alongside for depiction was considered and dropped — any page with a rail
 * has already fetched RDKit, so it would be 190 kB of duplicate capability and, worse, a second
 * opinion about what is drawable.
 *
 * What is kept from the version this replaces, because none of it was about the drawing library:
 *
 *  - the reaction split, so `similar_reactions` hits and `reaction` notes are drawn as reactions
 *    rather than falling through to a raw string;
 *  - a `viewBox`-scaled drawing inside an `aspect-ratio` wrapper, so a structure scales instead of
 *    squashing on a narrow screen and the space is reserved before it draws;
 *  - the theme read from the app's own `data-theme` rather than from `prefers-color-scheme`, so a
 *    structure re-draws when the in-app toggle flips.
 */

import { useEffect, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { moleculeSvg, rdkitAvailable } from '../chem/rdkit.ts';
import { mightBeStructure, readStructure, type ReadStructure } from '../chem/structure.ts';
import { useThemeStore } from '../state/themeStore.ts';
import { usePrefsStore } from '../state/prefsStore.ts';
import { UseStructure } from './chem/UseStructure.tsx';

/** One canonical drawing size. The viewBox scales it to whatever the layout gives it. */
const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 220;

export interface MoleculeProps {
  smiles: string;
  className?: string;
  /** Caps the rendered width; the structure scales within it rather than being cropped. */
  maxWidth?: number;
}

/**
 * A reaction SMILES — `reactants>agents>products`, or the two-part `A>>B`.
 *
 * A molecule toolkit parses molecules, so every reaction reaching this component fell through to
 * the raw-string fallback. That is most of what `similar_reactions` returns and every `reaction`
 * note's structure, so the one search built around reactions was the one search whose hits could
 * not be drawn. RDKit's *minimal* build ships no reaction object either, which is why the split
 * stays here rather than moving down into `rdkit.ts`.
 *
 * Each component is drawn as the molecule it is and the arrow is laid out here. `>` cannot occur
 * inside a molecule SMILES, so the split is unambiguous.
 */
function Reaction({ smiles, className, maxWidth }: Required<MoleculeProps>): React.JSX.Element {
  const [reactants = '', agents = '', products = ''] = smiles.split('>');
  // A plain function, not a nested component: a component declared in a render body is a new type
  // on every render, so React unmounts and remounts its whole subtree — here, re-running every
  // structure's async draw on each parent render.
  const side = (part: string): React.ReactNode =>
    part
      .split('.')
      .filter(Boolean)
      .map((component, i) => (
        <span key={`${component}-${i}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden className="text-ink-subtle">
              +
            </span>
          )}
          <SingleMolecule smiles={component} maxWidth={maxWidth} />
        </span>
      ));

  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      role="img"
      // One name for the whole reaction: read component by component, a screen reader would
      // announce a list of structures with no indication of which side each is on.
      aria-label={`Reaction ${smiles}`}
    >
      {side(reactants)}
      <span className="flex flex-col items-center px-1 text-ink-muted">
        {/* The agents sit over the arrow, which is where a chemist reads them. */}
        {agents && <span className="font-mono text-2xs">{agents}</span>}
        <span aria-hidden className="text-lg leading-none">
          →
        </span>
      </span>
      {side(products)}
    </div>
  );
}

function SingleMolecule({ smiles, className, maxWidth = 320 }: MoleculeProps): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  /** Why there is no drawing, when there is none. The two are different facts and only one of them
   *  is about the structure. */
  const [problem, setProblem] = useState<'unreadable' | 'unavailable' | null>(null);
  // Subscribing to the app's resolved theme, so a structure re-draws when the user flips the
  // toggle — not only when the OS preference changes.
  const theme = useThemeStore((s) => s.resolved);

  useEffect(() => {
    let cancelled = false;

    void moleculeSvg(smiles, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      dark: theme === 'dark',
    }).then(async (drawn) => {
      // The await crossed a render boundary; a structure that has since been replaced must not
      // overwrite the one now on screen.
      if (cancelled) return;
      // Cleared on success rather than at the top of the effect: resetting synchronously made a
      // re-render of an already-failed structure flash its fallback away and back.
      if (drawn !== null) {
        setProblem(null);
        setSvg(drawn);
        return;
      }
      // Nothing was drawn — but "this string is not a molecule" is a claim, and it is the wrong
      // one to make about every structure on the page when the toolkit simply never loaded.
      const available = await rdkitAvailable();
      if (cancelled) return;
      setProblem(available ? 'unreadable' : 'unavailable');
      setSvg(null);
    });

    return () => {
      cancelled = true;
    };
  }, [smiles, theme]);

  if (problem) {
    return (
      <div
        className={cn('rounded-lg border border-border-subtle bg-surface-sunken p-3', className)}
      >
        {/* Shown, not swallowed: the string is the evidence for why nothing was drawn, and a
            chemist can still read and copy it. */}
        <code className="block font-mono text-xs break-all">{smiles}</code>
        <p className="mt-1.5 text-xs text-ink-muted">
          {problem === 'unavailable'
            ? 'The structure toolkit could not be loaded, so nothing on this page can be drawn. The SMILES string is shown as written.'
            : 'Could not render this structure. The SMILES string is shown as written.'}
        </p>
      </div>
    );
  }

  return (
    <span
      // aspect-ratio reserves the box before the async draw lands, so nothing shifts under the
      // reader mid-stream.
      className={cn('block w-full [&>svg]:h-full [&>svg]:w-full', className)}
      style={{ maxWidth: `${maxWidth}px`, aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
      role="img"
      aria-label={`Chemical structure for SMILES ${smiles}`}
      // RDKit's SVG is generated from the molecule it just parsed, not from anything a user typed
      // into a page — and it is markup, so it has to be injected as markup.
      //
      // The empty string is the loading state, and it has to be expressed THIS way: React throws
      // at commit — not at build — on an element carrying both `children` and
      // `dangerouslySetInnerHTML`, so a placeholder child beside this prop is not an option.
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}

/**
 * A structure: one molecule, or a reaction.
 *
 * The dispatch lives here rather than at each call site because every existing caller — the job
 * card, the note panel, the hazard screen's `screened` list — can be handed either, and none of
 * them has any reason to know the difference. `>` is not a character a molecule SMILES can
 * contain, so the test is exact rather than heuristic.
 */
export function Molecule(props: MoleculeProps): React.JSX.Element {
  if (props.smiles.includes('>')) {
    return (
      <Reaction
        smiles={props.smiles}
        className={props.className ?? ''}
        // Reaction components share the row, so each is drawn smaller than a lone structure would
        // be. Halved rather than divided by the number of components: a five-component reaction
        // should scroll, not shrink to nothing.
        maxWidth={Math.round((props.maxWidth ?? 320) / 2)}
      />
    );
  }
  return <SingleMolecule {...props} />;
}

/**
 * An inline code span that might be a structure — in an answer, or in the chemist's own message.
 *
 * Two gates, and the second is what RDKit adds. It has always been *opt-in* — chemistry prose is
 * full of tokens that superficially resemble SMILES, so a structure was never drawn without a
 * click. The affordance itself is withheld until RDKit confirms the string is a structure, so a
 * token that merely looks like one no longer even offers a button. The syntactic recogniser
 * proposes; RDKit disposes.
 *
 * The check is asynchronous and the code span renders immediately, so the control appears a beat
 * later on the first structure of a page (the WASM is loading) and instantly thereafter. That is
 * the right way round: text a chemist can read and copy is never blocked on a 6.9 MB download.
 *
 * ## What changed, and what deliberately did not
 *
 * The per-instance `useState(false)` is gone. It made an answer naming six compounds six clicks,
 * and reset all six on a reload or a re-parse — asking the same chemist the same question over and
 * over, and never remembering the answer. `usePrefsStore.drawStructures` is that question asked
 * once (`src/components/chem/DrawStructuresToggle.tsx`); when it is on, the per-token button is not
 * merely pre-pressed, it is *gone*, because a control that can only be in one state is furniture.
 *
 * The gate itself did not change. Nothing is drawn from a recogniser's guess in either setting.
 *
 * ## Reactions reach this now
 *
 * `isMolecule` refuses a reaction — a molecule toolkit parses molecules — so gating on it alone
 * meant every reaction SMILES in every answer fell through to plain text, while `Molecule` has
 * been able to draw them all along. `readStructure` asks the right question of each kind.
 *
 * ## And the structure is an input
 *
 * `UseStructure` is what stops a drawing being terminal. Every structure this app rendered used to
 * be a picture: the agent would give a chemist the SMILES they asked for, the UI would draw it and
 * RDKit would confirm it, and the only way to ask a follow-up was to select the text with a mouse.
 */
export function InlineSmiles({ smiles }: { smiles: string }): React.JSX.Element {
  const always = usePrefsStore((s) => s.drawStructures);
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<ReadStructure | null>(null);
  const panelId = `smiles-${useId().replace(/:/g, '_')}`;

  useEffect(() => {
    let cancelled = false;
    void readStructure(smiles).then((structure) => {
      if (!cancelled) setRead(structure);
    });
    return () => {
      cancelled = true;
    };
  }, [smiles]);

  if (!read) return <code className="font-mono">{smiles}</code>;

  const shown = always || open;

  return (
    <span className="inline-flex flex-col gap-1 align-baseline">
      <span className="inline-flex items-baseline gap-1">
        <code className="font-mono">{smiles}</code>
        {/* Only while the preference is off. With it on this button has one reachable state, and
            the thing that changes it is the toggle in the top bar. */}
        {!always && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? `Hide structure for ${smiles}` : `Show structure for ${smiles}`}
            className={cn(
              // `current` rather than a named ink: this also renders inside the user's own message
              // bubble, which is a brand fill, and a fixed muted grey is illegible on it.
              'tap-target rounded-sm border border-current/40 px-1 text-[0.7em] opacity-70',
              'transition-opacity hover:opacity-100',
              'focus-ring',
            )}
          >
            {open ? 'hide' : '⌬'}
          </button>
        )}
      </span>
      {shown && (
        <span
          id={panelId}
          className="block rounded-lg border border-border-subtle bg-surface-raised p-2 text-ink"
        >
          {/* The canonical form, not the spelling in the text: this is the structure, and it is
              also what `UseStructure` hands back, so the two cannot disagree. */}
          <Molecule smiles={read.canonical} maxWidth={260} />
          <span className="mt-1 flex justify-end">
            <UseStructure smiles={read.canonical} label />
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Plain text with its structures made legible — the chemist's own message.
 *
 * A user message was a bare `<p>`: no markdown, no structure rendering, nothing. Assistant text got
 * the whole chemistry pipeline and the human's got none, which had a slightly perverse consequence.
 * The drawing `StructureInput` shows in order to satisfy "a chemist must never send a structure
 * they have not seen" was discarded at the moment of sending, and the durable record they scroll
 * back through three weeks later showed `COc1ccc(Br)cc1` as a bare string.
 *
 * This is deliberately **not** markdown. A chemist typed this text; running it through a parser
 * would turn their asterisks into emphasis and their underscores into italics in the middle of a
 * compound name. So the only transformation is the one that is safe on plain text: split on
 * whitespace, and hand each token that could be a structure to the same renderer the answers use.
 * Everything else, including the whitespace, is preserved exactly.
 */
export function StructureText({ text }: { text: string }): React.JSX.Element {
  // Split *keeping* the separators, so the original spacing and line breaks survive verbatim.
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) =>
        mightBeStructure(part) ? <InlineSmiles key={i} smiles={part} /> : part,
      )}
    </>
  );
}
