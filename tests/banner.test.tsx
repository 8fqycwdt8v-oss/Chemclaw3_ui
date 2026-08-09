/**
 * The banner strip: tone, and the actions it offers.
 *
 * `Banner` has had three kinds and three actions since it was introduced, and the header rendered
 * one kind and two actions. Both halves failed in the same direction — the strip claimed more than
 * it knew. Every banner was painted in the danger tone, so an informational notice arrived looking
 * like a failure; and `sendMessage` set `action: 'retry'` on the service's `retryable` branch,
 * which the renderer had no case for, so the affordance the taxonomy exists to offer was never on
 * screen at all.
 *
 * The retry case is the one worth pinning hardest, and not only in the happy direction: `Banner`
 * carries no conversation id, so "retry" only means something while the conversation on screen is
 * the one that failed. The last two tests are the guard against a button that would spend a turn
 * re-asking something nobody asked here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TopBar } from '../src/components/TopBar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AssistantMessage, Banner, Conversation } from '../src/state/types.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({
    auth: {
      mode: 'dev',
      account: null,
      login: vi.fn(),
      logout: vi.fn(),
      getAccessToken: async () => 'token',
    },
    refresh: vi.fn(),
  }),
}));

const assistant = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  at: 0,
  status: 'done',
  streamedText: '',
  finalText: null,
  confidence: null,
  unsupportedClaims: [],
  reviewRequired: false,
  verifiedBy: null,
  degradedConnectors: [],
  queued: false,
  trace: [],
  latestPlan: null,
  error: null,
  ...over,
});

const conversation = (messages: Conversation['messages']): Conversation => ({
  id: 'c1',
  sessionId: null,
  title: 'c',
  createdAt: 0,
  updatedAt: 0,
  messages,
  contextLost: false,
});

/** A conversation ending in the failed turn a retry banner would refer to. */
const failedTurn = (): Conversation =>
  conversation([
    { id: 'u1', role: 'user', text: 'What is the pKa of acetic acid?', at: 0 },
    assistant({
      status: 'error',
      error: { kind: 'stream', message: 'The turn failed.', code: 'llm_timeout', retryable: true },
    }),
  ]);

/** Mount the header with `banner` showing, `active` as the conversation on screen, and the router
 *  parked on `route` — which decides whether a composer exists to send anything through. */
function show(banner: Banner, active?: Conversation, route = '/') {
  useChatStore.setState({
    banner,
    activeId: active?.id ?? null,
    conversations: active ? { [active.id]: active } : {},
    order: active ? [active.id] : [],
  });
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TopBar />
    </MemoryRouter>,
  );
}

/** Record what the retry button hands to the composer. */
function capturePrefill(): { detail: unknown }[] {
  const seen: { detail: unknown }[] = [];
  window.addEventListener('chemclaw:prefill', (event) => {
    seen.push({ detail: (event as CustomEvent).detail });
  });
  return seen;
}

/** The strip itself — the element carrying the tone, which is the `<p>`'s parent. */
const strip = (text: string): HTMLElement => {
  const found = screen.getByText(text).closest('div');
  if (!found) throw new Error('no banner strip');
  return found;
};

beforeEach(() => {
  cleanup();
  // The health poll fires on mount; it is not what this file is about.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

describe('banner tone', () => {
  it('paints an error banner in the danger tone', () => {
    show({ kind: 'error', text: 'The turn failed.' });
    expect(strip('The turn failed.').className).toContain('bg-danger-soft');
  });

  it('paints a warning in the warn tone rather than the danger one', () => {
    show({ kind: 'warn', text: 'The safety connector was unreachable.' });
    const className = strip('The safety connector was unreachable.').className;
    expect(className).toContain('bg-warn-soft');
    expect(className).not.toContain('bg-danger-soft');
  });

  it('paints an informational notice in the neutral accent tone, not danger', () => {
    // The whole point of the kind: a notice that is not a problem must not read as one. There is
    // no `info` colour token, so `accent` is the neutral it borrows.
    show({ kind: 'info', text: 'This session was started as property-lookup.' });
    const className = strip('This session was started as property-lookup.').className;
    expect(className).toContain('bg-accent-soft');
    expect(className).not.toContain('bg-danger-soft');
  });

  it('tones the action button to match the banner, not to a hardcoded red', () => {
    show({ kind: 'warn', text: 'Sign in again to continue.', action: 'reauth' });
    expect(screen.getByRole('button', { name: 'Sign in again' }).className).toContain('text-warn');
  });
});

describe('banner actions', () => {
  it('offers the session reset for action: reset', () => {
    show({ kind: 'error', text: 'That session is gone.', action: 'reset' }, failedTurn());
    expect(screen.getByRole('button', { name: 'Start a fresh session' })).toBeTruthy();
  });

  it('offers re-authentication for action: reauth', () => {
    show({ kind: 'error', text: 'Your session expired.', action: 'reauth' });
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });

  it('offers nothing but dismissal when there is no action', () => {
    show({ kind: 'error', text: 'Out of budget for this session.' });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
  });

  it('re-sends the failed turn’s own message for action: retry', () => {
    // The gap this closes: `sendMessage` chooses 'retry' on `apiError.retryable`, and the renderer
    // had no branch for it, so the one error class the service says is worth asking again offered
    // no way to ask again.
    //
    // Asserted on the prefill event rather than on `sendMessage`, because going through the
    // composer is the fix and not an implementation detail of it: the composer holds the dry-run
    // toggle, and a send issued from the header would have escalated an estimate-only request into
    // a full turn with the toggle still reading "on".
    const prefills = capturePrefill();
    show({ kind: 'error', text: 'The model timed out.', action: 'retry' }, failedTurn());

    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));

    expect(prefills).toEqual([
      { detail: { text: 'What is the pKa of acetic acid?', autoSend: true } },
    ]);
  });

  it('withholds the retry button away from the chat route, where there is no composer', () => {
    const prefills = capturePrefill();
    show({ kind: 'error', text: 'The model timed out.', action: 'retry' }, failedTurn(), '/jobs');

    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.getByText('Ask again in the conversation this failed in.')).toBeTruthy();
    expect(prefills).toEqual([]);
  });

  it('withholds the retry button when the conversation on screen is not the one that failed', () => {
    // The user moved on after the failure. The banner is still true; "retry" is no longer
    // identifiable, and guessing would re-ask a question in the wrong conversation.
    show(
      { kind: 'error', text: 'The model timed out.', action: 'retry' },
      conversation([
        { id: 'u9', role: 'user', text: 'Something else entirely', at: 0 },
        assistant({ status: 'done', finalText: 'An answer.' }),
      ]),
    );

    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.getByText('Ask again in the conversation this failed in.')).toBeTruthy();
  });

  it('withholds it with no conversation at all, rather than rendering a dead button', () => {
    const prefills = capturePrefill();
    show({ kind: 'error', text: 'The model timed out.', action: 'retry' });

    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.getByText('Ask again in the conversation this failed in.')).toBeTruthy();
    expect(prefills).toEqual([]);
  });
});
