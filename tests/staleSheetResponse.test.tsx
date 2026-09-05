/**
 * A panel shows the thing it names.
 *
 * `NoteSheet`, `JobsPanel`'s job sheet and `ReviewQueue`'s proposal sheet all fetch during render,
 * guarded by a `loadedFor !== id` latch. The latch stops a refetch loop; it does nothing about the
 * *previous* request, which is still in flight and still holds a `setState` that will land. So two
 * reads of one panel resolve in whatever order the network gives them, and the last one to answer
 * wins the body while the id in the heading — and every action button — is the newest one.
 *
 * **The three are not equally exposed, and the first draft of this file said they were.** What
 * decides it is how the parent mounts the panel, not the panel's own code:
 *
 *  - `NoteSheet` is re-targeted **in place** — `CitationChip` keeps it mounted and `onFollow`
 *    swaps `noteId`, because walking to a neighbour is the designed way to read the graph. So the
 *    race is reached by ordinary use, and it lands on a **provenance** surface: a source, an
 *    author and a validity window under the wrong note id is worse than no answer, because it
 *    reads as an answer. That is the first test below, and it fails without the guard.
 *  - `JobsPanel` and `ReviewQueue` render their sheet as `{openId !== null && …}`, so closing it
 *    unmounts the state a stale response would land in, and the id cannot change while mounted.
 *    **Neither can reach the race through its UI today**, and the two attempts at a test that
 *    said otherwise are why this paragraph is here: re-targeting needs a close, which unmounts,
 *    and the "Try again" double click needs a button that `load`'s own `setFailed(false)` removes
 *    on the first one. Both attempts passed against the unguarded code, which is a test proving
 *    nothing rather than a bug proving itself.
 *
 * The guard is in all three anyway, and that is a judgement rather than a measurement: it makes a
 * panel's correctness local, where today it rests on a conditional render in the parent. What the
 * second test below pins is the primitive itself — including the same-id case an id comparison
 * would get wrong — rather than a defect those two panels do not currently have.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { NoteSheet } from '../src/components/NoteSheet.tsx';
import { useNewestRead } from '../src/hooks/useNewestRead.ts';
import { stubFetch } from './helpers.ts';
import type { NoteRef, NoteView } from '../src/api/client.ts';

// The context value is built once, not per call: `JobsPanel`'s list effect has `auth` in its
// deps, so a mock that returns a fresh object every render spins that effect for ever.
vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return {
    useAuth: () => value,
    // Dev auth opens every gate, which is what puts the cancellation control on screen at all.
    useIsReviewer: () => true,
  };
});

const noteRef = (id: string, over: Partial<NoteRef> = {}): NoteRef => ({
  id,
  type: 'reaction',
  compound_smiles: '',
  tags: [],
  created_by: 'agent',
  source: 'eln-ord',
  confidence: 0.8,
  valid_from: null,
  valid_to: null,
  ...over,
});

const view = (id: string, body: string, over: Partial<NoteRef> = {}): NoteView => ({
  note: noteRef(id, over),
  body,
  neighbors: [],
});

/** A fetch stub whose responses are released by hand, so the order is the test's to choose. */
function deferredFetch(bodies: Record<string, NoteView>) {
  const release: Record<string, () => void> = {};
  const stub = stubFetch((url) => {
    const id = decodeURIComponent(url.split('?')[0]!.split('/').pop() ?? '');
    return new Promise<Response>((resolve) => {
      release[id] = () =>
        resolve(
          new Response(JSON.stringify(bodies[id]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
    });
  });
  return { ...stub, release };
}

/**
 * Let every already-resolvable microtask land, without letting time pass.
 *
 * A read here crosses three awaits before it touches state — the token, `fetch`, then `.json()` —
 * so a couple of turns is not enough, and a timer-based wait would let the deferred responses this
 * test is holding resolve out from under it.
 */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

let restore: (() => void) | null = null;

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a sheet re-targeted while its first read is in flight', () => {
  it('does not render the first note’s provenance under the second note’s id', async () => {
    const { release, restore: undo } = deferredFetch({
      'note-slow': view('note-slow', 'The slow note, from a superseded batch.', {
        source: 'a-stale-source',
      }),
      'note-fast': view('note-fast', 'The note the reader actually opened.', {
        source: 'the-right-source',
      }),
    });
    restore = undo;

    const { rerender } = render(
      <NoteSheet
        noteId="note-slow"
        open
        onOpenChange={() => {}}
        onFollow={() => {}}
        onAsk={() => {}}
      />,
    );

    // The request is issued behind an `await` on the token, so let it reach the stub.
    await settle();

    // The reader follows a neighbour before the first read comes back.
    rerender(
      <NoteSheet
        noteId="note-fast"
        open
        onOpenChange={() => {}}
        onFollow={() => {}}
        onAsk={() => {}}
      />,
    );

    await settle();

    // The second read answers first; then the abandoned first one arrives.
    release['note-fast']!();
    await settle();
    release['note-slow']!();
    await settle();

    expect(screen.getByText('note-fast')).toBeTruthy();
    expect(screen.queryByText('The slow note, from a superseded batch.')).toBeNull();
    expect(screen.queryByText('a-stale-source')).toBeNull();
    expect(screen.getByText('The note the reader actually opened.')).toBeTruthy();
  });

  it('hands only the newest read the right to write', () => {
    // The primitive the other two panels' guards rest on, pinned directly, because neither of
    // those panels can currently reach the race through its UI — see the note above. The
    // same-sequence case is the one an id comparison would get wrong.
    const { result } = renderHook(() => useNewestRead());

    const first = result.current();
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);

    const third = result.current();
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });
});
