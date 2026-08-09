/**
 * Structure rendering.
 *
 * A thin React shell over `src/chem/rdkit.ts`, which owns the WASM handshake and every Emscripten
 * handle. This file decides only *when* to draw and what to show while it cannot: the chemistry
 * lives one module down, where it is reachable from the entity store without dragging React in.
 *
 * Three states, and the third is the one that matters. A structure that has not loaded yet shows a
 * reserved box; a structure RDKit refuses to read shows the string it refused, marked as
 * unreadable. It never shows nothing, and it never shows a *different* molecule — which is the
 * failure this whole path is built to avoid, because a truncated SMILES frequently still parses as
 * a smaller, valid, wrong structure.
 */

import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { isMolecule, moleculeSvg, parseReactionSmiles } from '../chem/rdkit.ts';

type Theme = 'light' | 'dark';

const prefersDark = (): Theme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

interface MoleculeProps {
  smiles: string;
  width?: number;
  height?: number;
  /** A SMARTS motif to highlight — the pattern a hazard flag or a substructure search matched. */
  highlightSmarts?: string;
  className?: string;
}

export function Molecule({
  smiles,
  width = 260,
  height = 180,
  highlightSmarts,
  className,
}: MoleculeProps): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    void (async () => {
      const drawn = await moleculeSvg(smiles, {
        width,
        height,
        dark: prefersDark() === 'dark',
        ...(highlightSmarts ? { highlightSmarts } : {}),
      });
      // The await crossed a render boundary; a structure that has since been replaced must not
      // overwrite the one now on screen.
      if (cancelled) return;
      if (drawn) setSvg(drawn);
      else setFailed(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [smiles, width, height, highlightSmarts]);

  if (failed) {
    return (
      <div
        className={cn(
          'rounded border border-border-subtle bg-surface-sunken p-2 font-mono text-xs',
          'break-all text-ink-muted',
          className,
        )}
        style={{ maxWidth: width }}
      >
        <span className="mr-1" aria-hidden>
          ⚠
        </span>
        {/* Shown, not swallowed: the string is the evidence for why nothing was drawn. */}
        <span title="Not a structure this renderer could read">{smiles}</span>
      </div>
    );
  }

  // Two returns rather than one element with a conditional prop: React refuses an element carrying
  // both `children` and `dangerouslySetInnerHTML`, and spreading the second onto a node that also
  // renders a placeholder is exactly that — it throws at commit, not at build.
  if (!svg) {
    return (
      <div className={cn('inline-block', className)} style={{ width, height }} aria-hidden>
        {/* Reserved space while the WASM loads, so a card does not jump when the drawing lands. */}
        <div className="h-full w-full animate-pulse rounded bg-surface-sunken" />
      </div>
    );
  }

  return (
    <div
      className={cn('inline-block', className)}
      style={{ width, height }}
      role="img"
      aria-label={`Structure of ${smiles}`}
      // RDKit's SVG is generated from the molecule we just parsed, not from anything a user typed
      // into a page — and it is markup, so it has to be injected as markup.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * An inline code span in the answer that might be a structure.
 *
 * Two gates, and the second is new. It has always been *opt-in* — chemistry prose is full of tokens
 * that superficially resemble SMILES (`pH`, `1H`, unit strings), so a structure was never drawn
 * without a click. Now the affordance itself is withheld until RDKit confirms the string is a
 * molecule, so a token that merely looks like one no longer even offers a button. The syntactic
 * recogniser proposes; RDKit disposes.
 *
 * The check is asynchronous and the code span renders immediately, so the toggle appears a beat
 * later on the first structure of a page (the WASM is loading) and instantly thereafter. That is
 * the right way round: text a chemist can read and copy is never blocked on a 6.9 MB download.
 */
export function InlineSmiles({ smiles }: { smiles: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renderable, setRenderable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isMolecule(smiles).then((ok) => {
      if (!cancelled) setRenderable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [smiles]);

  if (!renderable) return <code>{smiles}</code>;

  return (
    <span className="inline-flex flex-col gap-1 align-baseline">
      <span className="inline-flex items-baseline gap-1">
        <code>{smiles}</code>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-border-subtle px-1 text-[0.7em] text-ink-muted hover:bg-surface-sunken"
          title={open ? 'Hide structure' : 'Render structure'}
        >
          {open ? 'hide' : '⌬'}
        </button>
      </span>
      {open && (
        <span className="block rounded border border-border-subtle bg-surface-raised p-2">
          <Molecule smiles={smiles} width={260} height={180} />
        </span>
      )}
    </span>
  );
}

/**
 * A reaction drawn as a reaction: every reactant, an arrow, every product.
 *
 * Composed rather than handed to a reaction drawer because RDKit's minimal build ships none. Agents
 * — the middle field of a reaction SMILES, where catalysts and solvents live — are rendered above
 * the arrow, which is where a chemist reads them.
 */
export function Reaction({
  reactionSmiles,
  width = 150,
  height = 110,
  className,
}: {
  reactionSmiles: string;
  width?: number;
  height?: number;
  className?: string;
}): React.JSX.Element | null {
  const parsed = parseReactionSmiles(reactionSmiles);
  if (!parsed) return null;

  const side = (smilesList: string[]): React.JSX.Element[] =>
    smilesList.map((s, i) => (
      <span key={`${s}-${i}`} className="flex items-center gap-1">
        {i > 0 && <span className="text-ink-muted">+</span>}
        <Molecule smiles={s} width={width} height={height} />
      </span>
    ));

  return (
    <div className={cn('flex flex-wrap items-center gap-2 overflow-x-auto', className)}>
      {side(parsed.reactants)}
      <span className="flex shrink-0 flex-col items-center px-1 text-ink-muted">
        {parsed.agents.length > 0 && (
          <span className="max-w-32 truncate font-mono text-[10px]" title={parsed.agents.join(', ')}>
            {parsed.agents.join(', ')}
          </span>
        )}
        <span aria-label="reacts to form">→</span>
      </span>
      {side(parsed.products)}
    </div>
  );
}
