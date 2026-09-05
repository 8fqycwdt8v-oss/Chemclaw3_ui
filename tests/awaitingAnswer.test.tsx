/**
 * A question held open for a person reaches the person.
 *
 * `AwaitAnswerWorkflow` stops a durable job and asks somebody for a number — a yield, a decision
 * about a batch, a value off an instrument — and it has always pushed a row into the session's
 * mailbox on the open, on every reminder and again on expiry. **Nothing claimed it**: the backend's
 * `GET /sessions/{id}/events` named two kinds and this was a third, so every one of those
 * notifications was written, never delivered, and aged out (backend
 * `D-2026-09-05-a-push-nobody-claims-is-not-a-push`). What a chemist saw instead was the
 * `job_started` of `kind: 'awaiting'` recorded beside the wait: a durable run that appeared to
 * execute for a week and then vanish.
 *
 * The backend now claims the kind and this repository mirrors the event. That leaves three things
 * that can each independently make it reach nobody again, and each has a test here:
 *
 *  1. `normalizeEvent` rebuilds every event field by field, so an unmirrored field is DELETED in
 *     transit. (`eventContract.test.ts` covers the fields; this file covers the routing.)
 *  2. `useJobStreams` reads the stream and has to send this frame somewhere that is not the job
 *     feed — a question waiting on a person is not a run that finished.
 *  3. The badge has to come DOWN. A workflow pushes again on expiry, and a counter that only ever
 *     went up would advertise a question nobody can answer any more, which is the original defect
 *     wearing the opposite sign.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AuthProvider } from '../src/auth/types.ts';

const SID = 'a'.repeat(32);

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: AUTH, ready: true, revision: 0, refresh: () => {} }),
  useIsReviewer: () => true,
}));

const AUTH: AuthProvider = {
  mode: 'dev',
  account: null,
  async getAccessToken() {
    return 'a-token';
  },
  async login() {},
  async logout() {},
  async handleUnauthorized() {
    return false;
  },
};

/** The open push: `kind`, `asked_of` and `due_at`, with no `subject`. */
const OPENED = {
  type: 'awaiting_answer',
  request_id: 'await-9f2c',
  state: 'waiting',
  kind: 'measurement',
  asked_of: 'process-chemist',
  due_at: '2026-09-06T00:00:00Z',
  reminders: 0,
};

/** The expiry push: `subject` and `reminders`, with no `kind`, `asked_of` or `due_at`. */
const EXPIRED = {
  type: 'awaiting_answer',
  request_id: 'await-9f2c',
  state: 'expired',
  subject: 'Isolated yield for arm B3',
  reminders: 2,
};

let restore: (() => void) | null = null;
let unmountHook: (() => void) | null = null;

/** One `200 text/event-stream` carrying the given frames, which then closes. */
function serveFrames(frames: object[]): void {
  const original = globalThis.fetch;
  const body = frames
    .map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`)
    .join('');
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

/**
 * Drive `useJobStreams` over one watched session and hand back the store it is actually reading.
 *
 * The store is imported here beside the hook, not at the top of the file, for the reason
 * `jobStreamAuth.test.ts` records at length: `vi.resetModules()` gives each test a fresh module
 * graph, so a file-level import writes into a store the hook under test cannot see, and the test
 * then passes against nothing.
 */
async function watch(): Promise<typeof import('../src/state/chatStore.ts').useChatStore> {
  const { useJobStreams } = await import('../src/hooks/useJobStreams.ts');
  const { useChatStore } = await import('../src/state/chatStore.ts');
  useChatStore.setState({
    conversations: {
      c1: {
        id: 'c1',
        sessionId: SID,
        title: 'x',
        messages: [{ id: 'm1', role: 'user', text: 'hi' }],
        updatedAt: 1,
      } as never,
    },
    activeId: 'c1',
    jobStreamsThrottled: false,
    jobStreamsFailing: [],
    jobFeed: [],
    awaiting: [],
  });
  unmountHook = renderHook(() => useJobStreams()).unmount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return useChatStore;
}

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  unmountHook?.();
  unmountHook = null;
  restore?.();
  restore = null;
  cleanup();
  vi.resetModules();
});

describe('the push-back stream delivers a question waiting on a person', () => {
  it('records the open, with the fields that push carries', async () => {
    serveFrames([OPENED]);
    const store = await watch();

    expect(store.getState().awaiting).toEqual(['await-9f2c']);
  });

  it('does not file it as a durable run that finished', async () => {
    // The one wrong place for it. A question held open for days rendered in the job feed reads as
    // a completion, and the feed's cards offer "open the result" — of a job that has not run.
    serveFrames([OPENED]);
    const store = await watch();

    expect(store.getState().jobFeed).toEqual([]);
  });

  it('takes it back down when the deadline passes', async () => {
    // The expiry push is why `noteAwaiting` branches on `state` at all. Without it the badge is a
    // monotonic counter of questions ever asked.
    serveFrames([OPENED, EXPIRED]);
    const store = await watch();

    expect(store.getState().awaiting).toEqual([]);
  });

  it('counts a reminder as the same question', async () => {
    // The workflow re-pushes every `reminder_hours`, and the stream itself is at-least-once across
    // a reconnect. Two entries for one request is two badges for one yield.
    serveFrames([OPENED, OPENED]);
    const store = await watch();

    expect(store.getState().awaiting).toHaveLength(1);
  });
});

describe('the sidebar says how many are waiting', () => {
  it('badges the review queue, and shows nothing when nothing is waiting', async () => {
    const { SidebarBody } = await import('../src/components/Sidebar.tsx');
    const { useChatStore } = await import('../src/state/chatStore.ts');

    // The listing endpoint is not the subject; answer everything with an empty page.
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    useChatStore.setState({ awaiting: [] });
    const view = render(
      <MemoryRouter>
        <SidebarBody />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText(/waiting on you/)).toBeNull();
    view.unmount();

    useChatStore.setState({
      awaiting: ['r1', 'r2'],
    });
    render(
      <MemoryRouter>
        <SidebarBody />
      </MemoryRouter>,
    );
    // Named rather than rendered as a bare digit: this link also leads to note proposals, and a
    // screen reader announcing "Review queue 2" says nothing about what the 2 counts.
    expect(screen.getByLabelText('2 waiting on you').textContent).toBe('2');
  });
});

describe('what survives a reload, and what has to be read again', () => {
  it('does not persist the badge, and fills it from the service instead', async () => {
    // **Both halves, because ISSUES.md claimed both were asserted here and neither was.** The
    // non-persistence is deliberate — the list is a notification cache and a persisted copy would
    // outlive the answer — but nothing pinned it, so a `partialize` that grew an `awaiting` line
    // would have shipped green.
    const { useChatStore } = await import('../src/state/chatStore.ts');
    useChatStore.setState({
      awaiting: ['r1'],
    });
    const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
    expect(persisted).not.toHaveProperty('awaiting');
    expect(persisted).not.toHaveProperty('awaitingRevision');

    // And the consequence the design left open. The claim behind `awaiting_answer` is destructive
    // and at-most-once, so a reload replays nothing: the questions are still open and the badge
    // read 0 until somebody opened `/review` — which is the screen the badge exists to send them
    // to. `syncAwaiting` off `GET /pending` is what closes that, and `useAwaitingBadge` in
    // `App.tsx` is what calls it without waiting for the inbox to be opened.
    useChatStore.setState({ awaiting: [], awaitingRevision: 0 });
    useChatStore.getState().syncAwaiting(['r1', 'r2']);
    expect(useChatStore.getState().awaiting).toHaveLength(2);
    // Never bumped by a read — see `awaitingRevision`, which exists so the inbox's own
    // reconciliation cannot re-trigger the effect that performed it.
    expect(useChatStore.getState().awaitingRevision).toBe(0);
  });
});
