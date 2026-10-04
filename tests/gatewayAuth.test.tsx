/**
 * The model gateway refusing the service's own credential (a 401/403 from the LLM endpoint).
 *
 * The service labels it `llm_auth`; before that it reached this app as `internal`, and a chemist
 * was told "internal error" about a deployment key only an operator can fix. Pinned end to end:
 * the code survives normalisation, maps to this app's sentence naming who can fix it, is never
 * offered as a Retry, and the banner carries the reference an operator needs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { normalizeEvent } from '../shared/events.ts';
import { GATEWAY_AUTH_MESSAGE, errorFromEvent } from '../src/api/errors.ts';
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

const SESSION = 'b'.repeat(32);

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** The service's own frame for a refused gateway credential (`api/runner.py`). */
const SERVICE_FRAME = {
  message:
    "The model provider refused this deployment's credentials, so no turn can run until an " +
    'operator fixes them; asking again will not help, so please report it ' +
    `(session ${SESSION}).`,
  code: 'llm_auth' as const,
  retryable: false,
  correlation_id: 'turn-auth-1',
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

describe('the llm_auth error code', () => {
  it('survives normalisation instead of collapsing to internal', () => {
    const event = normalizeEvent({ type: 'error', ...SERVICE_FRAME });
    expect(event && 'code' in event && event.code).toBe('llm_auth');
  });

  it('says who can fix it, never "internal", and is never retryable', () => {
    const err = errorFromEvent({ ...SERVICE_FRAME, retryable: true });
    expect(err.kind).toBe('agent');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(GATEWAY_AUTH_MESSAGE);
    expect(err.message).toMatch(/administrator/);
    expect(err.message).not.toMatch(/internal/i);
    expect(err.correlationId).toBe('turn-auth-1');
  });

  it('shows the sentence and the reference on the banner, with no Retry', async () => {
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
    await sendMessage({ conversationId: cid, text: 'what is the pKa?', auth: devAuth });

    const state = useChatStore.getState();
    expect(state.banner?.text).toContain(GATEWAY_AUTH_MESSAGE);
    expect(state.banner?.text).toContain('turn-auth-1');

    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('rejected this deployment');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
