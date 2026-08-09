/**
 * SMILES rendering.
 *
 * `smiles-drawer` rather than `@rdkit/rdkit`: RDKit ships a multi-megabyte WASM binary plus a JS
 * glue loader and an async init handshake, which would dominate this bundle for what is currently
 * one field in one event payload (`job_completed.summary.molecule_smiles`). smiles-drawer is pure
 * JS, draws straight to SVG, and needs no initialisation.
 *
 * It is loaded with a dynamic import so it lands in its own chunk and is fetched only when a
 * structure actually appears. If the day comes that substructure highlighting is wanted — the
 * backend already advertises `substructure_matches` — RDKit becomes justified and this is the
 * only file that changes.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';

type Theme = 'light' | 'dark';

const prefersDark = (): Theme =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

interface DrawerLike {
  draw: (tree: unknown, target: string | SVGElement, theme: string) => void;
}

let drawerPromise: Promise<{ parse: (s: string) => unknown; drawer: DrawerLike }> | null = null;

async function loadDrawer(width: number, height: number) {
  if (!drawerPromise) {
    drawerPromise = import('smiles-drawer').then((mod) => {
      const SD = (mod as { default?: unknown }).default ?? mod;
      const lib = SD as {
        SvgDrawer: new (opts: Record<string, unknown>) => DrawerLike;
        parse: (smiles: string, ok: (tree: unknown) => void, fail: (e: unknown) => void) => void;
      };
      const drawer = new lib.SvgDrawer({ width, height, padding: 8, terminalCarbons: true });
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
  width?: number;
  height?: number;
  className?: string;
}

export function Molecule({
  smiles,
  width = 320,
  height = 220,
  className,
}: MoleculeProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * The SMILES that failed to render, rather than a boolean plus a reset.
   *
   * As a boolean this needed `setFailed(false)` at the top of the effect to clear the previous
   * input's failure — a synchronous setState in an effect body, which schedules a second render
   * pass on every single redraw. Keying the failure to the input makes the reset fall out of the
   * comparison: a new `smiles` is simply not the one that failed.
   */
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === smiles;
  const domId = useId().replace(/:/g, '_');

  useEffect(() => {
    let cancelled = false;

    loadDrawer(width, height)
      .then(({ parse, drawer }) => {
        if (cancelled || !svgRef.current) return;
        const tree = parse(smiles);
        drawer.draw(tree, svgRef.current, prefersDark());
      })
      .catch(() => {
        // An invalid or exotic SMILES must never leave a blank box — the caller renders the raw
        // string as a fallback so the chemist can still read and copy it.
        if (!cancelled) setFailedFor(smiles);
      });

    return () => {
      cancelled = true;
    };
  }, [smiles, width, height]);

  if (failed) {
    return (
      <div className={cn('rounded border border-border-subtle bg-surface-sunken p-3', className)}>
        <code className="block font-mono text-xs break-all">{smiles}</code>
        <p className="mt-1.5 text-xs text-ink-muted">
          Could not render this structure. The SMILES string is shown as written.
        </p>
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      id={domId}
      width={width}
      height={height}
      role="img"
      aria-label={`Structure for ${smiles}`}
      className={cn('max-w-full', className)}
    />
  );
}

/** An inline code span that parsed as a plausible SMILES: shown as text with a toggle, never
 *  auto-expanded. Chemistry prose contains many tokens that merely look like SMILES. */
export function InlineSmiles({ smiles }: { smiles: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
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
