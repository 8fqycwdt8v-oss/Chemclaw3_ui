/**
 * A subagent's working prose must not be spliced into the answer a chemist reads.
 *
 * `graph_stream.py` builds every token as `TokenEvent(text=text, agent="subagent" if namespace
 * else "")` — the namespace test fires for anything running below the root graph — and the
 * backend's own `TokenEvent` docstring says the runner "concatenates only the unattributed ones",
 * because an attributed chunk is "another agent's working notes spliced into the answer".
 *
 * `shared/events.ts` had no `agent` on `TokenEvent`, and `normalizeEvent` builds each event field
 * by field, so the attribution was not merely untyped here — it was deleted in transit, which is
 * the exact failure that file's own docstring names. Everything was concatenated.
 *
 * The final `AnswerEvent` is root-only and replaces the render, so the mess showed only while it
 * streamed — except when the turn is stopped, times out, or hits `loop_cap_reached` without an
 * answer, where `streamedText` is what is kept, rendered and persisted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage } from '../src/state/sendMessage.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { errorEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
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
});

describe('the token event contract', () => {
  it('mirrors the attribution the backend sends', () => {
    expect(normalizeEvent({ type: 'token', text: 'notes', agent: 'subagent' })).toEqual({
      type: 'token',
      text: 'notes',
      agent: 'subagent',
    });
    // Empty is the main agent — the same default the backend serialises.
    expect(normalizeEvent({ type: 'token', text: 'hi' })).toEqual({
      type: 'token',
      text: 'hi',
      agent: '',
    });
  });
});

describe('a turn that delegates', () => {
  it('keeps the subagent’s prose out of the streamed answer', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: 'a'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // No answer: the turn hits the loop cap, which is precisely when `streamedText` is what
      // gets kept and shown.
      return sseResponse(
        sseFrames([
          { type: 'token', text: 'The pKa is ', agent: '' },
          { type: 'token', text: '[checking the corpus…]', agent: 'subagent' },
          { type: 'token', text: '4.2.', agent: '' },
          errorEvent({ message: 'step limit reached', code: 'loop_cap_reached' }),
        ]),
      );
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'pKa of aspirin?', auth: devAuth });

    const assistant = useChatStore
      .getState()
      .conversations[cid]?.messages.find((m) => m.role === 'assistant');
    // Before: 'The pKa is [checking the corpus…]4.2.'
    expect(assistant?.role === 'assistant' && assistant.streamedText).toBe('The pKa is 4.2.');
  });
});
