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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { streamTurn, TURN_STALL_MS } from '../src/api/streamTurn.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { MessageList } from '../src/components/MessageList.tsx';
import { answerEvent, sseFrames, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
  cleanup();
});

/** A stream the test writes to: nothing arrives until `send`, so a gap is the test's choice. */
function feed(): { body: ReadableStream<Uint8Array>; send: (text: string) => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { body, send: (text) => controller?.enqueue(new TextEncoder().encode(text)) };
}

const respond = (body: ReadableStream<Uint8Array>): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/**
 * A turn over `stream` that logs its events and stall reports in one list, in the order they
 * happened. The clock is fake, so the only time that passes is what a test advances: a loaded
 * machine can delay a frame, but not move it past a stall bound.
 */
function watchedTurn(stream: ReturnType<typeof feed>) {
  vi.useFakeTimers();
  restore = stubFetch(() => respond(stream.body)).restore;
  const seen: string[] = [];
  const answer = streamTurn({
    sessionId: SESSION,
    message: 'hi',
    signal: new AbortController().signal,
    getToken: async () => null,
    onEvent: (event) => seen.push(event.type),
    onStall: (stalled) => seen.push(stalled ? 'stalled' : 'resumed'),
  });
  /** Resolves once `entry` has been logged; frames travel by microtasks, so no timer has to run. */
  const logged = (entry: string) => vi.waitUntil(() => seen.includes(entry), { interval: 0 });
  return { seen, answer, logged };
}

describe('a stream that goes quiet', () => {
  it('is reported as stalled, and reported again when it comes back', async () => {
    const stream = feed();
    const turn = watchedTurn(stream);

    stream.send(sseFrames([{ type: 'token', text: 'thinking' }]));
    await turn.logged('token');
    await vi.advanceTimersByTimeAsync(TURN_STALL_MS);
    stream.send(sseFrames([answerEvent({ text: 'done' })]));

    // Reported after the quiet began and withdrawn by the next frame — and the turn still
    // delivered its answer, which is the whole point of not aborting.
    expect((await turn.answer).text).toBe('done');
    expect(turn.seen).toEqual(['token', 'stalled', 'resumed', 'answer']);
  });

  it('says nothing about a turn that keeps producing frames', async () => {
    const stream = feed();
    const turn = watchedTurn(stream);

    // Each gap is inside the bound and the turn as a whole is well past it: the clock is idle
    // time, re-armed by every frame, not the turn's age.
    for (let i = 0; i < 3; i += 1) {
      stream.send(sseFrames([{ type: 'token', text: String(i) }]));
      await vi.waitUntil(() => turn.seen.length === i + 1, { interval: 0 });
      await vi.advanceTimersByTimeAsync(TURN_STALL_MS - 1);
    }
    stream.send(sseFrames([answerEvent({ text: 'done' })]));

    await turn.answer;
    expect(turn.seen).toEqual(['token', 'token', 'token', 'answer']);
  });

  it('leaves no timer running once the turn has settled', async () => {
    // The detector is a re-arming timer, so a turn that ended while it was armed would keep the
    // page awake and could report a stall on a turn nobody is watching any more.
    const stream = feed();
    const turn = watchedTurn(stream);

    stream.send(sseFrames([answerEvent()]));
    await turn.answer;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TURN_STALL_MS * 2);
    expect(turn.seen).toEqual(['answer']);
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
