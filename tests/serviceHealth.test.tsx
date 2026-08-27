/**
 * The header's health indicator, against a backend that hangs rather than fails.
 *
 * "checking" is the one state that means *I do not know*, and it was reachable forever. The probe
 * awaited a bare `fetch` with no `AbortSignal` and no deadline, and `setHealth` is only ever
 * called from the resolution — so an upstream that accepts the TCP connection and never answers
 * left the dot saying "checking" for the life of the tab. That is precisely the case the indicator
 * exists to answer: a chemist whose message is hanging looks at the header to tell a slow turn
 * from a dead service, and gets the same word it has shown since the page loaded.
 *
 * The poll was also unconditional, so a new never-resolving request was issued every 30 s and none
 * of them was ever cancelled. `cancelled` guards state-after-unmount, not the requests.
 *
 * The third test is the same indicator read by a screen reader. `showLabel={false}` does not
 * remove `StatusDot`'s label — its own docstring says so, "the label is still rendered, just only
 * for assistive tech" — so the header's sibling span repeated it, and the tooltip's
 * `aria-describedby` added a third. One word, announced three times, on a control whose entire
 * content is that word.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TopBar } from '../src/components/TopBar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({
    auth: { getAccessToken: async () => null, mode: 'dev', account: null },
    ready: true,
    refresh: () => undefined,
  }),
  useIsReviewer: () => false,
}));

let restore: (() => void) | null = null;
/** Every `/healthz` request that was issued, and whether it was aborted. */
let probes: AbortSignal[] = [];

/** A backend that accepts the connection and never answers — the case the timeout is for. */
const serveHang = (): void => {
  const stub = stubFetch((url, init) => {
    if (!url.includes('/healthz')) return new Response('[]', { status: 200 });
    const signal = init?.signal ?? new AbortController().signal;
    probes.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  restore = stub.restore;
};

/** Let the probe's own timers run and its promises settle. */
const tick = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

const shows = (label: string): boolean => screen.queryAllByText(label).length > 0;

beforeEach(() => {
  cleanup();
  probes = [];
  vi.useFakeTimers();
  useChatStore.setState({ banner: null, activeId: null, conversations: {}, order: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restore?.();
  restore = null;
});

describe('the health poll against a hung backend', () => {
  it('calls the service unreachable rather than saying “checking” forever', async () => {
    serveHang();
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

    await tick(0);
    expect(shows('checking')).toBe(true);

    // Well past any deadline a probe could reasonably wait, and still short of the 30 s poll.
    await tick(10_000);

    expect(shows('unreachable')).toBe(true);
    expect(shows('checking')).toBe(false);
  });

  it('does not stack a second never-resolving probe on the next tick', async () => {
    serveHang();
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

    await tick(0);
    expect(probes).toHaveLength(1);

    // Advanced in two steps, because a promise settles on a microtask and `advanceTimersByTime`
    // runs the whole window synchronously: one jump would leave the abort unobserved and prove
    // nothing about what the poll does next.
    await tick(6_000);
    expect(probes[0]?.aborted).toBe(true);

    // The next poll tick, now that nothing is outstanding.
    await tick(25_000);

    expect(probes).toHaveLength(2);
    // What may not happen is two of them in flight at once, forever.
    expect(probes.filter((signal) => !signal.aborted)).toHaveLength(1);
  });
});

describe('the indicator as a screen reader hears it', () => {
  it('says the status once, not twice', async () => {
    // `StatusDot` owns the accessible copy; the header's own span is the visible one from `sm` up,
    // so it is hidden from assistive tech rather than deleted.
    const stub = stubFetch(() => new Response('{}', { status: 200 }));
    restore = stub.restore;
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

    await tick(0);

    const announced = screen
      .getAllByText('connected')
      .filter((el) => el.closest('[aria-hidden="true"]') === null);
    expect(announced).toHaveLength(1);
  });
});
