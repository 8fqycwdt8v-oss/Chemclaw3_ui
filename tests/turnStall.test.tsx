/**
 * "The model is thinking" and "the chain is broken" used to look identical.
 *
 * `streamTurn`'s read loop has no idle deadline, `fetch` has no timeout, and `server/proxy.ts`
 * disables every socket and body timeout on purpose — a 600 s turn is legitimate. So a backend
 * that accepts the POST, flushes headers and then produces nothing renders as "Thinking…" plus an
 * elapsed counter, indefinitely: worst case (the pod killed mid-stream) a chemist waits about ten
 * and a half minutes, with nothing logged at any point.
 *
 * The detector reports; it never aborts. Cutting a long turn off would destroy the answer that was
 * coming, which is the mistake this codebase already avoided once with `loop_cap_reached`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { streamTurn } from '../src/api/streamTurn.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { MessageList } from '../src/components/MessageList.tsx';
import { answerEvent, sseFrames, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

/** A stream that sends `head`, goes quiet for `gapMs`, then sends `tail` and ends. */
function pausingStream(head: string, gapMs: number, tail: string): ReadableStream<Uint8Array> {
  const encode = (text: string) => new TextEncoder().encode(text);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 0) {
        sent = 1;
        controller.enqueue(encode(head));
        return;
      }
      if (sent === 1) {
        sent = 2;
        await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(encode(tail));
        return;
      }
      controller.close();
    },
  });
}

const respond = (body: ReadableStream<Uint8Array>): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('a stream that goes quiet', () => {
  it('is reported as stalled, and reported again when it comes back', async () => {
    const stub = stubFetch(() =>
      respond(
        pausingStream(
          sseFrames([{ type: 'token', text: 'thinking' }]),
          80,
          sseFrames([answerEvent({ text: 'done' })]),
        ),
      ),
    );
    restore = stub.restore;

    const stalls: boolean[] = [];
    const answer = await streamTurn({
      sessionId: SESSION,
      message: 'hi',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => {},
      stallAfterMs: 20,
      onStall: (stalled) => stalls.push(stalled),
    });

    // Reported, then withdrawn — and the turn still delivered its answer, which is the whole
    // point of not aborting.
    expect(stalls).toEqual([true, false]);
    expect(answer.text).toBe('done');
  });

  it('says nothing about a turn that keeps producing frames', async () => {
    const stub = stubFetch(() =>
      respond(
        pausingStream(
          sseFrames([{ type: 'token', text: 'a' }]),
          5,
          sseFrames([answerEvent({ text: 'done' })]),
        ),
      ),
    );
    restore = stub.restore;

    const stalls: boolean[] = [];
    await streamTurn({
      sessionId: SESSION,
      message: 'hi',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => {},
      stallAfterMs: 200,
      onStall: (stalled) => stalls.push(stalled),
    });

    expect(stalls).toEqual([]);
  });

  it('leaves no timer running once the turn has settled', async () => {
    // The detector is a re-arming timer, so a turn that ended while it was armed would keep the
    // page awake and could report a stall on a turn nobody is watching any more.
    const stub = stubFetch(() => respond(pausingStream(sseFrames([answerEvent()]), 5, '')));
    restore = stub.restore;

    const stalls: boolean[] = [];
    await streamTurn({
      sessionId: SESSION,
      message: 'hi',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => {},
      stallAfterMs: 10,
      onStall: (stalled) => stalls.push(stalled),
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(stalls).toEqual([]);
  });
});

describe('what the reader is told', () => {
  it('puts the notice beside the elapsed timer, and takes it away when a frame lands', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);

    store.setTurnStalled(cid, mid, true);
    const view = render(<MessageList conversationId={cid} />);
    expect(view.getByText(/no activity for 90 s/)).toBeTruthy();
    // The turn is still running and still says so: this qualifies the wait, it does not end it.
    // The sentence is the activity row's now rather than a fixed "Thinking…", and it is the row
    // this notice hangs off — a stall note with no statement of what is stalled says nothing.
    expect(view.getByText('Thinking')).toBeTruthy();

    act(() => useChatStore.getState().setTurnStalled(cid, mid, false));
    expect(screen.queryByText(/no activity for 90 s/)).toBeNull();
  });

  it('is cleared by the turn settling, so a finished answer never carries it', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.setTurnStalled(cid, mid, true);
    store.finishTurn(cid, mid, 'done');

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    expect(message?.role === 'assistant' && message.stalled).toBe(false);
  });
});
