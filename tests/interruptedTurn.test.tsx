/**
 * A turn whose service process died says so, and offers the question again.
 *
 * Chemclaw3 `D-2026-10-03-a-turn-is-written-ahead-and-an-interrupted-one-says-so`. Measured on the
 * kind cluster: a front-door pod killed mid-turn cut this browser's stream with no terminal event,
 * and the only thing this client could do was what it does for any dropped stream — poll the
 * transcript for ten minutes for an answer that would never be written, then report a lost
 * connection. The service now writes the question ahead of the turn and marks it `interrupted`
 * once the dead turn's lease lapses, and the reattach answers 410 `turn_interrupted`.
 *
 * Every case is driven against both service shapes this client must read: one that sends
 * `turn_status` and the 410, and one older than both, which must read exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, type TranscriptMessage } from '../src/api/client.ts';
import { errorFromStatus, TURN_INTERRUPTED_TEXT } from '../src/api/errors.ts';
import { MessageList, retryQuestionOf } from '../src/components/MessageList.tsx';
import { PREFILL_EVENT, type PrefillDetail } from '../src/state/composerEvents.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { recoverDetachedAnswer, sendMessage } from '../src/state/sendMessage.ts';
import {
  endingOfTurn,
  mergeTranscript,
  transcriptToMessages,
  TURN_FAILED_TEXT,
} from '../src/state/transcript.ts';
import type { ChatMessage } from '../src/state/types.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { erroringStream, sseFrames, stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
  useIsReviewer: () => false,
}));

const SID = 's'.repeat(32);
const TURN = 'c'.repeat(32);
const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

/** One stored question, as a service that writes it ahead of its turn sends it. */
const question = (
  text: string,
  turnStatus: TranscriptMessage['turn_status'],
  correlationId = TURN,
  index = 0,
): TranscriptMessage => ({
  index,
  role: 'user',
  text,
  tool_calls: [],
  correlation_id: correlationId,
  ...(turnStatus === undefined ? {} : { turn_status: turnStatus }),
});

const answer = (text: string, correlationId = TURN, index = 1): TranscriptMessage => ({
  index,
  role: 'assistant',
  text,
  tool_calls: [],
  correlation_id: correlationId,
  turn_status: null,
});

let restore: (() => void) | null = null;

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

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the reattach says the turn is gone', () => {
  it('reads a 410 `turn_interrupted` as its own kind, and an uncoded 410 as before', () => {
    const coded = errorFromStatus(410, undefined, null, TURN, 'turn_interrupted');
    expect(coded.kind).toBe('turn_interrupted');
    expect(coded.message).toBe(TURN_INTERRUPTED_TEXT);
    expect(coded.correlationId).toBe(TURN);
    expect(errorFromStatus(410, 'gone').kind).toBe('network');
  });
});

describe('a stored question says how its turn ended', () => {
  it('renders an interrupted question with the answer it never got, and nothing else changes', () => {
    const read = transcriptToMessages([
      question('first?', 'done', 'a'.repeat(32), 0),
      answer('first answer', 'a'.repeat(32), 1),
      question('second?', 'interrupted', TURN, 2),
    ]);
    expect(read.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const lost = read[3];
    expect(lost).toMatchObject({
      role: 'assistant',
      status: 'error',
      correlationId: TURN,
      error: { kind: 'turn_interrupted', message: TURN_INTERRUPTED_TEXT },
    });
    expect(read[1]).toMatchObject({ role: 'assistant', status: 'done', finalText: 'first answer' });
  });

  it('marks a failed turn failed and a stopped one aborted, and leaves a running one alone', () => {
    expect(transcriptToMessages([question('q', 'failed')])[1]).toMatchObject({
      status: 'error',
      error: { kind: 'agent', message: TURN_FAILED_TEXT },
    });
    expect(transcriptToMessages([question('q', 'stopped')])[1]).toMatchObject({
      status: 'aborted',
      error: null,
    });
    expect(transcriptToMessages([question('q', 'running')]).map((m) => m.role)).toEqual(['user']);
  });

  it('reads a service older than the field exactly as it always did', () => {
    const old = transcriptToMessages([question('q', undefined), answer('a')]);
    expect(old.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(transcriptToMessages([question('q', undefined)]).map((m) => m.role)).toEqual(['user']);
  });

  it('finds a turn’s ending by its id, never by its words', () => {
    const transcript = [question('same words', 'interrupted', 'b'.repeat(32))];
    expect(endingOfTurn(transcript, 'b'.repeat(32))).toBe('interrupted');
    expect(endingOfTurn(transcript, TURN)).toBeNull();
    expect(endingOfTurn([question('q', 'running')], TURN)).toBeNull();
    expect(endingOfTurn([question('q', 'done'), answer('a')], TURN)).toBeNull();
  });
});

describe('a re-read during somebody else’s turn', () => {
  it('lets the answer in behind a question that was read alone while it ran', () => {
    // The first re-read lands mid-turn: the question is stored, the answer is not.
    const first = mergeTranscript(
      [],
      transcriptToMessages([question('their question', 'running')]),
    );
    expect(first?.map((m) => m.role)).toEqual(['user']);
    // The second lands after: the same turn, now answered. It used to be matched by id and kept as
    // this browser had it — the lone question — for ever.
    const second = mergeTranscript(
      first ?? [],
      transcriptToMessages([question('their question', 'done'), answer('their answer')]),
    );
    expect(second?.map((m) => m.role)).toEqual(['user', 'assistant']);
    const settled = second?.[1];
    expect(settled?.role === 'assistant' && settled.finalText).toBe('their answer');
    // And a third read with nothing new changes nothing.
    expect(
      mergeTranscript(
        second ?? [],
        transcriptToMessages([question('their question', 'done'), answer('their answer')]),
      ),
    ).toBeNull();
  });
});

describe('detach recovery stops waiting for an answer that will never come', () => {
  const recover = async (): Promise<unknown> => {
    const pending = recoverDetachedAnswer(
      SID,
      'resilience?',
      'held',
      TURN,
      new AbortController().signal,
      auth,
    );
    await vi.advanceTimersByTimeAsync(700_000);
    return pending;
  };

  it('returns the ending as soon as the transcript marks the turn', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.spyOn(api, 'getMessages').mockImplementation(async () => {
      reads += 1;
      // Inside the dead turn's lease the service still calls it running; then it notices.
      return [question('resilience?', reads < 3 ? 'running' : 'interrupted')];
    });
    expect(await recover()).toEqual({ ended: 'interrupted' });
    expect(reads).toBe(3);
  });

  it('still polls to its deadline against a service that does not say', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getMessages').mockResolvedValue([question('resilience?', undefined)]);
    expect(await recover()).toBeNull();
  });
});

describe('a live turn cut off by a restart', () => {
  /** A stream the service accepted under `TURN`, that then breaks with no terminal event. */
  const killed = (): Response =>
    new Response(erroringStream(sseFrames([{ type: 'token', text: 'thinking' }])), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-chemclaw-correlation-id': TURN },
    });

  const sessionRoute = (url: string, init?: RequestInit): Response | null =>
    url.endsWith('/sessions') && init?.method === 'POST'
      ? new Response(JSON.stringify({ session_id: SID }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : null;

  it('ends as interrupted with the composer free, once the transcript says so', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stub = stubFetch((url, init) => {
      const session = sessionRoute(url, init);
      if (session) return session;
      if (url.endsWith('/messages') && (init?.method ?? 'GET') === 'GET') {
        reads += 1;
        return new Response(
          JSON.stringify([question('resilience?', reads < 2 ? 'running' : 'interrupted')]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return killed();
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    const turn = sendMessage({ conversationId: cid, text: 'resilience?', auth });
    await vi.advanceTimersByTimeAsync(120_000);
    await turn;

    const lost = useChatStore.getState().conversations[cid]?.messages[1];
    expect(lost).toMatchObject({
      role: 'assistant',
      status: 'error',
      error: { kind: 'turn_interrupted', message: TURN_INTERRUPTED_TEXT },
    });
    expect(useChatStore.getState().composerLock).toBe(false);
    expect(useChatStore.getState().banner?.text).toContain(TURN_INTERRUPTED_TEXT);
    // The question is offered back by Retry, not dropped into the draft as well.
    expect(useChatStore.getState().drafts[cid] ?? '').toBe('');
  }, 20_000);

  it('ends as interrupted at once when the reattach answers 410', async () => {
    const stub = stubFetch((url, init) => {
      const session = sessionRoute(url, init);
      if (session) return session;
      if (url.endsWith('/turn/stream')) {
        return new Response(
          JSON.stringify({ detail: { code: 'turn_interrupted', message: 'gone' } }),
          { status: 410, headers: { 'content-type': 'application/json' } },
        );
      }
      // The view is cut for falling behind, which is what sends this client to the reattach.
      return new Response(
        sseFrames([
          { type: 'token', text: 'thinking' },
          {
            type: 'error',
            message: 'behind',
            code: 'stream_lagged',
            retryable: true,
            correlation_id: '',
          },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    restore = stub.restore;

    const cid = useChatStore.getState().createConversation();
    await sendMessage({ conversationId: cid, text: 'resilience?', auth });

    expect(stub.calls.some((call) => call.url.endsWith('/turn/stream'))).toBe(true);
    expect(stub.calls.some((call) => call.url.endsWith('/messages') && !call.init?.method)).toBe(
      false,
    );
    expect(useChatStore.getState().conversations[cid]?.messages[1]).toMatchObject({
      status: 'error',
      error: { kind: 'turn_interrupted' },
    });
    expect(useChatStore.getState().composerLock).toBe(false);
  });
});

describe('the interrupted answer on screen', () => {
  const conversationWith = (messages: ChatMessage[]): string => {
    const cid = useChatStore.getState().createConversation();
    useChatStore.getState().hydrateTranscript(cid, messages);
    return cid;
  };

  it('says what happened and sends the question again on Retry', async () => {
    const cid = conversationWith(
      transcriptToMessages([question('what is the pKa of phenol?', 'interrupted')]),
    );
    const sent: PrefillDetail[] = [];
    const listen = (event: Event): void => {
      sent.push((event as CustomEvent<PrefillDetail>).detail);
    };
    window.addEventListener(PREFILL_EVENT, listen);
    try {
      render(<MessageList conversationId={cid} />);
      expect(await screen.findByText(TURN_INTERRUPTED_TEXT)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    } finally {
      window.removeEventListener(PREFILL_EVENT, listen);
    }
    expect(sent).toEqual([{ text: 'what is the pKa of phenol?', autoSend: true }]);
  });

  it('offers no Retry on any other failure', async () => {
    const cid = conversationWith(transcriptToMessages([question('q', 'failed')]));
    render(<MessageList conversationId={cid} />);
    expect(await screen.findByText(TURN_FAILED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('takes the question from the message before the answer, and only for an interrupted one', () => {
    const messages = transcriptToMessages([
      question('asked once', 'interrupted'),
      question('asked twice', 'failed', 'd'.repeat(32), 1),
    ]);
    expect(retryQuestionOf(messages, 1)).toBe('asked once');
    expect(retryQuestionOf(messages, 3)).toBeUndefined();
    expect(retryQuestionOf(messages, 0)).toBeUndefined();
  });
});
