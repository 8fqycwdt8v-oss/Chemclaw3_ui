/**
 * Telling a chemist that the problem is their own Wi-Fi.
 *
 * `navigator.onLine` and the `online`/`offline` events appeared nowhere in `src/`. The backoff in
 * `useJobStreams` and the detach-recovery in the turn path both handle *a request that failed*,
 * and neither can say why — so on a shared bench tablet behind a flaky AP, the most common
 * failure in the product read as a service outage.
 *
 * What is asserted here is as much about restraint as about the marker. `navigator.onLine` is a
 * link-layer signal: false is trustworthy, true means only that an interface exists — a captive
 * portal, a network with no route out and a dead backend all read as online. So the header must
 * render the offline state and NEVER an "online" one, or it would be publishing a reachability
 * claim the browser has not made. The service-health probe stays the only thing that answers
 * reachability, and it goes on saying "unreachable" beside this, which is true from here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TopBar } from '../src/components/TopBar.tsx';
import { useOffline } from '../src/hooks/useOffline.ts';
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

/** Move the link-layer signal and fire the event the browser fires with it. */
const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
};

const renderBar = () =>
  render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>,
  );

/** Visible or screen-reader-only, but not the copy `StatusDot` hides from assistive tech. */
const announced = (text: string): HTMLElement[] =>
  screen.queryAllByText(text).filter((el) => el.closest('[aria-hidden="true"]') === null);

beforeEach(() => {
  cleanup();
  setOnline(true);
  const stub = stubFetch(() => new Response('{}', { status: 200 }));
  restore = stub.restore;
  useChatStore.setState({ banner: null, activeId: null, conversations: {}, order: [] });
});

afterEach(() => {
  cleanup();
  setOnline(true);
  restore?.();
  restore = null;
});

describe('useOffline', () => {
  it('reports the link-layer state and follows it as it changes', () => {
    const { result } = renderHook(() => useOffline());
    expect(result.current).toBe(false);

    setOnline(false);
    expect(result.current).toBe(true);

    setOnline(true);
    expect(result.current).toBe(false);
  });
});

describe('the header while the device is offline', () => {
  it('says so, beside the service indicator rather than instead of it', async () => {
    renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    // Nothing at all while the link is up: an "online" marker would be claiming reachability
    // that `navigator.onLine` cannot see.
    expect(announced('offline')).toHaveLength(0);

    setOnline(false);

    // Once — `StatusDot` owns the accessible copy, the header's sibling span is the visible one.
    expect(announced('offline')).toHaveLength(1);
    // And the service indicator is untouched: two facts, two dots.
    expect(announced('connected')).toHaveLength(1);
  });

  it('clears the marker when the link comes back', () => {
    renderBar();
    setOnline(false);
    expect(announced('offline')).toHaveLength(1);

    setOnline(true);
    expect(announced('offline')).toHaveLength(0);
  });
});
