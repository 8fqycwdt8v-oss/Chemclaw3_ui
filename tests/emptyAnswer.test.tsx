/**
 * An `answer` event with empty text must not erase what the reader already watched arrive.
 *
 * `answer.text` is the full concatenation of every token, so the bubble prefers it outright — but
 * it preferred it with `??`, which falls back only on `null`/`undefined`. A terminal `answer`
 * carrying `text: ''` therefore replaced a settled answer with the empty string, and the bubble's
 * `body ? … : …` ternary rendered *nothing at all*: no text, no spinner, no error. The tokens were
 * still in the store; the component simply stopped showing them.
 *
 * That empty answer is a real wire shape rather than a hypothetical — `helpers.ts`'s `answerEvent`
 * builder defaults `text: ''` and says every default there is what the service sends when nothing
 * interesting happened.
 *
 * The second case is the honest one. A turn that genuinely produced no text at all must say so:
 * a blank card is indistinguishable from a backend that answered nothing, and from a UI bug.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MessageList } from '../src/components/MessageList.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { answerEvent } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
  useIsReviewer: () => false,
}));

const ANSWER = 'The pKa is approximately 4.76 in water.';

beforeEach(() => {
  cleanup();
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

/** Stream `tokens`, settle the turn with `answer.text`, and hand back the conversation id. */
const turn = (tokens: string, text: string): string => {
  const store = useChatStore.getState();
  const cid = store.createConversation();
  const mid = store.startAssistantMessage(cid);
  if (tokens) store.appendTokens(cid, mid, tokens);
  store.applyEvent(cid, mid, answerEvent({ text }));
  store.finishTurn(cid, mid, 'done');
  return cid;
};

const bubble = (): HTMLElement => screen.getByLabelText('Assistant answer');

describe('an answer event with empty text', () => {
  it('does not erase the tokens the reader already watched stream in', async () => {
    const cid = turn(ANSWER, '');
    render(<MessageList conversationId={cid} />);

    // The store still holds them, which is what makes the blank card a rendering fault.
    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    if (!message || message.role !== 'assistant') throw new Error('no assistant message');
    expect(message.streamedText).toBe(ANSWER);

    expect(await screen.findByText(ANSWER)).toBeTruthy();
  });

  it('says so rather than rendering a completely empty card when there is no text at all', async () => {
    const cid = turn('', '');
    render(<MessageList conversationId={cid} />);

    expect(await screen.findByText(/finished without producing any answer text/)).toBeTruthy();
    expect(bubble().textContent).not.toBe('');
  });

  it('still prefers a non-empty answer over the tokens, which are the same text', () => {
    // The store keeps the two apart precisely because `answer.text` is the whole concatenation;
    // anything that combined them would render the answer twice.
    const cid = turn(ANSWER, ANSWER);
    render(<MessageList conversationId={cid} />);

    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
  });
});
