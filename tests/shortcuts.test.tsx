/**
 * Keys that do not fire while a chemist is typing.
 *
 * There were two `onKeyDown` handlers in the whole app before this, both bound to the control they
 * act on, so every navigation was a pointer trip. The risk in fixing that is larger than the gap:
 * a global key handler in an app whose users type `N-Boc`, `2-MeTHF` and `k` as a rate constant is
 * one careless binding away from opening a new conversation mid-sentence.
 *
 * So the properties worth pinning are the refusals, not the actions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describeShortcut, useShortcuts, type Shortcut } from '../src/hooks/useShortcuts.ts';
import { ShortcutSheet } from '../src/components/ShortcutSheet.tsx';

const fired: string[] = [];

const shortcuts = (): Shortcut[] => [
  { key: 'k', mod: true, label: 'New conversation', run: () => fired.push('new') },
  { key: '/', mod: true, label: 'Search conversations', run: () => fired.push('search') },
  { key: '?', shift: true, label: 'Show this list', run: () => fired.push('help') },
];

beforeEach(() => {
  cleanup();
  fired.length = 0;
});
afterEach(cleanup);

describe('an app-level shortcut', () => {
  it('fires on its own combination', () => {
    renderHook(() => useShortcuts(shortcuts()));

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(fired).toEqual(['new']);
  });

  it('does not fire on the bare key', () => {
    // The whole hazard: `k` is a rate constant and a letter in half the compound names here.
    renderHook(() => useShortcuts(shortcuts()));

    fireEvent.keyDown(window, { key: 'k' });

    expect(fired).toEqual([]);
  });

  it('does not fire while the reader is in a text control', () => {
    // Belt and braces beside the modifier: a browser or an extension can swallow the modifier and
    // leave the bare key, and the composer is where that would be worst.
    renderHook(() => useShortcuts(shortcuts()));
    render(<textarea aria-label="composer" />);
    const composer = screen.getByLabelText('composer');

    fireEvent.keyDown(composer, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(composer, { key: '?', shiftKey: true });

    expect(fired).toEqual([]);
  });

  it('distinguishes bindings that differ only by a modifier', () => {
    renderHook(() => useShortcuts(shortcuts()));

    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    fireEvent.keyDown(window, { key: '?', shiftKey: true, ctrlKey: true });

    // The second names no binding — `?` is declared without the command modifier — and must do
    // nothing rather than fall through to the nearest match.
    expect(fired).toEqual(['help']);
  });

  it('stops listening when its owner unmounts', () => {
    const { unmount } = renderHook(() => useShortcuts(shortcuts()));
    unmount();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(fired).toEqual([]);
  });
});

describe('the list of shortcuts', () => {
  it('is rendered from the same array the handler runs', () => {
    // A hand-written help panel describes last month's keys. This one cannot.
    render(<ShortcutSheet shortcuts={shortcuts()} open onOpenChange={() => {}} />);

    expect(screen.getByText('New conversation')).toBeTruthy();
    expect(screen.getByText(describeShortcut(shortcuts()[0] as Shortcut))).toBeTruthy();
    expect(screen.getByText('Show this list')).toBeTruthy();
  });
});
