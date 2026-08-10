/**
 * Citations, end to end: the remark plugin's link and the component that consumes it.
 *
 * These two halves are written in different files and were never tested together, which is how
 * they came to disagree about the shape of the href. `remarkCitations` emits `#cite/<kind>/<id>`;
 * the consumer in `Markdown.tsx` read it one element off, so `kind` received the id and `id` was
 * always the empty string. Every citation in every answer rendered as an empty, unlabelled button
 * and the id vanished from the text — with nothing to catch it, because neither file had a test.
 *
 * The assertion that matters is therefore the round trip, not either side on its own: the id the
 * plugin found in the answer must be the id the chip is labelled with.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';

afterEach(cleanup);

describe('citation chips', () => {
  it('labels the chip with the id, not the kind', () => {
    render(<Markdown>See note-123 for the workup.</Markdown>);
    const chip = screen.getByRole('button', { name: /note-123/ });
    expect(chip.textContent).toBe('note-123');
  });

  it('keeps the id visible in the answer text', () => {
    const { container } = render(<Markdown>See note-123 for the workup.</Markdown>);
    expect(container.textContent).toContain('note-123');
  });

  it('gives every citation an accessible name', () => {
    render(<Markdown>Compare note-1 with reaction-2.</Markdown>);
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent?.trim()).not.toBe('');
    }
  });

  it('distinguishes a reaction from a note, so the palette applies', () => {
    // `kind` drives PALETTE in CitationChip. When it received the id instead, every citation fell
    // through to the note styling regardless of what it actually was.
    render(<Markdown>Compare note-1 with reaction-2.</Markdown>);
    const note = screen.getByRole('button', { name: /note-1/ });
    const reaction = screen.getByRole('button', { name: /reaction-2/ });
    expect(note.className).not.toBe(reaction.className);
  });
});
