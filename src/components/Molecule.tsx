/**
 * SMILES rendering.
 *
 * smiles-drawer rather than RDKit-WASM: this only ever needs a 2D depiction, and RDKit's payload
 * is two orders of magnitude larger than the whole rest of the bundle. Loaded dynamically so it
 * costs nothing until a structure actually appears.
 *
 * Three things this had wrong, all fixed together because they share a cause — the drawer being a
 * module singleton built with whichever size happened to render first:
 *
 *  - Every later structure was drawn at the first caller's scale. A job card asked for 280x190 and
 *    an inline toggle for 260x180, so one of them was always letterboxed inside the other's box.
 *  - `max-w-full` on an attribute-sized <svg> shrinks the width and leaves `height` alone, so a
 *    structure squashed rather than scaled on a narrow screen.
 *  - Theme was read straight from `prefers-color-scheme`, so with an in-app toggle a structure
 *    stayed dark on a light page (and never re-drew when the OS flipped, either).
 *
 * Now: one drawer at a canonical size, a `viewBox` so the SVG scales proportionally, an
 * `aspect-ratio` wrapper so the space is reserved before it draws (no layout shift), and the
 * theme read from the same `data-theme` the rest of the app uses.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useThemeStore } from '../state/themeStore.ts';

/** One canonical drawing size. The viewBox scales it to whatever the layout gives it. */
const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 220;

interface DrawerLike {
  draw: (tree: unknown, target: string | SVGElement, theme: string) => void;
}

let drawerPromise: Promise<{ parse: (s: string) => unknown; drawer: DrawerLike }> | null = null;

async function loadDrawer() {
  if (!drawerPromise) {
    drawerPromise = import('smiles-drawer').then((mod) => {
      const SD = (mod as { default?: unknown }).default ?? mod;
      const lib = SD as {
        SvgDrawer: new (opts: Record<string, unknown>) => DrawerLike;
        parse: (smiles: string, ok: (tree: unknown) => void, fail: (e: unknown) => void) => void;
      };
      const drawer = new lib.SvgDrawer({
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        padding: 12,
        terminalCarbons: true,
      });
      const parse = (smiles: string): unknown => {
        let parsed: unknown = null;
        let failure: unknown = null;
        // parse() is synchronous despite the callback signature.
        lib.parse(
          smiles,
          (tree) => {
            parsed = tree;
          },
          (err) => {
            failure = err;
          },
        );
        if (failure || parsed === null) throw failure ?? new Error('could not parse SMILES');
        return parsed;
      };
      return { parse, drawer };
    });
  }
  return drawerPromise;
}

export interface MoleculeProps {
  smiles: string;
  className?: string;
  /** Caps the rendered width; the structure scales within it rather than being cropped. */
  maxWidth?: number;
}

export function Molecule({ smiles, className, maxWidth = 320 }: MoleculeProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [failed, setFailed] = useState(false);
  const domId = useId().replace(/:/g, '_');
  // Subscribing to the app's resolved theme, so a structure re-draws when the user flips the
  // toggle — not only when the OS preference changes.
  const theme = useThemeStore((s) => s.resolved);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    loadDrawer()
      .then(({ parse, drawer }) => {
        if (cancelled || !svgRef.current) return;
        const tree = parse(smiles);
        drawer.draw(tree, svgRef.current, theme);
      })
      .catch(() => {
        // An invalid or exotic SMILES must never leave a blank box — we render the raw string
        // instead so the chemist can still read and copy it.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [smiles, theme]);

  if (failed) {
    return (
      <div
        className={cn('rounded-lg border border-border-subtle bg-surface-sunken p-3', className)}
      >
        <code className="block font-mono text-xs break-all">{smiles}</code>
        <p className="mt-1.5 text-xs text-ink-muted">
          Could not render this structure. The SMILES string is shown as written.
        </p>
      </div>
    );
  }

  return (
    <span
      // aspect-ratio reserves the box before the async draw lands, so nothing shifts under the
      // reader mid-stream.
      className={cn('block w-full', className)}
      style={{ maxWidth: `${maxWidth}px`, aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
    >
      <svg
        ref={svgRef}
        id={domId}
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Chemical structure for SMILES ${smiles}`}
        className="h-full w-full"
      >
        <title>{`Chemical structure for SMILES ${smiles}`}</title>
      </svg>
    </span>
  );
}

/** An inline code span that parsed as a plausible SMILES: shown as text with a toggle, never
 *  auto-expanded. Chemistry prose contains many tokens that merely look like SMILES. */
export function InlineSmiles({ smiles }: { smiles: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = `smiles-${useId().replace(/:/g, '_')}`;

  return (
    <span className="inline-flex flex-col gap-1 align-baseline">
      <span className="inline-flex items-baseline gap-1">
        <code>{smiles}</code>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? `Hide structure for ${smiles}` : `Show structure for ${smiles}`}
          className={cn(
            'tap-target rounded-sm border border-border-subtle px-1 text-[0.7em] text-ink-muted',
            'transition-colors hover:bg-surface-sunken hover:text-ink',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {open ? 'hide' : '⌬'}
        </button>
      </span>
      {open && (
        <span
          id={panelId}
          className="block rounded-lg border border-border-subtle bg-surface-raised p-2"
        >
          <Molecule smiles={smiles} maxWidth={260} />
        </span>
      )}
    </span>
  );
}
