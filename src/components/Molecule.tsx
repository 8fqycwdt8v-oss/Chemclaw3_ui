/**
 * SMILES rendering with RDKit-WASM (see `src/chem/rdkit.ts` for why RDKit and how it stays out of
 * the entry chunk). Reactions are split here and drawn component by component; drawings are
 * `viewBox`-scaled in an `aspect-ratio` wrapper so space is reserved; the theme comes from the
 * app's `data-theme` so the in-app toggle redraws.
 */

import { useEffect, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import {
  MAX_PARSED_SMILES_CHARS,
  moleculeSvg,
  rdkitAvailable,
  tooLongToParse,
} from '../chem/rdkit.ts';
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
 * A reaction SMILES (`reactants>agents>products`, or `A>>B`): each component is drawn as a molecule
 * with the arrows laid out here (RDKit's minimal build has no reaction object). `>` cannot occur in
 * a molecule SMILES, so the split is exact.
 */
function Reaction({ smiles, className, maxWidth }: Required<MoleculeProps>): React.JSX.Element {
  const [reactants = '', agents = '', products = ''] = smiles.split('>');
  // A plain function, not a nested component, so the subtree is not remounted every render.
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
  /**
   * Why nothing was drawn: `unavailable` (the page), `too-large` (our parse cap) or `unreadable`
   * (the only claim about the chemistry).
   */
  const [problem, setProblem] = useState<'unreadable' | 'unavailable' | 'too-large' | null>(null);
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
      // "Not a molecule" is only said when the toolkit loaded and the string was within the parse
      // cap.
      if (tooLongToParse(smiles)) {
        setProblem('too-large');
        setSvg(null);
        return;
      }
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
        {/* The string is shown, not swallowed: it explains why nothing was drawn. */}
        <code className="block font-mono text-xs break-all">{smiles}</code>
        <p className="mt-1.5 text-xs text-ink-muted">
          {problem === 'unavailable'
            ? 'The structure toolkit could not be loaded, so nothing on this page can be drawn. The SMILES string is shown as written.'
            : problem === 'too-large'
              ? `This structure is too large to draw here — ${smiles.length} characters of SMILES, against a limit of ${MAX_PARSED_SMILES_CHARS}. It is a molecule; it is the drawing that is refused. The SMILES string is shown as written.`
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
      // RDKit's SVG is generated from the parsed molecule, so it is injected as markup. `''` is the
      // loading state: React forbids `children` beside `dangerouslySetInnerHTML`.
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}

/**
 * A structure: one molecule or a reaction, so callers need not know which (`>` makes the test
 * exact).
 */
export function Molecule(props: MoleculeProps): React.JSX.Element {
  if (props.smiles.includes('>')) {
    return (
      <Reaction
        smiles={props.smiles}
        className={props.className ?? ''}
        // Reaction components share a row: each at half width, scrolling rather than shrinking.
        maxWidth={Math.round((props.maxWidth ?? 320) / 2)}
      />
    );
  }
  return <SingleMolecule {...props} />;
}

/**
 * An inline code span that might be a structure. The recogniser proposes and RDKit confirms
 * (`readStructure`, molecules and reactions) before any control appears; nothing is drawn from a
 * guess. With the "draw structures" preference on (`usePrefsStore.drawStructures`) confirmed
 * structures draw directly; otherwise a per-token button. `UseStructure` lets a drawn structure be
 * inserted into the composer.
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

  // `too-complex` renders like "not a structure": this surface makes no claim either way.
  if (!read || read.kind === 'too-complex') return <code className="font-mono">{smiles}</code>;

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
 * Plain text with its structures drawable — the chemist's own message. Not markdown (asterisks in a
 * compound name are not emphasis): split on whitespace and hand structure-like tokens to the same
 * renderer the answers use; everything else is preserved exactly.
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
