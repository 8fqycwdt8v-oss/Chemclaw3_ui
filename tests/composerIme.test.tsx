/**
 * Enter commits an IME candidate; it does not send the message.
 *
 * A Japanese, Chinese or Korean composition is typed into the textarea as *pending* text and
 * settled with Enter — the same key this composer submits on. Without a guard the keydown that
 * chose the candidate also posted the turn, so a chemist writing 反応条件 sent whatever half of it
 * the IME had committed by then and lost the rest, with no way to tell what the agent actually
 * received. The failure is invisible to anyone testing in a Latin script, which is why it is
 * pinned here rather than left to the browser.
 *
 * Both halves of the guard are exercised. `isComposing` is the modern signal; `keyCode === 229`
 * is what browsers that never set it report for every keystroke the IME owns, and dropping it
 * would leave exactly those users with the bug this file describes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import * as sendMessageModule from '../src/state/sendMessage.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const CONVERSATION = 'conv-ime';

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement;

/** Type into the composer the way the IME does: pending text, then the settling keydown. */
function compose(init: KeyboardEventInit): void {
  const el = box();
  fireEvent.compositionStart(el);
  fireEvent.change(el, { target: { value: '反応条件' } });
  fireEvent.keyDown(el, { key: 'Enter', ...init });
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChatStore.setState({
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        sessionId: 'a'.repeat(32),
        sessionOrigin: 'local' as const,
        title: 'test',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
      },
    },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    drafts: {},
    sessionProfiles: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
});

describe('Enter during IME composition', () => {
  it('commits the candidate instead of sending', () => {
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    compose({ isComposing: true, keyCode: 229 });

    expect(send).not.toHaveBeenCalled();
    // And the draft survives: a submit would have cleared it out from under the composition.
    expect(useChatStore.getState().drafts[CONVERSATION]).toBe('反応条件');
  });

  it('commits the candidate on a browser that reports only keyCode 229', () => {
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    compose({ keyCode: 229 });

    expect(send).not.toHaveBeenCalled();
  });

  it('does not submit on Cmd+Enter either, because the composition is unresolved', () => {
    // The shortcut path bypasses every other Enter rule — coarse pointer, Shift — so it needs the
    // guard above it rather than beside it. What the user is confirming is a candidate; the
    // message they meant to send does not exist yet.
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    compose({ isComposing: true, keyCode: 229, metaKey: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('sends on the Enter that follows the composition', () => {
    const send = vi.spyOn(sendMessageModule, 'sendMessage').mockResolvedValue();
    render(<Composer conversationId={CONVERSATION} />);

    compose({ isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ text: '反応条件' });
  });
});
