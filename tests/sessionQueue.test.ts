/**
 * A shared conversation queues a message instead of refusing it (Chemclaw3 #499,
 * `D-2026-10-01-a-queued-message-waits-in-its-senders-request`), and this is the client half.
 *
 * Three things changed on the wire and each has a way to go wrong here that is worse than the
 * feature missing:
 *
 *  - **Stop while waiting.** The running turn is somebody else's. `POST /turn/stop` is refused for
 *    a member and *succeeds* for the owner — cancelling a colleague's work to take back a question.
 *    So a waiting message is withdrawn by its ticket, and only a 404 (it started in the race) falls
 *    back to stopping.
 *  - **`queue_cancelled`.** Nothing ran and nothing was spent; painting it as a failed turn would be
 *    a lie in the transcript. The question goes back in the box.
 *  - **`stream_lagged`.** Only this browser's *view* was cut off; the turn runs on. Reading it as a
 *    failure throws away an answer that is still being written, so the client reattaches through
 *    `GET /turn/stream`, and falls back to the transcript when no turn is running to attach to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { sendMessage, stopStreaming } from '../src/state/sendMessage.ts';
import { errorFromEvent } from '../src/api/errors.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import {
  answerEvent,
  errorEvent,
  jsonError,
  sseFrames,
  sseResponse,
  stubFetch,
} from './helpers.ts';

const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const SID = 'e'.repeat(32);
const QUESTION = 'which base for the Buchwald coupling';

let restore: (() => void) | null = null;

beforeEach(() => {
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
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A turn stream that sends `events` and then holds the connection open until `close()`. */
function holdingStream(events: ChemclawEvent[]): {
  response: Response;
  close: () => void;
  send: (more: ChemclawEvent[]) => void;
} {
  let close = (): void => undefined;
  let send = (_more: ChemclawEvent[]): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseFrames(events)));
      send = (more) => controller.enqueue(new TextEncoder().encode(sseFrames(more)));
      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed by the abort.
        }
      };
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    close: () => close(),
    send: (more) => send(more),
  };
}

/** A conversation that already has its session, so the only requests are the ones under test. */
function conversation(): string {
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().setSessionId(cid, SID);
  return cid;
}

const latest = (cid: string) => {
  const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
};

async function until(ready: () => boolean, what: string, deadlineMs = 10_000): Promise<void> {
  const stopAt = Date.now() + deadlineMs;
  while (!ready()) {
    if (Date.now() > stopAt)
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const inLine = (ticket: number, position: number): ChemclawEvent => ({
  type: 'queued',
  ticket,
  position,
});

describe('a message waiting in a shared conversation’s line', () => {
  it('is withdrawn by its ticket, and never stops the turn that is running', async () => {
    const stream = holdingStream([inLine(41, 1)]);
    const stub = stubFetch((url, init) => {
      if (url.endsWith(`/sessions/${SID}/queue/41`) && init?.method === 'DELETE') {
        stream.close();
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/turn/stop')) return json({ stopped: true });
      return stream.response;
    });
    restore = stub.restore;

    const cid = conversation();
    const turn = sendMessage({ conversationId: cid, text: QUESTION, auth });
    await until(() => Boolean(latest(cid).queuePlace), 'the place in line');
    expect(latest(cid).queuePlace).toEqual({ ticket: 41, position: 1 });

    stopStreaming();
    await turn;

    expect(stub.calls.some((c) => c.init?.method === 'DELETE')).toBe(true);
    // The whole point: the running turn is a colleague's, and an owner's Stop would cancel it.
    expect(stub.calls.some((c) => c.url.endsWith('/turn/stop'))).toBe(false);
    const message = latest(cid);
    expect(message.status).toBe('aborted');
    expect(message.withdrawn).toMatch(/withdrew this message before it ran/);
    expect(message.error).toBeNull();
    // Nothing ran, so the question is not lost with it.
    expect(useChatStore.getState().drafts[cid]).toBe(QUESTION);
    expect(useChatStore.getState().composerLock).toBe(false);
  }, 20_000);

  it('falls back to stopping the turn when the message started in the race', async () => {
    const stream = holdingStream([inLine(41, 0)]);
    const stub = stubFetch((url, init) => {
      if (url.includes('/queue/') && init?.method === 'DELETE') {
        return jsonError(404, 'no such message is waiting in this session');
      }
      if (url.endsWith('/turn/stop')) {
        stream.close();
        return json({ stopped: true });
      }
      return stream.response;
    });
    restore = stub.restore;

    const cid = conversation();
    const turn = sendMessage({ conversationId: cid, text: QUESTION, auth });
    await until(() => Boolean(latest(cid).queuePlace), 'the place in line');
    stopStreaming();
    await turn;

    // A 404 is "it is running now", and then it is this person's own turn to stop.
    expect(stub.calls.some((c) => c.url.endsWith('/turn/stop'))).toBe(true);
    const message = latest(cid);
    expect(message.status).toBe('aborted');
    expect(message.withdrawn).toBeUndefined();
  }, 20_000);

  it('is withdrawn, not stopped, when the page goes away while it waits', async () => {
    const stream = holdingStream([inLine(7, 2)]);
    const stub = stubFetch((url, init) => {
      if (url.includes('/queue/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/turn/stop')) return json({ stopped: true });
      return stream.response;
    });
    restore = stub.restore;

    const cid = conversation();
    const turn = sendMessage({ conversationId: cid, text: QUESTION, auth });
    await until(() => Boolean(latest(cid).queuePlace), 'the place in line');
    useChatStore.getState().streaming?.abandon();
    await until(
      () => stub.calls.some((c) => c.init?.method === 'DELETE'),
      'the withdrawal on unload',
    );

    const withdrawal = stub.calls.find((c) => c.init?.method === 'DELETE');
    expect(withdrawal?.url).toMatch(new RegExp(`/sessions/${SID}/queue/7$`));
    expect(withdrawal?.init?.keepalive).toBe(true);
    expect(stub.calls.some((c) => c.url.endsWith('/turn/stop'))).toBe(false);

    // The page did not actually go anywhere in a test, so let the turn end on its own.
    stream.send([answerEvent({ text: 'done' })]);
    await turn;
  }, 20_000);

  it('is stopped on unload when it started before the withdrawal reached the service', async () => {
    const stream = holdingStream([inLine(9, 0)]);
    const stub = stubFetch((url, init) => {
      if (url.includes('/queue/') && init?.method === 'DELETE') {
        return jsonError(404, 'no such message is waiting in this session');
      }
      if (url.endsWith('/turn/stop')) return json({ stopped: true });
      return stream.response;
    });
    restore = stub.restore;

    const cid = conversation();
    const turn = sendMessage({ conversationId: cid, text: QUESTION, auth });
    await until(() => Boolean(latest(cid).queuePlace), 'the place in line');
    useChatStore.getState().streaming?.abandon();
    await until(
      () => stub.calls.some((c) => c.url.endsWith('/turn/stop')),
      'the stop that follows a withdrawal the service no longer had a place for',
    );

    const stop = stub.calls.find((c) => c.url.endsWith('/turn/stop'));
    expect(stop?.init?.keepalive).toBe(true);

    stream.send([answerEvent({ text: 'done' })]);
    await turn;
  }, 20_000);

  it('is not painted as a failed turn when somebody else withdraws it', async () => {
    const stub = stubFetch(() =>
      sseResponse(
        sseFrames([
          inLine(41, 0),
          errorEvent({
            code: 'queue_cancelled',
            message:
              'Your message did not run: you are no longer a participant in this conversation.',
          }),
        ]),
      ),
    );
    restore = stub.restore;

    const cid = conversation();
    await sendMessage({ conversationId: cid, text: QUESTION, auth });

    const message = latest(cid);
    expect(message.status).toBe('aborted');
    expect(message.error).toBeNull();
    expect(message.withdrawn).toMatch(/no longer a participant/);
    const banner = useChatStore.getState().banner;
    expect(banner?.kind).toBe('info');
    expect(banner?.text).toMatch(/no longer a participant.*back in the box/);
    expect(useChatStore.getState().drafts[cid]).toBe(QUESTION);
    expect(useChatStore.getState().composerLock).toBe(false);
  });
});

describe('a view of the turn cut off for falling behind (`stream_lagged`)', () => {
  it('reattaches through the watch route and finishes the turn it was watching', async () => {
    let posts = 0;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/turn/stream') && (init?.method ?? 'GET') === 'GET') {
        return sseResponse(sseFrames([answerEvent({ text: 'Cs2CO3 in dioxane.' })]));
      }
      posts += 1;
      return sseResponse(
        sseFrames([
          { type: 'token', text: 'Cs2' },
          errorEvent({ code: 'stream_lagged', retryable: true, message: 'cut off' }),
        ]),
      );
    });
    restore = stub.restore;

    const cid = conversation();
    await sendMessage({ conversationId: cid, text: QUESTION, auth });

    // One POST: the reattach must never send the question a second time.
    expect(posts).toBe(1);
    expect(stub.calls.some((c) => c.url.endsWith(`/sessions/${SID}/turn/stream`))).toBe(true);
    const message = latest(cid);
    expect(message.status).toBe('done');
    expect(message.finalText).toBe('Cs2CO3 in dioxane.');
    expect(message.error).toBeNull();
    // The "reconnecting" notice is gone once the view it promised delivered.
    expect(useChatStore.getState().banner).toBeNull();
  });

  it('reads the answer from the transcript when no turn is left to attach to', async () => {
    let polls = 0;
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/turn/stream'))
        return jsonError(404, 'no turn is running for this session');
      if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
        polls += 1;
        return json([
          { index: 0, role: 'user', text: QUESTION, tool_calls: [] },
          { index: 1, role: 'assistant', text: 'K3PO4, as in the house SOP.', tool_calls: [] },
        ]);
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        throw new Error('a 404 on the watch route must never mint a new session');
      }
      return sseResponse(
        sseFrames([errorEvent({ code: 'stream_lagged', retryable: true, message: 'cut off' })]),
      );
    });
    restore = stub.restore;

    const cid = conversation();
    await sendMessage({ conversationId: cid, text: QUESTION, auth });

    expect(polls).toBeGreaterThan(0);
    const message = latest(cid);
    expect(message.status).toBe('done');
    expect(message.finalText).toBe('K3PO4, as in the house SOP.');
    expect(useChatStore.getState().conversations[cid]?.sessionId).toBe(SID);
    expect(useChatStore.getState().conversations[cid]?.contextLost).toBe(false);
  }, 20_000);
});

describe('the two new error codes, as kinds', () => {
  it('reads queue_cancelled as a withdrawal with the service’s own reason', () => {
    const error = errorFromEvent({
      code: 'queue_cancelled',
      message: 'Your message was withdrawn before it ran.',
      retryable: true,
      correlation_id: 'c-1',
    });
    expect(error.kind).toBe('queue_cancelled');
    expect(error.message).toBe('Your message was withdrawn before it ran.');
    // Sending it again is the chemist's call, not a Retry button's.
    expect(error.retryable).toBe(false);
  });

  it('reads stream_lagged as a view to reopen, never as the turn failing', () => {
    const error = errorFromEvent({
      code: 'stream_lagged',
      message: 'internal wording',
      retryable: false,
      correlation_id: '',
    });
    expect(error.kind).toBe('stream_lagged');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/still running/);
  });
});
