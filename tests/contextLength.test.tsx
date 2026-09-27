/**
 * A conversation that has outgrown the model's context window.
 *
 * The service labels it `context_length` since Chemclaw3 #476; before that the same refusal reached
 * this app as `internal`, and a chemist was told "internal error" about the one failure a fresh
 * session fixes. Pinned end to end: the code survives normalisation, maps to its own kind with
 * this app's sentence, is never offered as a Retry (the same thread overflows the same window),
 * and the banner offers a fresh session instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { normalizeEvent } from '../shared/events.ts';
import { CONTEXT_LENGTH_MESSAGE, errorFromEvent } from '../src/api/errors.ts';
import { TopBar } from '../src/components/TopBar.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { errorEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({
    auth: { getAccessToken: async () => null, mode: 'dev', account: null },
    ready: true,
    refresh: () => undefined,
  }),
  useIsReviewer: () => false,
}));

const SESSION = 'a'.repeat(32);

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** The service's own frame for an overflow (`api/runner.py`), sentence and all. */
const SERVICE_FRAME = {
  message:
    'The conversation has grown too long for the model to read in one request; start a new ' +
    `session or ask a narrower question (session ${SESSION}).`,
  code: 'context_length' as const,
  retryable: false,
  correlation_id: 'turn-ctx-1',
};

let restore: (() => void) | null = null;

beforeEach(() => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    drafts: {},
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

describe('the context_length error code', () => {
  it('survives normalisation instead of collapsing to internal', () => {
    const event = normalizeEvent({ type: 'error', ...SERVICE_FRAME });
    expect(event && 'code' in event && event.code).toBe('context_length');
  });

  it('still degrades an unknown code to internal rather than dropping the event', () => {
    const event = normalizeEvent({ type: 'error', ...SERVICE_FRAME, code: 'from_a_newer_service' });
    expect(event && 'code' in event && event.code).toBe('internal');
    // …which renders as a generic agent failure with the service's own sentence.
    const err = errorFromEvent({ ...SERVICE_FRAME, code: 'from_a_newer_service' });
    expect(err.kind).toBe('agent');
    expect(err.message).toBe(SERVICE_FRAME.message);
  });

  it('maps to its own kind, with copy that says what to do, and is never retryable', () => {
    // `retryable: true` from the wire is overridden: resending re-reads the same too-long thread.
    const err = errorFromEvent({ ...SERVICE_FRAME, retryable: true });
    expect(err.kind).toBe('context_length');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(CONTEXT_LENGTH_MESSAGE);
    expect(err.message).toMatch(/too long/);
    expect(err.message).toMatch(/fresh session/);
    expect(err.message).not.toMatch(/internal/i);
    expect(err.correlationId).toBe('turn-ctx-1');
  });

  it('offers a fresh session on the banner, not Retry, and leaves the composer open', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: SESSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/health')) return new Response('{"status":"ok"}', { status: 200 });
      return sseResponse(sseFrames([errorEvent(SERVICE_FRAME)]));
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    useChatStore.setState({ activeId: cid });
    await sendMessage({ conversationId: cid, text: 'and the next step?', auth: devAuth });

    const state = useChatStore.getState();
    expect(state.composerLock).toBe(false);
    expect(state.banner?.action).toBe('reset');
    expect(state.banner?.text).toContain(CONTEXT_LENGTH_MESSAGE);
    expect(state.banner?.text).toContain('turn-ctx-1');
    const message = state.conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.error?.kind).toBe('context_length');
    // The question comes back to the draft, so it can be carried into the fresh session.
    expect(state.drafts[cid]).toBe('and the next step?');

    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('grown too long for the model');
    expect(screen.getByRole('button', { name: 'Start a fresh session' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
