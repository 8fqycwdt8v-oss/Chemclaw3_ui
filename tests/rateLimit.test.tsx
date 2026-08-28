/**
 * A 429 with a `Retry-After` is a pause; a 429 without one is a ceiling. The UI must not confuse
 * them, because only one of them ends.
 *
 * The service answers 429 for three structurally different reasons and the header is what tells
 * them apart:
 *
 *   - the per-principal request limiter (`api/auth.py::_within_budget`), ahead of *every*
 *     authenticated route, which computes the seconds until one token refills and sends them
 *     specifically so a client backs off by the right amount;
 *   - the turn/token budget (`api/routes/turns.py`), which does not replenish on its own;
 *   - the concurrent-event-stream cap (`api/routes/streams.py`), which is about this tab.
 *
 * Neither of the last two sends a header. Mapping all three to `budget_exhausted` made the first
 * one terminal: the composer was disabled with "The usage budget for this service is exhausted."
 * over a limit that had already refilled by the time the banner rendered, and the only way out was
 * a page reload. This is the same conflation `errorFromEvent` records for the in-band SSE path,
 * split here on the same principle — the service's own signal decides, not the status number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiError, errorFromStatus } from '../src/api/errors.ts';
import { TopBar } from '../src/components/TopBar.tsx';
import { streamTurn } from '../src/api/streamTurn.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { jsonError, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** The limiter's refusal, byte for byte: FastAPI's detail plus the header it computes. */
function rateLimited(seconds: string): Response {
  return new Response(JSON.stringify({ detail: 'too many requests' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': seconds },
  });
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe('errorFromStatus on 429', () => {
  it('reads a Retry-After as a rate limit, and carries the wait', () => {
    const err = errorFromStatus(429, 'too many requests', '12');

    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('keeps a 429 with no Retry-After terminal', () => {
    const err = errorFromStatus(429, 'session turn budget exhausted (50 turns)', null);

    expect(err.kind).toBe('budget_exhausted');
    expect(err.retryable).toBe(false);
    expect(err.retryAfterSeconds).toBe(0);
  });

  it('invents no wait from a header it cannot act on, and no ceiling either', () => {
    // An HTTP-date is legal in the header and is not what the service sends; reading it as
    // seconds would produce NaN, and treating NaN as a pause is worse than having no number.
    //
    // But "I cannot read this" is not "there was no header", and the two used to land in the same
    // branch — the terminal one, which locks the composer for the life of the page over a limit
    // that refills in seconds. The header's *presence* is what tells the three 429s apart, which
    // is what this mapper's own docstring says; only the number comes from parsing it.
    for (const header of ['Wed, 21 Oct 2026 07:28:00 GMT', '0', '12s', '-5']) {
      const err = errorFromStatus(429, 'too many requests', header);

      expect(err.kind).toBe('rate_limited');
      expect(err.retryable).toBe(true);
      // No number: `Countdown` renders nothing at zero, so the banner simply carries no wait.
      expect(err.retryAfterSeconds).toBe(0);
    }
  });

  it('treats a blank header as no header', () => {
    // A proxy that emits the field with nothing in it has said nothing, and there is no third
    // meaning to give it.
    expect(errorFromStatus(429, 'budget exhausted', '   ').kind).toBe('budget_exhausted');
  });
});

describe('the turn path', () => {
  it('carries the response header through to the typed error', async () => {
    // The mapper is only right if the header actually reaches it — `errorFromStatus` never saw
    // the `Response` before this.
    const stub = stubFetch(() => rateLimited('5'));
    restore = stub.restore;

    const err = await streamTurn({
      sessionId: SESSION,
      message: 'x',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => undefined,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('rate_limited');
    expect((err as ApiError).retryAfterSeconds).toBe(5);
  });
});

describe('sendMessage on a rate limit', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      order: [],
      activeId: null,
      composerLock: false,
      banner: null,
      jobFeed: [],
      streaming: null,
      drafts: {},
    });
  });

  it('leaves the composer usable and counts the wait down', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'b'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return rateLimited('20');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    // Before: 'budget_exhausted' — the textarea disabled for the life of the page.
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().banner?.retryAfterSeconds).toBe(20);
    expect(useChatStore.getState().banner?.text).toContain('20 s');
    // And the question is back where it was typed, so the wait is all that is left to do.
    expect(useChatStore.getState().drafts[cid]).toBe('hello');
  });

  it('leaves the composer usable when the wait is unreadable', async () => {
    // The gateway case: something in front of the service answers 429 with an HTTP-date. The
    // limit still refills in seconds, so locking the composer — the only branch with no way out
    // in the whole UI — is the one response that must not happen.
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'd'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return rateLimited('Wed, 21 Oct 2026 07:28:00 GMT');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(useChatStore.getState().composerLock).toBe(false);
    // No invented number, and no "0 s" either — the countdown has nothing to show.
    expect(useChatStore.getState().banner?.retryAfterSeconds).toBeUndefined();
    expect(useChatStore.getState().banner?.text).not.toContain('0 s');
    expect(useChatStore.getState().drafts[cid]).toBe('hello');
  });

  it('still locks the composer on a budget 429', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'c'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonError(429, 'session turn budget exhausted (50 turns)');
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'hello', auth: devAuth });

    expect(useChatStore.getState().composerLock).toBe('budget_exhausted');
  });
});

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({
    auth: { getAccessToken: async () => null, mode: 'dev', account: null },
    ready: true,
    refresh: () => undefined,
  }),
  useIsReviewer: () => false,
}));

describe('the banner', () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    const stub = stubFetch(() => new Response('{"status":"ok"}', { status: 200 }));
    restore = stub.restore;
    useChatStore.setState({ activeId: null, conversations: {}, order: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('counts the wait down, silently', () => {
    useChatStore.setState({
      banner: { kind: 'warn', text: 'Too many requests. Try again in 3 s.', retryAfterSeconds: 3 },
    });
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

    expect(screen.getByText('3s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('1s')).toBeTruthy();

    // Silently: the banner is `role="alert"`, so a number changing once a second would be
    // re-announced once a second. The wait is in the text, which is announced once.
    expect(screen.getByText('1s').getAttribute('aria-hidden')).toBe('true');

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('counts the second refusal down, not the first one twice', () => {
    // A limiter that refuses twice in a row is the ordinary case, and the banner is *replaced*
    // rather than remounted — `Countdown` adjusts in render and re-runs its effect on the new
    // `seconds`. Without the effect's `clearInterval`, the first interval keeps ticking beside
    // the second: the display drops 2 s per second and reads a number that was never true, and a
    // third refusal makes it 3 Hz. This is the one consequence of a missing cleanup that a
    // chemist can see, and it is the number the widget exists to show.
    useChatStore.setState({
      banner: {
        kind: 'warn',
        text: 'Too many requests. Try again in 30 s.',
        retryAfterSeconds: 30,
      },
    });
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('25s')).toBeTruthy();

    act(() =>
      useChatStore.setState({
        banner: {
          kind: 'warn',
          text: 'Too many requests. Try again in 10 s.',
          retryAfterSeconds: 10,
        },
      }),
    );
    expect(screen.getByText('10s')).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('8s')).toBeTruthy();
  });

  it('takes its timer with it when the banner goes away', () => {
    // The other half of the same cleanup, and the half that is silent: React 19 no-ops a
    // `setState` on an unmounted tree, so a 1 Hz interval left running for the life of the tab
    // shows up in neither the console nor a test that only reads the screen. The count is read
    // *after* advancing, because `TopBar`'s health probe legitimately leaves one-shot timers
    // pending at the moment of unmount — those drain, an interval does not.
    useChatStore.setState({
      banner: {
        kind: 'warn',
        text: 'Too many requests. Try again in 30 s.',
        retryAfterSeconds: 30,
      },
    });
    const { unmount } = render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('28s')).toBeTruthy();

    unmount();
    act(() => vi.advanceTimersByTime(30_000));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows nothing extra on a banner that carries no wait', () => {
    useChatStore.setState({ banner: { kind: 'error', text: 'Something failed.' } });
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/^\d+s$/)).toBeNull();
  });
});
