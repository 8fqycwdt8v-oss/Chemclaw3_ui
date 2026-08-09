/**
 * Answer rendering, where the input is model output.
 *
 * The XSS posture here was already sound — `rehype-raw` is deliberately not installed, so raw HTML
 * never renders, and the CSP is `script-src 'self'` with no `unsafe-inline`. What was missing was
 * anything *asserting* it. URL-scheme safety was delegated entirely to a react-markdown default
 * this repo neither pinned nor configured, and no test rendered a `javascript:` link. A comment
 * asking future contributors not to add `rehype-raw` is a convention; this file is the check.
 */

import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Markdown, safeUrl } from '../src/components/Markdown.tsx';
import { looksLikeSmiles } from '../src/lib/citations.ts';

afterEach(cleanup);

describe('safeUrl', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('strips %s', (url) => {
    expect(safeUrl(url)).toBeUndefined();
  });

  // The bypass corpus. A previous version of this function matched the scheme with a contiguous
  // regex, so every one of these was returned untouched — and the URL parser strips ASCII tab, LF
  // and CR before reading the scheme, so all of them ARE `javascript:` by the time a browser sees
  // them. CommonMark decodes `&#9;` inside a link destination, so they are reachable from model
  // output. The react-markdown default this replaced blocked them; the replacement did not.
  it.each([
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'javascript\t:alert(1)',
    '\tjavascript:alert(1)',
    'ja\tva\nscr\ript:alert(1)',
  ])('strips %j, which the URL parser would reassemble', (url) => {
    expect(safeUrl(url)).toBeUndefined();
  });

  it.each([
    'https://example.com/paper',
    'http://example.com',
    'mailto:chemist@example.com',
    'tel:+441234567890',
    '/local/route',
    '#cite/note/abc',
    'relative/path',
    './sibling',
    // A colon after a slash is part of a path, not a scheme.
    '/a/b:c',
  ])('keeps %s', (url) => {
    expect(safeUrl(url)).toBe(url);
  });
});

describe('Markdown', () => {
  it('does not render raw HTML from model output', () => {
    render(<Markdown>{'<img src=x onerror="alert(1)"> and <b>bold</b>'}</Markdown>);
    expect(document.querySelector('img')).toBeNull();
    // Without rehype-raw the tags are text, not elements.
    expect(document.querySelector('b')).toBeNull();
  });

  it('drops a javascript: href rather than rendering it', () => {
    render(<Markdown>{'[click me](javascript:alert(1))'}</Markdown>);
    const link = document.querySelector('a');
    // The attribute is absent, not empty. `href=""` would navigate to the current page, which is
    // not what "blocked" should mean — so this asserts absence rather than a non-matching value.
    expect(link?.hasAttribute('href')).toBe(false);
  });

  it('drops an entity-encoded tab-separated javascript: href', () => {
    // `&#9;` decodes to a TAB inside the link destination, which the URL parser then removes.
    render(<Markdown>{'[x](java&#9;script:alert&#40;1&#41;)'}</Markdown>);
    const link = document.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);
  });

  it('opens external links without leaking the referrer or the opener', () => {
    render(<Markdown>{'[paper](https://example.com/x)'}</Markdown>);
    const link = document.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  it('still renders ordinary markdown', () => {
    render(<Markdown>{'The **pKa** is 4.76.'}</Markdown>);
    expect(screen.getByText('pKa')).toBeTruthy();
  });
});

describe('looksLikeSmiles', () => {
  it.each(['pH=7.4', '1H-NMR', '13C-NMR', 'T=298', 'ppm', '4.76', 'HPLC'])(
    'rejects the prose token %s',
    (token) => {
      // Its own docstring always claimed to reject these; several of them passed.
      expect(looksLikeSmiles(token)).toBe(false);
    },
  );

  it.each([
    'c1ccccc1',
    'CC(=O)O',
    'C1=CC=CC=C1',
    'CC(C)(C)OC(=O)N',
    'CN1C=NC2=C1C(=O)N(C)C(=O)N2C',
  ])('accepts the structure %s', (smiles) => {
    expect(looksLikeSmiles(smiles)).toBe(true);
  });

  it('stays conservative about plain chains, which it cannot tell from an abbreviation', () => {
    // Both are valid SMILES and neither is offered a render affordance. `CCO` (ethanol) is under
    // the four-character floor; `CCOC` (diethyl ether) carries no ring, branch or bond character,
    // which is the signal the heuristic uses to separate a structure from a word. The stated
    // preference is to offer nothing rather than a toggle that errors when clicked — these are
    // the cost of that, and they are false negatives rather than false positives.
    expect(looksLikeSmiles('CCO')).toBe(false);
    expect(looksLikeSmiles('CCOC')).toBe(false);
  });

  it('refuses a string long enough to stall a synchronous parse', () => {
    expect(looksLikeSmiles('C'.repeat(500))).toBe(false);
  });
});
