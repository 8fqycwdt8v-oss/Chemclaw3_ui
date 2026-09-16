/**
 * Who the "watching fewer conversations" notice is for, and which flag draws it.
 *
 * A follower holds no job streams, so it can never 429 and can never learn for itself that the
 * account is over the service's per-principal cap. The leader tells it, over the same health note
 * that carries the failing-stream list — and until now that report was *adopted* as the reader's
 * own `jobStreamsThrottled`, a flag that is deliberately irreversible and that cuts the stream
 * budget to one. One window's two 429s therefore pinned every page on the account to a single
 * stream for the life of each page, the next leader after a takeover included.
 *
 * The report and the decision are two fields now, and this file pins the half that is only ever
 * visible: the notice a chemist reads. Nothing else in the suite renders it — driven by deleting
 * the relayed half of the selector, the whole 1,132-test suite stayed green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SidebarBody } from '../src/components/Sidebar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const NOTICE = /Watching fewer conversations/;
let restore: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  const original = globalThis.fetch;
  // The sessions listing this panel reads on mount, and nothing else.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    jobFeed: [],
    jobStreamsFailing: [],
    jobStreamsThrottled: false,
    jobStreamsThrottledElsewhere: false,
    awaiting: [],
  });
});

afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

const draw = (): void => {
  render(
    <MemoryRouter>
      <SidebarBody />
    </MemoryRouter>,
  );
};

describe('the stream-throttle notice', () => {
  it('is absent when nobody is over the cap', () => {
    draw();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('is drawn for a tab that 429d twice itself', () => {
    useChatStore.setState({ jobStreamsThrottled: true });
    draw();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('is drawn for a follower the leader told, which is the only way a follower can know', () => {
    // The whole reason the health note carries the throttle at all: this tab holds no streams, so
    // without the relay it would show a chemist an app that looks fine while the account is
    // watching one conversation instead of three.
    useChatStore.setState({ jobStreamsThrottledElsewhere: true });
    draw();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('goes away again when the leader stops reporting it', () => {
    // The difference between a report and a decision, at the surface a chemist reads. This tab's
    // own flag never clears — it is evidence about this tab — but a relayed one follows its
    // reporter, and a takeover publishes the new leader's own health at once.
    useChatStore.setState({ jobStreamsThrottledElsewhere: true });
    draw();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    cleanup();

    useChatStore.setState({ jobStreamsThrottledElsewhere: false });
    draw();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
