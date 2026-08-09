/**
 * The store must show partial text WHILE the turn runs, not only once it ends.
 *
 * Everything else in this suite checks what the store contains after a stream completes, which is
 * exactly the assertion a buffering bug survives: hold every token, flush at the end, and the
 * final state is identical. The property that matters to a reader watching an answer appear is
 * that intermediate state is observable — and it is also the property a memoisation or batching
 * change is most likely to break silently.
 *
 * The rAF batcher is the thing under test as much as the stream is: `sendMessage` coalesces tokens
 * to one store write per animation frame, so this drives rAF by hand and asserts the store has
 * moved before the response body is done.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';

const SID = 'a'.repeat(32);
const auth = {
  mode: 'dev' as const,
  account: null,
  getAccessToken: async () => null,
  login: async () => {},
  logout: async () => {},
  handleUnauthorized: async () => false,
};

/** Drives the batcher's rAF callbacks on demand, so a "frame" is something the test controls. */
function manualRaf() {
  const queue: FrameRequestCallback[] = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as typeof requestAnimationFrame;
  return {
    /** Run everything queued so far. */
    flush() {
      const pending = queue.splice(0);
      for (const cb of pending) cb(0);
    },
    restore() {
      globalThis.requestAnimationFrame = original;
    },
  };
}

const assistantText = (conversationId: string): string => {
  const messages = useChatStore.getState().conversations[conversationId]?.messages ?? [];
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return '';
  return last.finalText ?? last.streamedText;
};

let raf: ReturnType<typeof manualRaf>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  raf = manualRaf();
  originalFetch = globalThis.fetch;
  useChatStore.setState({
    conversations: {
      c1: {
        id: 'c1',
        sessionId: SID,
        title: 'test',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
      },
    },
    order: ['c1'],
    activeId: 'c1',
    drafts: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
});

afterEach(() => {
  raf.restore();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('streaming progress is observable', () => {
  it('grows the stored answer before the stream closes', async () => {
    // A stream held open under our control: each token is released only when the test says so.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encode = (text: string) =>
          controller.enqueue(
            new TextEncoder().encode(
              `event: token\ndata: ${JSON.stringify({ type: 'token', text })}\n\n`,
            ),
          );
        encode('The pKa ');
        encode('of acetic acid ');
        await gate;
        encode('is about 4.76.');
        controller.enqueue(
          new TextEncoder().encode(
            `event: answer\ndata: ${JSON.stringify({
              type: 'answer',
              text: 'The pKa of acetic acid is about 4.76.',
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

    const turn = sendMessage({ conversationId: 'c1', text: 'pKa?', auth });

    // Let the reader consume the two tokens released so far, then run the frame that commits them.
    await vi.waitFor(() => {
      raf.flush();
      expect(assistantText('c1')).toBe('The pKa of acetic acid ');
    });

    // The decisive assertion: text is in the store while the response body is still open.
    expect(useChatStore.getState().streaming).not.toBeNull();

    release();
    await turn;
    raf.flush();

    expect(assistantText('c1')).toBe('The pKa of acetic acid is about 4.76.');
    expect(useChatStore.getState().streaming).toBeNull();
  });

  it('keeps a trace entry behind the text that preceded it', async () => {
    // The orchestrator flushes pending tokens before applying any non-token event, because the
    // service emits a turn's tokens ahead of the tool calls of the same update. A trace row that
    // landed before its text would misrepresent the order the agent worked in.
    const frames =
      `event: token\ndata: ${JSON.stringify({ type: 'token', text: 'Checking hazards. ' })}\n\n` +
      `event: tool_call\ndata: ${JSON.stringify({ type: 'tool_call', tool: 'screen_hazards' })}\n\n` +
      `event: answer\ndata: ${JSON.stringify({ type: 'answer', text: 'Checking hazards. Done.' })}\n\n`;

    globalThis.fetch = (async () =>
      new Response(new TextEncoder().encode(frames), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

    let textWhenToolArrived: string | null = null;
    const unsubscribe = useChatStore.subscribe((state) => {
      // The last message is the user's until the assistant one is appended, and a user message
      // carries no trace — so narrow on the role rather than asserting the shape.
      const last = state.conversations.c1?.messages.at(-1);
      if (!last || last.role !== 'assistant') return;
      if (textWhenToolArrived === null && last.trace.some((e) => e.kind === 'tool_call')) {
        textWhenToolArrived = last.streamedText;
      }
    });

    await sendMessage({ conversationId: 'c1', text: 'hazards?', auth });
    raf.flush();
    unsubscribe();

    expect(textWhenToolArrived).toBe('Checking hazards. ');
  });
});
