/**
 * Contrast gate for the design tokens.
 *
 * Reads the raw palette straight out of `src/index.css` — both themes — maps each token into sRGB
 * and asserts WCAG 2.2 contrast on the pairs the UI actually puts together. The colour science is
 * `culori`'s; the gamut decision, the pair list and the thresholds are this file's, and the block
 * below says why each of those three is not delegated.
 *
 * Why not just eyeball the lightness numbers: OKLCH's L is *perceptual*, and WCAG is defined on
 * sRGB relative luminance. Two tokens 50 points apart in OKLCH L can land either side of 4.5:1
 * depending on hue and chroma. The whole `text-white` bug this replaces looked fine as a lightness
 * pair and was about 2:1 in practice.
 *
 *   node scripts/check-contrast.mjs
 */

import { readFile } from 'node:fs/promises';
import { clampGamut, parse, toGamut, wcagContrast } from 'culori';

const CSS = new URL('../src/index.css', import.meta.url);

/* ── OKLCH -> sRGB -> WCAG contrast ───────────────────────────────────────── */

/**
 * `culori` owns the colour science. This file used to carry the OKLab→LMS→linear-sRGB matrix as
 * fifteen hand-transcribed constants, the relative-luminance weights, the `(hi+.05)/(lo+.05)`
 * formula and an `oklch(...)` regex — four independently transcribable things, none of which this
 * repository has any business owning, and every one of which is wrong silently if a digit moves.
 *
 * What is NOT delegated is the gamut question, because it changes the answer and the three
 * available treatments disagree. Ten of this palette's twenty-three tokens are outside sRGB —
 * dark `--danger-ink: oklch(86% 0.11 22)` asks for a linear red of 1.175 — so "what is its
 * luminance" has no answer until you say which colour actually reaches the screen. Measured over
 * all 46 pairs, against the previous implementation:
 *
 *   • naive clip of LINEAR rgb to [0,1] — what this file used to do — 0/46 pairs move (max |Δ|
 *     under 5e-5, i.e. it is `culori`'s `clampGamut('rgb')` exactly: clipping before and after a
 *     monotonic transfer curve that fixes 0 and 1 is the same clip).
 *   • no gamut step at all, i.e. `wcagContrast` on the parsed colour — 8/46 pairs move, up to
 *     +0.53. This is the tempting one-liner and it is the wrong number: it reports the contrast of
 *     a colour no display can show.
 *   • CSS Color 4 gamut mapping, `toGamut('rgb', 'oklch')` — 2/46 pairs move, by at most +0.22
 *     (dark `danger-ink` on `danger-soft`, 8.83 → 9.05). Nothing crosses a threshold.
 *
 * Neither the first nor the third is "what the screen shows" on its own. CSS Color 4 *recommends*
 * the gamut mapping, and this file used to claim it was what the browser does; shipping browsers
 * clip per channel on sRGB output. Nor is either consistently the worse: measured, they differ on
 * two dark-theme pairs and in opposite directions — the mapping reads `danger-ink` on
 * `danger-soft` at 9.05 against the clip's 8.83, and `brand-ink` on `brand-soft` at 8.80 against
 * 8.82. Taking the mapping alone, a token tuned just over 4.5:1 could sit below it on the clipped
 * colour a real sRGB display shows — optimistic in the direction a gate must never be.
 *
 * So a pair is measured under both and held to the worse. That is a claim that survives either
 * rendering, and it costs one extra `wcagContrast` per pair.
 */

/** The two treatments a browser may apply to an out-of-gamut colour: clip, or CSS Color 4 map. */
const TREATMENTS = [clampGamut('rgb'), toGamut('rgb', 'oklch')];

/** The pair's contrast under whichever treatment is worse for it. */
function worstContrast(fg, bg) {
  return Math.min(...TREATMENTS.map((into) => wcagContrast(into(fg), into(bg))));
}

/* ── Parse the palette ────────────────────────────────────────────────────── */

/**
 * The CSS block extraction stays a regex deliberately. `postcss` is not a dependency here and
 * Tailwind v4 no longer guarantees it is in the tree, so adding it to read two flat declaration
 * lists would be a build-tool dependency bought for a `{...}` match. What the regex no longer does
 * is parse the *colour*: `parse()` accepts any CSS colour, so a token rewritten as a hex or an
 * `lab()` is now checked rather than silently dropped out of the palette.
 */
function parseBlock(css, selector) {
  // Non-greedy to the first closing brace: these blocks contain only declarations.
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`could not find "${selector}" in src/index.css`);
  const tokens = {};
  for (const line of block[1].split('\n')) {
    const decl = line.match(/^\s*--([\w-]+)\s*:\s*(.+?);/);
    if (!decl) continue;
    const colour = parse(decl[2].trim());
    if (!colour) continue; // not a colour — `--radius`, and anything else non-chromatic
    tokens[decl[1]] = colour;
  }
  return tokens;
}

/* ── The pairs that actually occur ────────────────────────────────────────── */

const AA_TEXT = 4.5;
// There is deliberately no AA_LARGE (3:1, for >=18.66px or bold >=14px). Nothing in this app sits
// on a colour pair that is only ever large text, and the one row that claimed to — ink-subtle —
// turned out to carry 11px metadata. A threshold that has to be argued for per usage is one that
// will be wrong the next time a component moves.
const AA_UI = 3; // component boundaries and focus indicators (SC 1.4.11)

const PAIRS = [
  // Body and secondary text on each surface.
  ['ink', 'surface', AA_TEXT, 'body text'],
  ['ink', 'surface-raised', AA_TEXT, 'body text on a card'],
  ['ink', 'surface-sunken', AA_TEXT, 'body text on a sunken panel'],
  ['ink-muted', 'surface', AA_TEXT, 'muted text'],
  ['ink-muted', 'surface-raised', AA_TEXT, 'muted text on a card'],
  ['ink-muted', 'surface-sunken', AA_TEXT, 'muted text on a sunken panel'],
  // ink-subtle was listed here once at AA_LARGE, on the claim that it was "only ever used at
  // >=14px semibold or as a decorative rail". That was not true of the code: it carries `text-2xs`
  // metadata in the trace panel, the job feed and both sidebar hints — 11px, which is squarely
  // small text. An axe run found three such nodes at 3.57:1. The claim is gone and the token is
  // now held to the threshold its actual usage requires, on every ground it appears on.
  ['ink-subtle', 'surface', AA_TEXT, 'small metadata text'],
  ['ink-subtle', 'surface-raised', AA_TEXT, 'small metadata text on a card'],
  ['ink-subtle', 'surface-sunken', AA_TEXT, 'small metadata text on a sunken panel'],

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
    const ratio = worstContrast(tokens[fg], tokens[bg]);
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
