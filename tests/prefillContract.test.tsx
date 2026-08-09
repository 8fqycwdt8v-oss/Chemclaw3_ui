/**
 * The `chemclaw:prefill` window event is a contract, and it is the only one of its kind here.
 *
 * Citation chips and prompt buttons are rendered deep inside markdown output, far from the
 * composer and with no shared ancestor worth threading a callback through, so they hand text back
 * on a window event instead. Two shapes travel on it:
 *
 *   - a plain string        — fill the box and focus it, let the human press Send
 *   - `{ text, autoSend }`  — fill and submit, for one-tap approve/decline
 *
 * Nothing else in the app couples this way, so nothing else would notice if it broke: the chip
 * would go quiet and the composer would simply never fill. These tests exist because the composer
 * was rewritten around this handler and the failure mode is silence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import * as sendMessageModule from '../src/state/sendMessage.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' } }),
}));

const CONVERSATION = 'conv-1';

/** The suite carries no jest-dom matchers, so read the value off the element. */
function composerValue(): string {
  return (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
}

function prefill(detail: string | { text: string; autoSend?: boolean }): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('chemclaw:prefill', { detail }));
  });
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChatStore.setState({
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        sessionId: 'a'.repeat(32),
        title: 'test',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
        sessionOrigin: 'local' as const,
      },
    },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    drafts: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
});

describe('chemclaw:prefill', () => {
  it('fills the composer from a plain string without sending', () => {
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    prefill('Expand note-42 and summarise what it says about the impurity.');

    expect(composerValue()).toBe('Expand note-42 and summarise what it says about the impurity.');
    expect(send).not.toHaveBeenCalled();
  });

  it('submits immediately when autoSend is set', () => {
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    prefill({ text: 'Approved — go ahead.', autoSend: true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      conversationId: CONVERSATION,
      text: 'Approved — go ahead.',
    });
    // Cleared on submit, so the sent text cannot be sent a second time by pressing Enter.
    expect(composerValue()).toBe('');
  });

  it('refuses to auto-send while a turn is already running', () => {
    // The backend sheds a concurrent POST with a hard 409 rather than queuing it, so an approval
    // arriving mid-turn must not fire.
    useChatStore.setState({ composerLock: 'turn_in_flight' });
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    prefill({ text: 'Approved — go ahead.', autoSend: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('writes the draft against the conversation it was prefilled into', () => {
    render(<Composer conversationId={CONVERSATION} />);

    prefill('a question about the aryl bromide');

    // Keyed in the store, not component state: the composer does not unmount when the active
    // conversation changes, and a draft that lived in component state leaked across the switch.
    expect(useChatStore.getState().drafts[CONVERSATION]).toBe('a question about the aryl bromide');
  });
});
