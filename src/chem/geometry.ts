/**
 * A 3D structure, as data: read an XYZ block, perceive its bonds, turn it, and project it flat.
 *
 * The pure half of the geometry viewer (`src/components/chem/GeometryViewer.tsx`), kept free of
 * React and the DOM so every number the viewer draws is a number a unit test can check — the same
 * split `rdkit.ts` keeps between a structure and its depiction.
 *
 * ## Why hand-written, rather than 3Dmol.js or NGL
 *
 * A molecular-graphics library is hundreds of kilobytes and a WebGL context, and this application
 * ships through a pharma dependency review that costs more than the code does (`docs/dependencies.md`:
 * the charts and the pane resizer are hand-written for the same reason). What an artefact needs is
 * modest and bounded — one semiempirical structure of at most `exhibit_max_atoms` (500) atoms, ball
 * and stick, turned by hand — and every piece of that is a few lines of arithmetic: an XYZ reader,
 * covalent-radius bond perception, a rotation matrix and an orthographic projection with a
 * painter's sort. None of it is a place a library's maturity buys correctness this file cannot test.
 *
 * ## What is deliberately not here
 *
 * - **No bond orders.** An XYZ block carries positions only, and inferring double bonds from
 *   distances is a heuristic that is wrong exactly where a chemist looks hardest (conjugation,
 *   metal complexes). Every bond is drawn the same, which is what the data supports.
 * - **No perspective.** Orthographic, because a structure being *measured by eye* — is this
 *   contact short, is that ring planar — reads honestly only when distance from the viewer does not
 *   change apparent size. Depth is conveyed by draw order and by fading instead.
 */

/** One atom: its element symbol, normalised (`CL` → `Cl`), and its position in ångström. */
export interface Atom {
  element: string;
  x: number;
  y: number;
  z: number;
}

/** A parsed structure. `comment` is the XYZ comment line, verbatim; `frames` counts every frame. */
export interface Geometry {
  atoms: Atom[];
  comment: string;
  /**
   * How many frames the text held. Only the first is read. An inline artefact block is a single
   * frame by the service's validation, but a cited calc artifact is the calc store's bytes, which
   * nothing validated on the way out — an optimisation trajectory is a plausible thing to cite, and
   * the viewer says "first of N" rather than silently showing one frame as if it were the file.
   */
  frames: number;
}

/** Why a block could not be read, in a sentence a chemist can act on. */
export class XyzError extends Error {
  override name = 'XyzError';
}

/**
 * Covalent radii in ångström — Cordero et al., *Dalton Trans.* 2008, 2832 — the table every
 * mainstream bond-perception routine (Open Babel, RDKit's `DetermineConnectivity`) starts from.
 * Carbon is the sp3 value; Mn, Fe and Co are low-spin, which is the common case in the
 * organometallic catalysts this system is asked about.
 *
 * Laid out as rows (and kept from the formatter) because a table of elements is read as one.
 */
// prettier-ignore
const COVALENT_RADIUS: Readonly<Record<string, number>> = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76,
  Sc: 1.7, Ti: 1.6, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22,
  Ga: 1.22, Ge: 1.2, As: 1.19, Se: 1.2, Br: 1.2, Kr: 1.16, Rb: 2.2, Sr: 1.95, Y: 1.9, Zr: 1.75,
  Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39,
  Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.4, Cs: 2.44, Ba: 2.15, La: 2.07, Hf: 1.75, Ta: 1.7, W: 1.62,
  Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32, Tl: 1.45, Pb: 1.46, Bi: 1.48,
};

/**
 * CPK colours, in the Jmol palette every chemist has seen — carbon grey, nitrogen blue, oxygen red.
 *
 * Colour is never the only carrier of an element (`Charts.tsx`'s rule): the atom table names each
 * one, and the drawing's accessible summary counts them by symbol.
 */
// prettier-ignore
const CPK: Readonly<Record<string, string>> = {
  H: '#ffffff', He: '#d9ffff', Li: '#cc80ff', Be: '#c2ff00', B: '#ffb5b5', C: '#909090',
  N: '#3050f8', O: '#ff0d0d', F: '#90e050', Ne: '#b3e3f5', Na: '#ab5cf2', Mg: '#8aff00',
  Al: '#bfa6a6', Si: '#f0c8a0', P: '#ff8000', S: '#ffff30', Cl: '#1ff01f', Ar: '#80d1e3',
  K: '#8f40d4', Ca: '#3dff00', Sc: '#e6e6e6', Ti: '#bfc2c7', V: '#a6a6ab', Cr: '#8a99c7',
  Mn: '#9c7ac7', Fe: '#e06633', Co: '#f090a0', Ni: '#50d050', Cu: '#c88033', Zn: '#7d80b0',
  Ga: '#c28f8f', Ge: '#668f8f', As: '#bd80e3', Se: '#ffa100', Br: '#a62929', Kr: '#5cb8d1',
  Rb: '#702eb0', Sr: '#00ff00', Y: '#94ffff', Zr: '#94e0e0', Nb: '#73c2c9', Mo: '#54b5b5',
  Tc: '#3b9e9e', Ru: '#248f8f', Rh: '#0a7d8c', Pd: '#006985', Ag: '#c0c0c0', Cd: '#ffd98f',
  In: '#a67573', Sn: '#668080', Sb: '#9e63b5', Te: '#d47a00', I: '#940094', Xe: '#429eb0',
  Cs: '#57178f', Ba: '#00c900', La: '#70d4ff', Hf: '#4dc2ff', Ta: '#4da6ff', W: '#2194d6',
  Re: '#267dab', Os: '#266696', Ir: '#175487', Pt: '#d0d0e0', Au: '#ffd123', Hg: '#b8b8d0',
  Tl: '#a6544d', Pb: '#575961', Bi: '#9e4fb5',
};

/** The colour Jmol gives an element it has no entry for — loud on purpose, so it is noticed. */
const UNKNOWN_COLOUR = '#ff1493';
/** A radius for an element outside the table: a typical transition metal's, so bonds still form. */
const UNKNOWN_RADIUS = 1.5;

/**
 * How far past the sum of two covalent radii a contact still counts as a bond, in ångström.
 *
 * Open Babel's `ConnectTheDots` constant. A semiempirical geometry stretches a bond by a few
 * hundredths at most, so the margin is generous for organics; what it must not do is bond two
 * non-bonded hydrogens 1.5 Å apart (0.31 + 0.31 + 0.45 = 1.07 < 1.5), and it does not.
 */
export const BOND_TOLERANCE_A = 0.45;
/** Closer than this is two atoms on one spot — an input error, never a bond. */
const MIN_BOND_A = 0.4;

export const covalentRadius = (element: string): number =>
  COVALENT_RADIUS[element] ?? UNKNOWN_RADIUS;
export const elementColour = (element: string): string => CPK[element] ?? UNKNOWN_COLOUR;
/** Whether this build knows the element — the table's "unrecognised" mark reads it. */
export const isKnownElement = (element: string): boolean => element in COVALENT_RADIUS;

/** `CL` → `Cl`, `c` → `C`: the case-insensitive reading the service validates with. */
const normaliseSymbol = (raw: string): string =>
  raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();

/**
 * Read the first frame of an XYZ block: atom count, comment, then `El x y z` per atom in ångström.
 *
 * Tolerant where the format's writers vary and strict where a wrong reading would be a wrong
 * structure. Columns after the fourth are ignored (extended XYZ writes forces and charges there),
 * a leading isotope or atom-number on the symbol is not guessed at, and a symbol that is a number
 * (`6` for carbon, which some programs write) is refused rather than mapped — because a block
 * whose elements are numbers is one whose other columns this reader cannot vouch for either.
 *
 * @throws XyzError naming the line, as the service's validator does.
 */
export function parseXyz(text: string): Geometry {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const atoms: Atom[] = [];
  let comment = '';
  let frames = 0;
  let at = 0;
  while (at < lines.length) {
    // Blank lines between or after frames are what writers leave; they are not content.
    if ((lines[at] ?? '').trim() === '') {
      at += 1;
      continue;
    }
    const count = Number((lines[at] ?? '').trim());
    if (!Number.isInteger(count) || count < 1) {
      if (frames === 0)
        throw new XyzError('The first line of an XYZ block must be the atom count.');
      // Trailing text after the last complete frame: a log footer, not a frame.
      break;
    }
    if (frames === 0) {
      comment = lines[at + 1] ?? '';
      for (let i = 0; i < count; i += 1) {
        const number = at + 2 + i + 1;
        const line = lines[at + 2 + i];
        if (line === undefined || line.trim() === '') {
          throw new XyzError(
            `The count line says ${count} atoms, but the block ends after ${i} (line ${number}).`,
          );
        }
        const fields = line.trim().split(/\s+/);
        if (fields.length < 4) {
          throw new XyzError(`Line ${number}: expected "El x y z", got ${fields.length} fields.`);
        }
        const element = normaliseSymbol(fields[0]!);
        if (!/^[A-Z][a-z]?$/.test(element)) {
          throw new XyzError(`Line ${number}: "${fields[0]}" is not an element symbol.`);
        }
        const [x, y, z] = fields.slice(1, 4).map(Number) as [number, number, number];
        if (![x, y, z].every(Number.isFinite)) {
          throw new XyzError(`Line ${number}: a coordinate is not a finite number.`);
        }
        atoms.push({ element, x, y, z });
      }
    }
    frames += 1;
    at += count + 2;
  }
  if (frames === 0) throw new XyzError('The XYZ block is empty.');
  return { atoms, comment, frames };
}

/** A bond between two atoms, by index, the smaller first. */
export type Bond = readonly [number, number];

/**
 * Every pair of atoms close enough to be bonded: `d ≤ rᵢ + rⱼ + BOND_TOLERANCE_A`.
 *
 * A sweep over the atoms sorted by `x` rather than every pair: a pair further apart along `x` than
 * the largest cut-off any pair could have cannot bond, so each atom is compared only with the
 * neighbours inside that window. For a 500-atom structure that is a few thousand distance checks
 * instead of 124,750 — irrelevant for the inline cap, and the reason a cited calc artifact with no
 * cap does not stall the pane.
 */
export function perceiveBonds(atoms: readonly Atom[]): Bond[] {
  const order = atoms.map((_, i) => i).sort((a, b) => atoms[a]!.x - atoms[b]!.x);
  const largest = atoms.reduce((m, atom) => Math.max(m, covalentRadius(atom.element)), 0);
  const window = 2 * largest + BOND_TOLERANCE_A;
  const bonds: Bond[] = [];
  for (let p = 0; p < order.length; p += 1) {
    const i = order[p]!;
    const a = atoms[i]!;
    for (let q = p + 1; q < order.length; q += 1) {
      const j = order[q]!;
      const b = atoms[j]!;
      if (b.x - a.x > window) break;
      const cutoff = covalentRadius(a.element) + covalentRadius(b.element) + BOND_TOLERANCE_A;
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
      if (d2 <= cutoff * cutoff && d2 >= MIN_BOND_A * MIN_BOND_A) {
        bonds.push(i < j ? [i, j] : [j, i]);
      }
    }
  }
  return bonds.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** A 3×3 rotation matrix, row-major. */
export type Matrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `a · b` — apply `b` first, then `a`. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  const out: number[] = [];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
    }
  }
  return out as unknown as Matrix;
}

/** Rotation about the screen's vertical axis by `radians` (positive turns the front to the right). */
export const rotationY = (radians: number): Matrix => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};

/** Rotation about the screen's horizontal axis by `radians` (positive tips the top towards you). */
export const rotationX = (radians: number): Matrix => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};

/**
 * Turn the view by a drag of `(dx, dy)` radians, in *screen* axes.
 *
 * Pre-multiplied, so a horizontal drag always turns the molecule about the vertical axis of the
 * screen, wherever earlier drags left it — the trackball behaviour every viewer has, and the one a
 * post-multiplied rotation gets wrong after the first quarter turn.
 */
export const turn = (view: Matrix, dx: number, dy: number): Matrix =>
  multiply(multiply(rotationX(dy), rotationY(dx)), view);

/** Where to look from, and how far in. `zoom` 1 fits the structure to the frame. */
export interface Camera {
  rotation: Matrix;
  zoom: number;
}

/** One atom, projected: where it is drawn, how big, and how far back it sits. */
export interface ProjectedAtom {
  index: number;
  sx: number;
  sy: number;
  /** Depth along the viewing axis in ångström; larger is nearer the viewer. */
  depth: number;
  /** The ball's drawn radius in frame units. */
  radius: number;
  /** 0 for the furthest atom, 1 for the nearest — what the depth cue fades by. */
  nearness: number;
}

/**
 * The drawn radius of a ball, in ångström: a fraction of the covalent radius plus a floor.
 *
 * Ball-and-stick rather than space-filling, so the bonds stay visible: hydrogen comes out at
 * ~0.27 Å and carbon at ~0.39 Å, both well under half a C–H bond, so a bond is never hidden by the
 * two balls it joins.
 */
export const ballRadius = (element: string): number => 0.18 + 0.28 * covalentRadius(element);

/** The frame's empty border, as a fraction of its smaller side — room for the outermost balls. */
const FRAME_MARGIN = 0.08;

/**
 * Project every atom orthographically into a `width × height` frame centred on the centroid.
 *
 * The scale is fixed by the structure's *radius about its centroid*, not by its extent on screen,
 * so turning the molecule never rescales it — a zoom that breathed as you rotated would read as
 * the molecule changing size.
 */
export function project(
  atoms: readonly Atom[],
  camera: Camera,
  width: number,
  height: number,
): ProjectedAtom[] {
  if (atoms.length === 0) return [];
  const n = atoms.length;
  const cx = atoms.reduce((s, a) => s + a.x, 0) / n;
  const cy = atoms.reduce((s, a) => s + a.y, 0) / n;
  const cz = atoms.reduce((s, a) => s + a.z, 0) / n;
  const extent = Math.max(
    1,
    ...atoms.map((a) => Math.hypot(a.x - cx, a.y - cy, a.z - cz) + ballRadius(a.element)),
  );
  const half = Math.min(width, height) / 2;
  const scale = ((half * (1 - 2 * FRAME_MARGIN)) / extent) * camera.zoom;
  const m = camera.rotation;
  const rotated = atoms.map((a) => {
    const x = a.x - cx;
    const y = a.y - cy;
    const z = a.z - cz;
    return [
      m[0] * x + m[1] * y + m[2] * z,
      m[3] * x + m[4] * y + m[5] * z,
      m[6] * x + m[7] * y + m[8] * z,
    ] as const;
  });
  const depths = rotated.map((r) => r[2]);
  const far = Math.min(...depths);
  const span = Math.max(...depths) - far;
  return rotated.map(([x, y, z], index) => ({
    index,
    sx: width / 2 + x * scale,
    // Screen y grows downwards; chemistry's y grows up.
    sy: height / 2 - y * scale,
    depth: z,
    radius: ballRadius(atoms[index]!.element) * scale,
    nearness: span > 1e-9 ? (z - far) / span : 1,
  }));
}

/**
 * How opaque a mark at `nearness` is drawn: the depth cue.
 *
 * Fading toward the background rather than darkening, so the cue reads the same in both themes,
 * and never below 0.35 — the back of a molecule is still part of it, and a mark faded to nothing
 * would be an atom the drawing silently dropped.
 */
export const depthOpacity = (nearness: number): number => 0.35 + 0.65 * nearness;

/** One thing to draw: a ball, or half a bond (coloured by the atom it leaves). */
export type Mark =
  | { kind: 'atom'; atom: ProjectedAtom; depth: number }
  | {
      kind: 'bond';
      /** The atom this half belongs to — its colour — and the one it points at. */
      from: ProjectedAtom;
      to: ProjectedAtom;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      depth: number;
    };

/**
 * Every mark, furthest first: the painter's algorithm.
 *
 * A bond is two halves, each starting at the *surface* of its own ball rather than its centre, and
 * each sorted by its own midpoint's depth. Starting at the centre is what makes a naive painter
 * draw a stick through the front of a ball that sits behind it; starting at the surface, the only
 * overlap left is with the other ball, which the sort gets right. A bond whose projection is
 * shorter than its two balls is end-on to the viewer and is hidden behind them, so it is not drawn.
 */
export function paint(projected: readonly ProjectedAtom[], bonds: readonly Bond[]): Mark[] {
  const marks: Mark[] = projected.map((atom) => ({ kind: 'atom', atom, depth: atom.depth }));
  for (const [i, j] of bonds) {
    const a = projected[i];
    const b = projected[j];
    if (!a || !b) continue;
    const dx = b.sx - a.sx;
    const dy = b.sy - a.sy;
    const length = Math.hypot(dx, dy);
    if (length <= (a.radius + b.radius) * 0.9) continue;
    const ux = dx / length;
    const uy = dy / length;
    const mx = (a.sx + b.sx) / 2;
    const my = (a.sy + b.sy) / 2;
    const md = (a.depth + b.depth) / 2;
    marks.push(
      {
        kind: 'bond',
        from: a,
        to: b,
        x1: a.sx + ux * a.radius * 0.8,
        y1: a.sy + uy * a.radius * 0.8,
        x2: mx,
        y2: my,
        depth: (a.depth + md) / 2,
      },
      {
        kind: 'bond',
        from: b,
        to: a,
        x1: b.sx - ux * b.radius * 0.8,
        y1: b.sy - uy * b.radius * 0.8,
        x2: mx,
        y2: my,
        depth: (b.depth + md) / 2,
      },
    );
  }
  // Stable for equal depths, so a planar molecule seen face-on draws in a fixed order rather than
  // flickering as the sort's tie-breaking moves.
  return marks
    .map((mark, order) => ({ mark, order }))
    .sort((p, q) => p.mark.depth - q.mark.depth || p.order - q.order)
    .map((entry) => entry.mark);
}

/** `C6H12O`-style counts in Hill order (C, then H, then the rest alphabetically) — the summary. */
export function formula(atoms: readonly Atom[]): string {
  const counts = new Map<string, number>();
  for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1);
  const hasCarbon = counts.has('C');
  const order = [...counts.keys()].sort((a, b) => {
    const rank = (e: string): number => (hasCarbon ? (e === 'C' ? 0 : e === 'H' ? 1 : 2) : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return order.map((e) => `${e}${counts.get(e) === 1 ? '' : counts.get(e)}`).join('');
}
