/**
 * The geometry viewer's arithmetic, with no DOM: the XYZ reader, covalent-radius bond perception,
 * the rotation and the orthographic projection, and the painter's order.
 *
 * Each is a place a plausible-looking drawing can be wrong without anything on screen saying so — a
 * bond to a hydrogen 1.5 Å away, a drag that turns about the wrong axis after a quarter turn, a
 * stick drawn through the front of a ball behind it — so each is pinned by a number.
 */

import { describe, expect, it } from 'vitest';
import {
  BOND_TOLERANCE_A,
  IDENTITY,
  XyzError,
  ballRadius,
  depthOpacity,
  formula,
  multiply,
  paint,
  parseXyz,
  perceiveBonds,
  project,
  rotationX,
  rotationY,
  turn,
  type Atom,
  type Matrix,
} from '../src/chem/geometry.ts';

/** Water, as xtb writes it: count, comment, then `El x y z` in ångström. */
const WATER = `3
 energy: -5.070544440612 gnorm: 0.000123 xtb: 6.7.1
O      0.00000000    0.00000000    0.11779000
H      0.00000000    0.75545000   -0.47116000
H      0.00000000   -0.75545000   -0.47116000
`;

/** Ethane, staggered — two carbons 1.53 Å apart and six hydrogens, none of them bonded to another. */
const ETHANE = `8
ethane
C   0.0000  0.0000  0.7650
C   0.0000  0.0000 -0.7650
H   1.0186  0.0000  1.1573
H  -0.5093  0.8821  1.1573
H  -0.5093 -0.8821  1.1573
H  -1.0186  0.0000 -1.1573
H   0.5093 -0.8821 -1.1573
H   0.5093  0.8821 -1.1573
`;

const close = (actual: number, expected: number, digits = 9): void =>
  expect(actual).toBeCloseTo(expected, digits);

const apply = (m: Matrix, [x, y, z]: [number, number, number]): [number, number, number] => [
  m[0] * x + m[1] * y + m[2] * z,
  m[3] * x + m[4] * y + m[5] * z,
  m[6] * x + m[7] * y + m[8] * z,
];

describe('parseXyz', () => {
  it('reads the count, the comment and every atom, in ångström', () => {
    const g = parseXyz(WATER);
    expect(g.atoms).toHaveLength(3);
    expect(g.comment).toContain('energy: -5.070544440612');
    expect(g.frames).toBe(1);
    expect(g.atoms[1]).toEqual({ element: 'H', x: 0, y: 0.75545, z: -0.47116 });
  });

  it('normalises the symbol the way the service validates it (CL is chlorine)', () => {
    const g = parseXyz('2\n\nCL 0 0 0\nbr 0 0 2.1\n');
    expect(g.atoms.map((a) => a.element)).toEqual(['Cl', 'Br']);
  });

  it('ignores columns past the fourth, which extended XYZ uses for forces and charges', () => {
    const g = parseXyz(
      '1\nLattice="..." Properties=species:S:1:pos:R:3:forces:R:3\nC 1 2 3 0.1 0.2 0.3\n',
    );
    expect(g.atoms[0]).toEqual({ element: 'C', x: 1, y: 2, z: 3 });
  });

  it('reads the first frame of a trajectory and says how many there were', () => {
    const two = `${WATER}${WATER}`;
    const g = parseXyz(two);
    expect(g.atoms).toHaveLength(3);
    expect(g.frames).toBe(2);
  });

  it('accepts CRLF line endings, which a file from another package often has', () => {
    expect(parseXyz(WATER.replace(/\n/g, '\r\n')).atoms).toHaveLength(3);
  });

  it('refuses rather than draws a structure it cannot vouch for, naming the line', () => {
    expect(() => parseXyz('')).toThrow(XyzError);
    expect(() => parseXyz('water\n\nO 0 0 0\n')).toThrow(/atom count/);
    expect(() => parseXyz('3\n\nO 0 0 0\nH 0 0 1\n')).toThrow(/says 3 atoms.*ends after 2/);
    expect(() => parseXyz('1\n\nO 0 0\n')).toThrow(/Line 3: expected "El x y z", got 3/);
    expect(() => parseXyz('1\n\n6 0 0 0\n')).toThrow(/Line 3: "6" is not an element symbol/);
    expect(() => parseXyz('1\n\nO 0 NaN 0\n')).toThrow(/Line 3: a coordinate is not a finite/);
    expect(() => parseXyz('1\n\nO 0 1e999 0\n')).toThrow(/finite/);
  });
});

describe('perceiveBonds', () => {
  it('bonds water as two O–H bonds and no H–H bond', () => {
    expect(perceiveBonds(parseXyz(WATER).atoms)).toEqual([
      [0, 1],
      [0, 2],
    ]);
  });

  it('bonds ethane as C–C plus six C–H, with no geminal H–H bond (1.78 Å apart)', () => {
    const bonds = perceiveBonds(parseXyz(ETHANE).atoms);
    expect(bonds).toHaveLength(7);
    expect(bonds).toContainEqual([0, 1]);
    // No bond joins two hydrogens.
    expect(bonds.filter(([i, j]) => i >= 2 && j >= 2)).toEqual([]);
  });

  it('uses the sum of covalent radii plus the tolerance as the cut-off, exactly', () => {
    // C–C: 0.76 + 0.76 + 0.45 = 1.97 Å. Just inside bonds; just outside does not.
    const at = (d: number): Atom[] => [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: d, y: 0, z: 0 },
    ];
    const cutoff = 0.76 + 0.76 + BOND_TOLERANCE_A;
    expect(perceiveBonds(at(cutoff - 1e-6))).toEqual([[0, 1]]);
    expect(perceiveBonds(at(cutoff + 1e-6))).toEqual([]);
  });

  it('never bonds two atoms on one spot, which is an input error rather than a bond', () => {
    const atoms: Atom[] = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 0.1, y: 0, z: 0 },
    ];
    expect(perceiveBonds(atoms)).toEqual([]);
  });

  it('finds the same bonds as every-pair comparison, whatever order the atoms come in', () => {
    // The x-sorted sweep is an optimisation; it must not lose a pair the brute force finds.
    const atoms: Atom[] = Array.from({ length: 60 }, (_, i) => ({
      element: i % 3 === 0 ? 'C' : i % 3 === 1 ? 'H' : 'O',
      x: Math.sin(i * 1.7) * 4,
      y: Math.cos(i * 0.9) * 4,
      z: ((i * 7) % 11) * 0.4 - 2,
    }));
    const brute: [number, number][] = [];
    const r: Record<string, number> = { C: 0.76, H: 0.31, O: 0.66 };
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        const a = atoms[i]!;
        const b = atoms[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d <= r[a.element]! + r[b.element]! + BOND_TOLERANCE_A && d >= 0.4) brute.push([i, j]);
      }
    }
    expect(perceiveBonds(atoms)).toEqual(brute);
    expect(perceiveBonds([...atoms].reverse()).length).toBe(brute.length);
  });
});

describe('the rotation', () => {
  it('composes rotation matrices that stay orthonormal', () => {
    const m = multiply(rotationX(0.7), multiply(rotationY(-1.3), rotationX(2.1)));
    // Mᵀ·M = I.
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        const dot = m[r]! * m[c]! + m[3 + r]! * m[3 + c]! + m[6 + r]! * m[6 + c]!;
        close(dot, r === c ? 1 : 0);
      }
    }
  });

  it('turns the front to the right on a positive horizontal drag, and the top towards you on a vertical one', () => {
    // A point in front of the centre (towards the viewer, +z) moves right (+x) when turned about y.
    const [x] = apply(rotationY(Math.PI / 2), [0, 0, 1]);
    close(x, 1);
    // A point at the top (+y) comes towards the viewer (+z) when tipped about x.
    const [, , z] = apply(rotationX(Math.PI / 2), [0, 1, 0]);
    close(z, 1);
  });

  it('turns about the SCREEN axis however the view was turned before (trackball, not gimbal)', () => {
    // After a quarter turn about x, a horizontal drag must still swing the on-screen front point
    // to the right — the post-multiplied form turns it about the molecule's own (now tipped) axis.
    const tipped = turn(IDENTITY, 0, Math.PI / 2);
    const swung = turn(tipped, Math.PI / 2, 0);
    // The atom that is in front of the viewer after the tip…
    const front: [number, number, number] = [0, 1, 0];
    const [, , zBefore] = apply(tipped, front);
    close(zBefore, 1);
    // …is on the right after the horizontal drag.
    const [xAfter] = apply(swung, front);
    close(xAfter, 1);
  });
});

describe('the projection', () => {
  const atoms = parseXyz(ETHANE).atoms;

  it('centres the structure on its centroid and fits it inside the frame margin', () => {
    const p = project(atoms, { rotation: IDENTITY, zoom: 1 }, 400, 300);
    const meanX = p.reduce((s, a) => s + a.sx, 0) / p.length;
    const meanY = p.reduce((s, a) => s + a.sy, 0) / p.length;
    close(meanX, 200, 6);
    close(meanY, 150, 6);
    for (const a of p) {
      expect(a.sx - a.radius).toBeGreaterThanOrEqual(0);
      expect(a.sx + a.radius).toBeLessThanOrEqual(400);
      expect(a.sy - a.radius).toBeGreaterThanOrEqual(0);
      expect(a.sy + a.radius).toBeLessThanOrEqual(300);
    }
  });

  it('is orthographic: a bond keeps its drawn length whichever way it faces the viewer', () => {
    // Turned so the C–C axis lies in the screen plane, its drawn length is the bond times the scale
    // and does not depend on depth — the property perspective would break.
    const flat = project(atoms, { rotation: rotationX(Math.PI / 2), zoom: 1 }, 400, 300);
    const turned = project(
      atoms,
      { rotation: multiply(rotationY(1), rotationX(Math.PI / 2)), zoom: 1 },
      400,
      300,
    );
    const len = (p: typeof flat): number => Math.hypot(p[0]!.sx - p[1]!.sx, p[0]!.sy - p[1]!.sy);
    close(len(flat), len(turned), 6);
  });

  it('never rescales as it turns, so a rotation cannot read as the molecule changing size', () => {
    const a = project(atoms, { rotation: IDENTITY, zoom: 1 }, 400, 300);
    const b = project(atoms, { rotation: turn(IDENTITY, 0.8, -1.9), zoom: 1 }, 400, 300);
    close(a[0]!.radius, b[0]!.radius);
  });

  it('scales with zoom about the centre', () => {
    const one = project(atoms, { rotation: IDENTITY, zoom: 1 }, 400, 300);
    const two = project(atoms, { rotation: IDENTITY, zoom: 2 }, 400, 300);
    close(two[0]!.sx - 200, 2 * (one[0]!.sx - 200), 6);
    close(two[0]!.radius, 2 * one[0]!.radius, 6);
  });

  it('puts screen y up the page, as chemistry draws it', () => {
    const p = project(
      [
        { element: 'C', x: 0, y: 1, z: 0 },
        { element: 'C', x: 0, y: -1, z: 0 },
      ],
      { rotation: IDENTITY, zoom: 1 },
      400,
      300,
    );
    expect(p[0]!.sy).toBeLessThan(p[1]!.sy);
  });

  it('runs nearness from 0 at the back to 1 at the front, which the depth cue fades by', () => {
    const p = project(atoms, { rotation: rotationX(Math.PI / 2), zoom: 1 }, 400, 300);
    const near = p.map((a) => a.nearness);
    expect(Math.min(...near)).toBe(0);
    expect(Math.max(...near)).toBe(1);
    expect(depthOpacity(0)).toBeCloseTo(0.35);
    expect(depthOpacity(1)).toBe(1);
  });

  it('draws a hydrogen smaller than a carbon, and both well under half a C–H bond', () => {
    expect(ballRadius('H')).toBeLessThan(ballRadius('C'));
    expect(ballRadius('H') + ballRadius('C')).toBeLessThan(1.09);
  });
});

describe('the painter', () => {
  it('draws every mark furthest first', () => {
    const atoms = parseXyz(ETHANE).atoms;
    const projected = project(atoms, { rotation: turn(IDENTITY, 0.4, 0.9), zoom: 1 }, 400, 300);
    const marks = paint(projected, perceiveBonds(atoms));
    const depths = marks.map((m) => m.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(marks.filter((m) => m.kind === 'atom')).toHaveLength(8);
    // Seen side-on (the C–C axis in the screen plane), every bond shows: seven bonds, two halves.
    const sideOn = paint(
      project(atoms, { rotation: rotationX(Math.PI / 2), zoom: 1 }, 400, 300),
      perceiveBonds(atoms),
    );
    expect(sideOn.filter((m) => m.kind === 'bond')).toHaveLength(14);
  });

  it('starts each half-bond at its ball’s surface, never at the centre', () => {
    const atoms = parseXyz(WATER).atoms;
    const projected = project(atoms, { rotation: IDENTITY, zoom: 1 }, 400, 300);
    for (const mark of paint(projected, perceiveBonds(atoms))) {
      if (mark.kind !== 'bond') continue;
      const fromCentre = Math.hypot(mark.x1 - mark.from.sx, mark.y1 - mark.from.sy);
      expect(fromCentre).toBeGreaterThan(0.5 * mark.from.radius);
    }
  });

  it('skips a bond seen end-on, which its two balls hide anyway', () => {
    // C–C along the viewing axis: projected length zero.
    const atoms: Atom[] = [
      { element: 'C', x: 0, y: 0, z: 0.77 },
      { element: 'C', x: 0, y: 0, z: -0.77 },
    ];
    const projected = project(atoms, { rotation: IDENTITY, zoom: 1 }, 400, 300);
    expect(paint(projected, [[0, 1]]).filter((m) => m.kind === 'bond')).toEqual([]);
  });
});

describe('formula', () => {
  it('writes Hill order: carbon, hydrogen, then the rest alphabetically', () => {
    expect(formula(parseXyz(ETHANE).atoms)).toBe('C2H6');
    expect(formula(parseXyz(WATER).atoms)).toBe('H2O');
    expect(
      formula([
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'Cl', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0, y: 0, z: 0 },
      ]),
    ).toBe('CHClO');
  });
});
