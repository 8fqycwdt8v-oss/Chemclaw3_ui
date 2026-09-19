/**
 * What the answer renderer puts in the DOM beyond the answer.
 *
 * react-markdown hands every custom component the mdast `node` it came from, and React 19 renders
 * an unknown lowercase prop as an attribute — so a component that spreads the rest of its props
 * onto the element writes `node="[object Object]"` into the document. Four of them did: every
 * heading, every link, every image and every inline code span in every answer this app has
 * rendered, which is also every citation chip's neighbour and every structure span's.
 *
 * Harmless to look at and not harmless to have: it is the serialisation of the whole subtree,
 * repeated per element, in the one surface a chemist copies out of — and a copied answer carrying
 * `node="[object Object]"` is the kind of thing that gets read as the app being broken.
 *
 * Asserted over the rendered HTML rather than per component, because the defect is a *pattern* —
 * one more `{...props}` on a fifth component would be the same bug with nothing new to learn.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';

/** Every element whose component spreads props: a heading, a link, a code span and an image. */
const ANSWER = [
  '# Solvent screen',
  '',
  // A code span that is NOT a structure: an inline SMILES is routed to `InlineSmiles` instead and
  // never reaches the `code` component, so a fixture with only one of those tests the wrong thing.
  'See [the ELN record](https://eln.example.test/r/41) — run at `GFN2-xTB`, held at 40 °C.',
  '',
  '![the plate](/plate.png)',
  '',
].join('\n');

describe('a rendered answer', () => {
  it('carries no mdast node in its markup', () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    // Guard the guard: an answer that rendered nothing would pass the assertion below saying
    // nothing at all. Each of these is one of the four components that spreads its props.
    expect(container.querySelector('h3.md-h1')).toBeTruthy();
    expect(container.querySelector('a[href^="https://eln.example.test"]')).toBeTruthy();
    expect(container.querySelector('code')).toBeTruthy();
    expect(container.querySelector('img[src="/plate.png"]')).toBeTruthy();

    expect(container.innerHTML).not.toContain('node=');
    expect(container.innerHTML).not.toContain('[object Object]');
  });
});
