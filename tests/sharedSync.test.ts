/**
 * An open shared conversation stays in step with the other people in it (Chemclaw3_ui #130).
 *
 * The defect, as a real-browser run against the whole system found it: participants never saw each
 * other's turns — not live, and not after a reload. The transcript was read back only into an
 * *empty* conversation the service had listed, so an owner never re-read theirs and a member read
 * theirs once; `GET /sessions/{id}/turn/stream` was used only to reattach a turn's own sender.
 *
 * Two halves, pinned separately:
 *
 *  - `mergeTranscript` — a re-read joins the conversation this browser holds by turn identity:
 *    somebody else's turns are inserted where the service has them, this browser's own are never
 *    traded for their stored copies, and a turn it is streaming is never touched.
 *  - `followSharedConversation` — the re-read on open and after a turn, and following somebody
 *    else's running turn live, with the service's refusals as ordinary states.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/state/chatStore.ts';
import { mergeTranscript, transcriptToMessages } from '../src/state/transcript.ts';
import { followSharedConversation } from '../src/state/sharedSync.ts';
import { config } from '../src/env.ts';
import type { TranscriptMessage } from '../src/api/client.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { AssistantMessage, ChatMessage } from '../src/state/types.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import { answerEvent, jsonError, sseFrames, stubFetch } from './helpers.ts';

const auth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const SID = 'c'.repeat(32);
const ALICE = 'alice-oid';
const BOB = 'bob-oid';

/* ------------------------------------------------------------------ builders */

const stored = (
  index: number,
  role: 'user' | 'assistant',
  text: string,
  actor: string,
  correlation: string | null,
  tools: TranscriptMessage['tool_calls'] = [],
): TranscriptMessage => ({
  index,
  role,
  text,
  tool_calls: tools,
  correlation_id: correlation,
  author: { actor, agent: role === 'assistant' ? 'chemclaw' : null },
});

const question = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', text, at: 1, ...extra }) as ChatMessage;

const answer = (
  id: string,
  text: string,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  id,
  role: 'assistant',
  at: 1,
  status: 'done',
  streamedText: '',
  finalText: text,
  confidence: 0.9,
  unsupportedClaims: [],
  reviewRequired: false,
  verifiedBy: 'judge',
  degradedConnectors: [],
  partialReason: null,
  queued: false,
  trace: [],
  latestPlan: null,
  latestPlanHash: null,
  latestPlanScope: null,
  error: null,
  ...extra,
});

const texts = (messages: readonly ChatMessage[]): string[] =>
  messages.map((m) =>
    m.role === 'user'
      ? `Q:${m.text}`
      : `A:${m.finalText || m.streamedText}${m.watched ? ' (watched)' : ''}`,
  );

/* ------------------------------------------------------------------ the merge */

describe('mergeTranscript', () => {
  // Alice's turn, then Bob's, then Alice's again — as the service stored them.
  const remote = transcriptToMessages([
    stored(0, 'user', 'Rank the solvents.', ALICE, 'turn-a1'),
    stored(1, 'assistant', 'Toluene first.', ALICE, 'turn-a1'),
    stored(2, 'user', 'Which base?', BOB, 'turn-b1'),
    stored(3, 'assistant', 'Cs2CO3.', BOB, 'turn-b1'),
    stored(4, 'user', 'And the temperature?', ALICE, 'turn-a2'),
    stored(5, 'assistant', '80 °C.', ALICE, 'turn-a2'),
  ]);

  it('inserts somebody else’s turn where the service has it, attributed to them', () => {
    // Alice's browser: her own two turns, sent live — no author, ids from the response header.
    const local: ChatMessage[] = [
      question('q1', 'Rank the solvents.'),
      answer('a1', 'Toluene first.', { correlationId: 'turn-a1' }),
      question('q2', 'And the temperature?'),
      answer('a2', '80 °C.', { correlationId: 'turn-a2' }),
    ];
    const merged = mergeTranscript(local, remote);
    expect(merged && texts(merged)).toEqual([
      'Q:Rank the solvents.',
      'A:Toluene first.',
      'Q:Which base?',
      'A:Cs2CO3.',
      'Q:And the temperature?',
      'A:80 °C.',
    ]);
    // Bob's question carries Bob, which is what the bubble labels it with.
    const bobs = merged?.find((m) => m.role === 'user' && m.text === 'Which base?');
    expect(bobs?.role === 'user' && bobs.author).toBe(BOB);
  });

  it('never trades a turn this browser holds for its stored copy', () => {
    const mine = answer('a1', 'Toluene first.', { correlationId: 'turn-a1', confidence: 0.93 });
    const merged = mergeTranscript(
      [question('q1', 'Rank the solvents.'), mine],
      remote.slice(0, 2),
    );
    // Nothing new: no write at all.
    expect(merged).toBeNull();

    const grown = mergeTranscript([question('q1', 'Rank the solvents.'), mine], remote);
    // The same object — confidence, verifier and all — not the transcript's projection of it.
    expect(grown?.find((m) => m.id === 'a1')).toBe(mine);
  });

  it('matches on the turn’s id before the question’s words', () => {
    // The stored question differs from what this browser shows (the service framed it), and the
    // ids still say it is the same turn: no duplicate.
    const local: ChatMessage[] = [
      question('q1', 'Rank the solvents, please'),
      answer('a1', 'Toluene first.', { correlationId: 'turn-a1' }),
    ];
    expect(mergeTranscript(local, remote.slice(0, 2))).toBeNull();
  });

  it('matches on the words when no id is known, and keeps repeated questions in order', () => {
    const rows = transcriptToMessages([
      stored(0, 'user', 'Again?', ALICE, null),
      stored(1, 'assistant', 'One.', ALICE, null),
      stored(2, 'user', 'Again?', BOB, null),
      stored(3, 'assistant', 'Two.', BOB, null),
    ]);
    const merged = mergeTranscript([question('q1', 'Again?'), answer('a1', 'One.')], rows);
    expect(merged && texts(merged)).toEqual(['Q:Again?', 'A:One.', 'Q:Again?', 'A:Two.']);
  });

  it('keeps a turn this browser is streaming, after the turns that landed before it', () => {
    const streaming = answer('live', '', {
      status: 'streaming',
      finalText: null,
      streamedText: 'Partial',
      queuePlace: { ticket: 4, position: 0 },
    });
    const local: ChatMessage[] = [
      question('q1', 'Rank the solvents.'),
      answer('a1', 'Toluene first.', { correlationId: 'turn-a1' }),
      question('mine', 'Is it dry?'),
      streaming,
    ];
    const merged = mergeTranscript(local, remote.slice(0, 4));
    expect(merged && texts(merged)).toEqual([
      'Q:Rank the solvents.',
      'A:Toluene first.',
      'Q:Which base?',
      'A:Cs2CO3.',
      'Q:Is it dry?',
      'A:Partial',
    ]);
    // Identity, so `updateAssistant` keeps finding it by id and its tokens keep landing.
    expect(merged?.at(-1)).toBe(streaming);
  });

  it('folds a stored turn’s steps into one answer', () => {
    const rows = transcriptToMessages([
      stored(0, 'user', 'Screen it.', BOB, 'turn-b'),
      stored(1, 'assistant', '', BOB, 'turn-b', [
        { tool: 'screen_hazards', arguments: '{}', result: 'ok' },
      ]),
      stored(2, 'assistant', 'No hazards found.', BOB, 'turn-b'),
    ]);
    const merged = mergeTranscript([question('q0', 'Hello'), answer('a0', 'Hi.')], rows);
    const answers = merged?.filter((m) => m.role === 'assistant') ?? [];
    expect(answers).toHaveLength(2);
    // Inserted ahead of the local turn the service does not hold — see the streaming case above.
    const folded = answers[0] as AssistantMessage;
    expect(folded.finalText).toBe('No hazards found.');
    expect(folded.trace.map((t) => t.toolCall?.tool)).toEqual(['screen_hazards']);
  });

  it('replaces a finished watched placeholder once its exchange arrives, and not before', () => {
    const local: ChatMessage[] = [
      question('q1', 'Rank the solvents.'),
      answer('a1', 'Toluene first.', { correlationId: 'turn-a1' }),
      answer('w', 'Cs2CO3.', { watched: true, confidence: null }),
    ];
    // The service has not written it yet: the placeholder is the only copy on screen.
    expect(mergeTranscript(local, remote.slice(0, 2))).toBeNull();

    const merged = mergeTranscript(local, remote.slice(0, 4));
    expect(merged && texts(merged)).toEqual([
      'Q:Rank the solvents.',
      'A:Toluene first.',
      'Q:Which base?',
      'A:Cs2CO3.',
    ]);
  });

  it('keeps a watched placeholder that is still streaming', () => {
    const live = answer('w', '', { watched: true, status: 'streaming', finalText: null });
    const merged = mergeTranscript(
      [
        question('q1', 'Rank the solvents.'),
        answer('a1', 'Toluene first.', { correlationId: 'turn-a1' }),
        live,
      ],
      remote.slice(0, 4),
    );
    expect(merged?.at(-1)).toBe(live);
  });

  it('never gives an inserted message an id the conversation already uses', () => {
    const local: ChatMessage[] = [question('r:turn-b1:q', 'Unrelated'), answer('x', 'Sure.')];
    const merged = mergeTranscript(local, remote) ?? [];
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length);
  });
});

/* ------------------------------------------------------------------ following */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A watch stream that sends `events` and holds the connection open until `close()`. */
function holdingStream(events: ChemclawEvent[]): {
  response: Response;
  send: (more: ChemclawEvent[]) => void;
  close: () => void;
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(new TextEncoder().encode(sseFrames(events)));
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (more) => controllerRef?.enqueue(new TextEncoder().encode(sseFrames(more))),
    close: () => {
      try {
        controllerRef?.close();
      } catch {
        // Already closed by an abort.
      }
    },
  };
}

async function until(ready: () => boolean, what: string, deadlineMs = 5_000): Promise<void> {
  const stopAt = Date.now() + deadlineMs;
  while (!ready()) {
    if (Date.now() > stopAt) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const messagesOf = (cid: string): ChatMessage[] =>
  useChatStore.getState().conversations[cid]?.messages ?? [];

/** Alice's own conversation: one turn of hers, already on screen. */
function alicesConversation(): string {
  const cid = useChatStore.getState().createConversation();
  useChatStore.getState().setSessionId(cid, SID);
  const store = useChatStore.getState();
  store.appendUserMessage(cid, 'Rank the solvents.');
  const a = store.startAssistantMessage(cid);
  store.setCorrelationId(cid, a, 'turn-a1');
  store.applyEvent(cid, a, answerEvent({ text: 'Toluene first.' }));
  store.finishTurn(cid, a, 'done');
  return cid;
}

const ALICE_TURN = [
  stored(0, 'user', 'Rank the solvents.', ALICE, 'turn-a1'),
  stored(1, 'assistant', 'Toluene first.', ALICE, 'turn-a1'),
];
const BOB_TURN = [
  stored(2, 'user', 'Which base?', BOB, 'turn-b1'),
  stored(3, 'assistant', 'Cs2CO3 in 2-MeTHF.', BOB, 'turn-b1'),
];

let restore: (() => void) | null = null;
let stop: (() => void) | null = null;

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
  stop?.();
  stop = null;
  restore?.();
  restore = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('followSharedConversation', () => {
  it('re-reads the transcript on open and shows the turn somebody else took', async () => {
    const cid = alicesConversation();
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json([...ALICE_TURN, ...BOB_TURN]);
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: false, waiting: [] });
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    await until(() => messagesOf(cid).length === 4, 'Bob’s turn to be merged in');
    expect(texts(messagesOf(cid))).toEqual([
      'Q:Rank the solvents.',
      'A:Toluene first.',
      'Q:Which base?',
      'A:Cs2CO3 in 2-MeTHF.',
    ]);
    const bobs = messagesOf(cid)[2];
    expect(bobs?.role === 'user' && bobs.author).toBe(BOB);
  });

  it('follows somebody else’s running turn live, then replaces it with the stored exchange', async () => {
    const cid = alicesConversation();
    let saved = false;
    const turn = holdingStream([{ type: 'token', text: 'Cs2CO3' } as ChemclawEvent]);
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) {
        return json(saved ? [...ALICE_TURN, ...BOB_TURN] : ALICE_TURN);
      }
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: !saved, waiting: [] });
      if (url.endsWith(`/sessions/${SID}/turn/stream`)) return turn.response;
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    // The placeholder opens as an answer, streaming, and marked as somebody else's.
    await until(
      () => messagesOf(cid).some((m) => m.role === 'assistant' && m.watched),
      'the watched turn to open',
    );
    await until(() => {
      const w = messagesOf(cid).at(-1);
      return w?.role === 'assistant' && w.streamedText === 'Cs2CO3';
    }, 'the watched tokens');
    expect(useChatStore.getState().streaming).toBeNull();
    expect(useChatStore.getState().composerLock).toBe(false);

    // The turn ends and its exchange is stored: the placeholder becomes Bob's question and answer —
    // still one answer on the page, not two.
    saved = true;
    turn.send([answerEvent({ text: 'Cs2CO3 in 2-MeTHF.' })]);
    turn.close();
    await until(() => messagesOf(cid).length === 4, 'the stored exchange');
    expect(texts(messagesOf(cid))).toEqual([
      'Q:Rank the solvents.',
      'A:Toluene first.',
      'Q:Which base?',
      'A:Cs2CO3 in 2-MeTHF.',
    ]);
    expect(stub.calls.filter((c) => c.url.endsWith('/turn/stream'))).toHaveLength(1);
  });

  it('does not watch while this browser’s own turn is running there', async () => {
    const cid = alicesConversation();
    useChatStore.getState().setStreaming({
      conversationId: cid,
      messageId: 'mine',
      abort: new AbortController(),
      stop: () => undefined,
      abandon: () => undefined,
    });
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: true, waiting: [] });
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    await until(() => stub.calls.some((c) => c.url.endsWith('/queue')), 'the line to be read');
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.calls.some((c) => c.url.endsWith('/turn/stream'))).toBe(false);
  });

  it('re-reads when this browser’s own turn there ends', async () => {
    const cid = alicesConversation();
    const slot = {
      conversationId: cid,
      messageId: 'mine',
      abort: new AbortController(),
      stop: () => undefined,
      abandon: () => undefined,
    };
    useChatStore.getState().setStreaming(slot);
    let reads = 0;
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) {
        reads += 1;
        return json(reads > 1 ? [...ALICE_TURN, ...BOB_TURN] : ALICE_TURN);
      }
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: false, waiting: [] });
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    await until(() => reads === 1, 'the read on open');
    useChatStore.getState().setStreaming(null);
    await until(() => messagesOf(cid).length === 4, 'the read after the turn');
  });

  it('stands down on a 429 rather than retrying the watch on every tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cid = alicesConversation();
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: true, waiting: [] });
      if (url.endsWith(`/sessions/${SID}/turn/stream`)) {
        return new Response(JSON.stringify({ detail: 'too many concurrent event streams' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;
    const watches = (): number => stub.calls.filter((c) => c.url.endsWith('/turn/stream')).length;

    stop = followSharedConversation(cid, auth);
    await vi.advanceTimersByTimeAsync(50);
    expect(watches()).toBe(1);
    // No empty answer flashed into the transcript for a view that never opened.
    expect(messagesOf(cid).some((m) => m.role === 'assistant' && m.watched)).toBe(false);
    // Two more ticks of the line, inside the stand-down: no second attempt.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watches()).toBe(1);
    // Past it, the next tick tries again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watches()).toBe(2);
  });

  it('stops asking when the line route is not there', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cid = alicesConversation();
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
      return jsonError(404, 'Not Found');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.calls.filter((c) => c.url.endsWith('/queue'))).toHaveLength(1);
  });

  it('asks the line at the cadence the deployment served, not a built-in one', async () => {
    // `SHARED_POLL_MS`, through `/config.js`. The browser suite relies on it to follow a turn as it
    // starts rather than racing the 5 s default against its own assertion timeout.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const served = config.sharedPollMs;
    config.sharedPollMs = 1_000;
    try {
      const cid = alicesConversation();
      const stub = stubFetch((url) => {
        if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
        if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: false, waiting: [] });
        return jsonError(404, 'unexpected');
      });
      restore = stub.restore;
      const asked = (): number => stub.calls.filter((c) => c.url.endsWith('/queue')).length;

      stop = followSharedConversation(cid, auth);
      await vi.advanceTimersByTimeAsync(50);
      expect(asked()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asked()).toBe(2);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(asked()).toBe(5);
    } finally {
      config.sharedPollMs = served;
    }
  });

  it('asks the line every five seconds by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(config.sharedPollMs).toBe(5_000);
    const cid = alicesConversation();
    const stub = stubFetch((url) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: false, waiting: [] });
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;
    const asked = (): number => stub.calls.filter((c) => c.url.endsWith('/queue')).length;

    stop = followSharedConversation(cid, auth);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(asked()).toBe(2);
  });

  it('closes the watch and removes its placeholder when the conversation is closed', async () => {
    const cid = alicesConversation();
    const turn = holdingStream([{ type: 'token', text: 'Working' } as ChemclawEvent]);
    const stub = stubFetch((url, init) => {
      if (url.endsWith(`/sessions/${SID}/messages`)) return json(ALICE_TURN);
      if (url.endsWith(`/sessions/${SID}/queue`)) return json({ running: true, waiting: [] });
      if (url.endsWith(`/sessions/${SID}/turn/stream`)) {
        init?.signal?.addEventListener('abort', () => turn.close());
        return turn.response;
      }
      return jsonError(404, 'unexpected');
    });
    restore = stub.restore;

    stop = followSharedConversation(cid, auth);
    await until(
      () => messagesOf(cid).some((m) => m.role === 'assistant' && m.watched),
      'the watched turn to open',
    );
    const signal = stub.calls.find((c) => c.url.endsWith('/turn/stream'))?.init?.signal;
    stop();
    stop = null;
    expect(signal?.aborted).toBe(true);
    expect(messagesOf(cid).some((m) => m.role === 'assistant' && m.watched)).toBe(false);
  });

  it('never persists a watched turn', () => {
    const cid = alicesConversation();
    useChatStore.getState().startWatchedTurn(cid);
    const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState()) as {
      conversations: Record<string, { messages: ChatMessage[] }>;
    };
    const kept = persisted.conversations[cid]?.messages ?? [];
    expect(kept).toHaveLength(2);
    expect(kept.some((m) => m.role === 'assistant' && m.watched)).toBe(false);
  });
});
