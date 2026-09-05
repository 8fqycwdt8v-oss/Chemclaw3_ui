/**
 * A reload does not lose an answer the service already wrote.
 *
 * `partialize` rewrites a message still marked `streaming` to `aborted` on reload, and the reason
 * given was "there is no resume endpoint, so on reload it would hang forever". The first half is
 * right — a *stream* cannot be resumed. The conclusion stopped being true at
 * `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop`: a disconnect **detaches**, the service's own
 * pump runs the turn to completion and writes the answer into the session transcript, and
 * `api/detach.py` says outright that "the client recovers the answer from
 * `GET /sessions/{id}/messages` on reconnect".
 *
 * This app already did exactly that — in `recoverDetachedAnswer`, and only inside the tab that
 * started the turn, which is the one tab a reload destroys. The transcript rehydrate could not
 * cover it either: that effect runs only for a conversation with **no local messages at all**, and
 * this conversation is full with one hole in it. So the answer existed, on the server, reachable,
 * and the chemist was shown "Interrupted by a page reload" over the top of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeInterruptedTurn } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { TranscriptMessage } from '../src/api/client.ts';

const auth = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => {},
  logout: async () => {},
  handleUnauthorized: async () => false,
} as unknown as AuthProvider;

let restore: (() => void) | null = null;

/** `GET /sessions/{id}/messages`, answering with a transcript. */
function serveTranscript(messages: TranscriptMessage[]): void {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(messages), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

const turn = (question: string): { cid: string; mid: string } => {
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().setSessionId(cid, 'x'.repeat(32));
  useChatStore.getState().appendUserMessage(cid, question);
  const mid = useChatStore.getState().startAssistantMessage(cid);
  // What `partialize` leaves behind for a turn a reload cut off.
  useChatStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [cid]: {
        ...s.conversations[cid]!,
        messages: s.conversations[cid]!.messages.map((m) =>
          m.id === mid
            ? { ...m, status: 'aborted' as const, interruptedByReload: true as const }
            : m,
        ),
      },
    },
  }));
  return { cid, mid };
};

const answerOf = (cid: string, mid: string): string | null => {
  const m = useChatStore.getState().conversations[cid]?.messages.find((x) => x.id === mid);
  return m && m.role === 'assistant' ? m.finalText : null;
};

beforeEach(() => {
  vi.useFakeTimers();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    drafts: {},
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  restore?.();
  restore = null;
});

describe('a turn a reload interrupted', () => {
  it('adopts the answer the service finished without us', async () => {
    const { cid, mid } = turn('what is the pKa of acetic acid');
    serveTranscript([
      { index: 0, role: 'user', text: 'what is the pKa of acetic acid', tool_calls: [] },
      { index: 1, role: 'assistant', text: '4.76 in water at 25 °C.', tool_calls: [] },
    ]);

    resumeInterruptedTurn(cid, auth);
    // The poll's first tick. Deliberately not a single read: on the reload that matters the turn
    // is often still running, so one read would answer "not yet" and stop — the failure this
    // exists to fix, one round shorter.
    await vi.advanceTimersByTimeAsync(3_500);

    expect(answerOf(cid, mid)).toBe('4.76 in water at 25 °C.');
    const message = useChatStore.getState().conversations[cid]?.messages.find((m) => m.id === mid);
    expect(message?.role === 'assistant' && message.status).toBe('done');
  });

  it('does not hand back the first answer when the same question was asked twice', async () => {
    // The occurrence index is counted the same way the live path counts it. Without that, a
    // chemist who re-asks a question gets the previous answer under the new turn.
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 'y'.repeat(32));
    useChatStore.getState().appendUserMessage(cid, 'same question');
    const first = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().applyEvent(cid, first, {
      type: 'answer',
      text: 'the first answer',
      confidence: null,
      unsupported_claims: [],
      review_required: false,
      verified_by: null,
    });
    useChatStore.getState().finishTurn(cid, first, 'done');
    const { mid } = (() => {
      useChatStore.getState().appendUserMessage(cid, 'same question');
      const second = useChatStore.getState().startAssistantMessage(cid);
      useChatStore.setState((s) => ({
        conversations: {
          ...s.conversations,
          [cid]: {
            ...s.conversations[cid]!,
            messages: s.conversations[cid]!.messages.map((m) =>
              m.id === second
                ? { ...m, status: 'aborted' as const, interruptedByReload: true as const }
                : m,
            ),
          },
        },
      }));
      return { mid: second };
    })();

    serveTranscript([
      { index: 0, role: 'user', text: 'same question', tool_calls: [] },
      { index: 1, role: 'assistant', text: 'the first answer', tool_calls: [] },
      { index: 2, role: 'user', text: 'same question', tool_calls: [] },
      { index: 3, role: 'assistant', text: 'the second answer', tool_calls: [] },
    ]);

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(3_500);

    expect(answerOf(cid, mid)).toBe('the second answer');
  });

  it('does nothing for a conversation whose newest turn ended normally', async () => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().setSessionId(cid, 'z'.repeat(32));
    useChatStore.getState().appendUserMessage(cid, 'q');
    const mid = useChatStore.getState().startAssistantMessage(cid);
    useChatStore.getState().finishTurn(cid, mid, 'done');
    let asked = false;
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      asked = true;
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    expect(resumeInterruptedTurn(cid, auth)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(asked).toBe(false);
  });

  it('stops when the caller tears it down', async () => {
    // Navigating away must stop the poll rather than leave it running for its 630 s deadline.
    const { cid, mid } = turn('a question');
    serveTranscript([
      { index: 0, role: 'user', text: 'a question', tool_calls: [] },
      { index: 1, role: 'assistant', text: 'an answer', tool_calls: [] },
    ]);

    const stop = resumeInterruptedTurn(cid, auth);
    stop?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(answerOf(cid, mid)).toBeNull();
  });
});
