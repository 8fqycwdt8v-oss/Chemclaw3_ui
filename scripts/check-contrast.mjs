/**
 * Contrast gate for the design tokens.
 *
 * Reads the raw palette straight out of `src/index.css` — both themes — converts OKLCH to sRGB and
 * asserts WCAG 2.2 contrast on the pairs the UI actually puts together.
 *
 * Why not just eyeball the lightness numbers: OKLCH's L is *perceptual*, and WCAG is defined on
 * sRGB relative luminance. Two tokens 50 points apart in OKLCH L can land either side of 4.5:1
 * depending on hue and chroma. The whole `text-white` bug this replaces looked fine as a lightness
 * pair and was about 2:1 in practice.
 *
 *   node scripts/check-contrast.mjs
 */

import { readFile } from 'node:fs/promises';

const CSS = new URL('../src/index.css', import.meta.url);

/* ── OKLCH -> sRGB -> WCAG relative luminance ─────────────────────────────── */

const cube = (x) => x * x * x;

function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = cube(L + 0.3963377774 * a + 0.2158037573 * b);
  const m = cube(L - 0.1055613458 * a - 0.0638541728 * b);
  const s = cube(L - 0.0894841775 * a - 1.291485548 * b);

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))); // clamp out-of-gamut rather than throwing
}

/** WCAG relative luminance is defined on gamma-decoded channels, i.e. linear sRGB. */
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── Parse the palette ────────────────────────────────────────────────────── */

const OKLCH = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/;

function parseBlock(css, selector) {
  // Non-greedy to the first closing brace: these blocks contain only declarations.
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`could not find "${selector}" in src/index.css`);
  const tokens = {};
  for (const line of block[1].split('\n')) {
    const decl = line.match(/^\s*--([\w-]+)\s*:\s*(.+?);/);
    if (!decl) continue;
    const colour = decl[2].match(OKLCH);
    if (!colour) continue;
    tokens[decl[1]] = oklchToLinearRgb(
      Number(colour[1]) / 100,
      Number(colour[2]),
      Number(colour[3]),
    );
  }
  return tokens;
}

/* ── The pairs that actually occur ────────────────────────────────────────── */

const AA_TEXT = 4.5;
const AA_LARGE = 3; // >=18.66px or bold >=14px
const AA_UI = 3; // component boundaries and focus indicators (SC 1.4.11)

const PAIRS = [
  // Body and secondary text on each surface.
  ['ink', 'surface', AA_TEXT, 'body text'],
  ['ink', 'surface-raised', AA_TEXT, 'body text on a card'],
  ['ink', 'surface-sunken', AA_TEXT, 'body text on a sunken panel'],
  ['ink-muted', 'surface', AA_TEXT, 'muted text'],
  ['ink-muted', 'surface-raised', AA_TEXT, 'muted text on a card'],
  ['ink-muted', 'surface-sunken', AA_TEXT, 'muted text on a sunken panel'],
  // ink-subtle is only ever used at >=14px semibold or as a decorative rail.
  ['ink-subtle', 'surface-raised', AA_LARGE, 'subtle text'],

  // Filled controls: this is where `text-white` used to sit at ~2:1 in dark mode.
  ['brand-fg', 'brand', AA_TEXT, 'label on a primary button / user bubble'],
  ['ok-fg', 'ok', AA_TEXT, 'label on a success button'],
  ['warn-fg', 'warn', AA_TEXT, 'label on a warning fill'],
  ['danger-fg', 'danger', AA_TEXT, 'label on a destructive button'],

  // Text on soft grounds — notices, pills, inline errors.
  ['brand-ink', 'brand-soft', AA_TEXT, 'text on a brand notice'],
  ['ok-ink', 'ok-soft', AA_TEXT, 'text on a success pill'],
  ['warn-ink', 'warn-soft', AA_TEXT, 'text on a warning notice'],
  ['danger-ink', 'danger-soft', AA_TEXT, 'text on a danger notice'],

  // Non-text contrast.
  ['ring', 'surface', AA_UI, 'focus ring on the page'],
  ['ring', 'surface-raised', AA_UI, 'focus ring on a card'],
  ['ring', 'surface-sunken', AA_UI, 'focus ring on a sunken panel'],
  // The switch's unchecked track is the only thing identifying that control, so it is a boundary
  // under SC 1.4.11. `line-strong` deliberately is NOT in this list: it is a divider and a hover
  // border on controls that are already identified by their label and resting border, and pushing
  // it to 3:1 would make every separator in the app read as a rule.
  ['ink-subtle', 'surface', AA_UI, 'switch track (unchecked)'],
  ['brand', 'surface-raised', AA_UI, 'brand fill against a card'],
  ['danger', 'surface-raised', AA_UI, 'destructive fill against a card'],
];

/* ── Run ──────────────────────────────────────────────────────────────────── */

const css = await readFile(CSS, 'utf8');
const themes = {
  light: parseBlock(css, ':root'),
  dark: parseBlock(css, ":root\\[data-theme='dark'\\]"),
};

let failures = 0;
let checked = 0;

for (const [theme, tokens] of Object.entries(themes)) {
  console.log(`\n  ${theme}`);
  for (const [fg, bg, min, what] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      console.error(`    ✗ ${fg} on ${bg} — token missing from the ${theme} palette`);
      failures += 1;
      continue;
    }
    checked += 1;
    const ratio = contrast(tokens[fg], tokens[bg]);
    const ok = ratio >= min;
    if (!ok) failures += 1;
    const line = `${ratio.toFixed(2)}:1 (needs ${min})`.padEnd(22);
    console.log(`    ${ok ? '✓' : '✗'} ${line} ${what} — ${fg} on ${bg}`);
  }
}

console.log(
  `\n  ${checked - failures}/${checked} pairs pass across both themes.${failures ? '' : ' ✓'}\n`,
);

if (failures > 0) {
  console.error(`  ${failures} contrast failure${failures === 1 ? '' : 's'}.\n`);
  process.exit(1);
}
