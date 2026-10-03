/**
 * A reload mid-turn reattaches to the turn rather than polling for it (Chemclaw3_ui#131, D5).
 *
 * Found by a real-browser run on kind: the unloading page's stop killed the turn, and the reloaded
 * page then polled an empty transcript for 630 s. The unload stop now asks the service to wait
 * (`turnAbandon.test.ts`), and the reloaded page comes back through
 * `GET /sessions/{id}/turn/stream`, which is what cancels that wait. These pin the reloaded half:
 *
 *   1. its own turn is followed live, and the answer arrives on the stream — no transcript poll;
 *   2. another participant's turn running in its place is never rendered under this question;
 *   3. a turn that is gone gets a short, bounded read and then an honest "could not be recovered",
 *      not ten minutes of "interrupted";
 *   4. Stop on a followed turn is an ordinary, immediate stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeInterruptedTurn } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import type { AssistantMessage } from '../src/state/types.ts';
import { answerEvent, jsonError, sseFrames, stubFetch, toolResultEvent } from './helpers.ts';

const SESSION = 'r'.repeat(32);
const OURS = 'c'.repeat(32);
const QUESTION = 'what is the pKa of acetic acid';

const auth = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => {},
  logout: async () => {},
  handleUnauthorized: async () => false,
} as unknown as AuthProvider;

let restore: (() => void) | null = null;

/** What `partialize` leaves behind for a turn a reload cut off, with the id its POST carried. */
function interrupted(): { cid: string; mid: string } {
  const store = useChatStore.getState();
  const cid = store.createConversation();
  store.setSessionId(cid, SESSION);
  store.appendUserMessage(cid, QUESTION);
  const mid = store.startAssistantMessage(cid);
  store.setCorrelationId(cid, mid, OURS);
  useChatStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [cid]: {
        ...s.conversations[cid]!,
        messages: s.conversations[cid]!.messages.map((m) =>
          m.id === mid
            ? {
                ...m,
                status: 'aborted' as const,
                interruptedByReload: true as const,
                error: { kind: 'stream' as const, message: 'Interrupted by a page reload.' },
              }
            : m,
        ),
      },
    },
  }));
  return { cid, mid };
}

const message = (cid: string, mid: string): AssistantMessage => {
  const found = useChatStore.getState().conversations[cid]?.messages.find((m) => m.id === mid);
  if (!found || found.role !== 'assistant') throw new Error('no such assistant message');
  return found;
};

/**
 * A watch response: the turn it names, then `frames`, then (unless `open`) the end of the turn.
 *
 * Its body ends when the request is aborted, as a browser's does (there it errors; happy-dom does
 * not carry an error across its `Response`, so this closes) — a stub that ignored the signal would
 * hang a follow that a real page's Stop ends.
 */
function watchResponse(
  turn: string,
  frames: string,
  { open = false, signal }: { open?: boolean; signal?: AbortSignal | null } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Already closed: the turn had ended.
          }
        });
        controller.enqueue(new TextEncoder().encode(frames));
        if (!open) controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-chemclaw-correlation-id': 'w'.repeat(32), // the watch request's own id, never the turn's
        ...(turn ? { 'x-chemclaw-turn-correlation-id': turn } : {}),
      },
    },
  );
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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
  useChatStore.getState().streaming?.abort.abort();
  restore?.();
  restore = null;
  vi.useRealTimers();
});

describe('a reload mid-turn', () => {
  it('reattaches to its own turn and shows the answer the stream delivers', async () => {
    const { cid, mid } = interrupted();
    const stub = stubFetch((url, init) =>
      url.endsWith('/turn/stream')
        ? watchResponse(
            OURS,
            sseFrames([
              { type: 'tool_call', tool: 'gather_evidence', arguments: '{}', agent: '' },
              { type: 'token', text: 'tail of the answer' },
              answerEvent({ text: '4.76 in water at 25 °C.' }),
            ]),
            { signal: init?.signal },
          )
        : jsonError(500, 'nothing else should be asked'),
    );
    restore = stub.restore;

    resumeInterruptedTurn(cid, auth);
    await vi.waitFor(() => expect(message(cid, mid).status).toBe('done'));

    expect(message(cid, mid).finalText).toBe('4.76 in water at 25 °C.');
    expect(message(cid, mid).interruptedByReload).toBe(false);
    // The turn rendered as it ran, not only its ending.
    expect(message(cid, mid).trace.some((step) => step.kind === 'tool_call')).toBe(true);
    // The watch tail is not spliced onto the pre-reload text: the answer is the whole text.
    expect(message(cid, mid).streamedText).toBe('');
    // Live, not polled: the transcript was never read.
    expect(stub.calls.map((c) => c.url)).toEqual([
      expect.stringMatching(new RegExp(`/sessions/${SESSION}/turn/stream$`)),
    ]);
    expect(useChatStore.getState().streaming).toBeNull();
    expect(useChatStore.getState().composerLock).toBe(false);
  });

  it('holds the composer and the Stop control while the turn it follows is running', async () => {
    const { cid, mid } = interrupted();
    const stub = stubFetch((url, init) =>
      url.endsWith('/turn/stream')
        ? watchResponse(OURS, sseFrames([toolResultEvent()]), { open: true, signal: init?.signal })
        : json({ stopped: true }),
    );
    restore = stub.restore;

    resumeInterruptedTurn(cid, auth);
    await vi.waitFor(() =>
      expect(stub.calls.some((c) => c.url.endsWith('/turn/stream'))).toBe(true),
    );
    expect(message(cid, mid).status).toBe('streaming');
    expect(useChatStore.getState().streaming?.messageId).toBe(mid);
    expect(useChatStore.getState().composerLock).toBe('turn_in_flight');

    useChatStore.getState().streaming?.stop();
    await vi.waitFor(() => expect(message(cid, mid).status).toBe('aborted'));

    // An ordinary Stop: immediate, so no unload reason.
    const stop = stub.calls.find((c) => c.url.includes('/turn/stop'));
    expect(stop?.url).toMatch(/\/turn\/stop$/);
    expect(message(cid, mid).interruptedByReload).toBe(false);
    expect(useChatStore.getState().streaming).toBeNull();
    expect(useChatStore.getState().composerLock).toBe(false);
  });

  it('a second reload while following sends the same deferred unload stop', async () => {
    const { cid, mid } = interrupted();
    const stub = stubFetch((url, init) =>
      url.endsWith('/turn/stream')
        ? watchResponse(OURS, sseFrames([toolResultEvent()]), { open: true, signal: init?.signal })
        : json({ stopped: false, deferred: true }),
    );
    restore = stub.restore;

    resumeInterruptedTurn(cid, auth);
    await vi.waitFor(() => expect(useChatStore.getState().streaming?.messageId).toBe(mid));
    useChatStore.getState().streaming?.abandon();
    await vi.waitFor(() =>
      expect(stub.calls.some((c) => c.url.endsWith('/turn/stop?reason=unload'))).toBe(true),
    );
    const stop = stub.calls.find((c) => c.url.endsWith('/turn/stop?reason=unload'));
    expect(stop?.init?.keepalive).toBe(true);
  });

  it("never renders another participant's turn under this question", async () => {
    vi.useFakeTimers();
    const { cid, mid } = interrupted();
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/turn/stream')) {
        // Somebody else's turn, started after ours ended: its answer must not land here.
        return watchResponse('d'.repeat(32), sseFrames([answerEvent({ text: 'their answer' })]), {
          signal: init?.signal,
        });
      }
      return json([
        { index: 0, role: 'user', text: QUESTION, tool_calls: [] },
        {
          index: 1,
          role: 'assistant',
          text: '4.76 in water at 25 °C.',
          tool_calls: [],
          correlation_id: OURS,
        },
      ]);
    });
    restore = stub.restore;

    resumeInterruptedTurn(cid, auth);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(message(cid, mid).finalText).toBe('4.76 in water at 25 °C.');
  });

  it('gives a turn that is gone a short read and then says the answer is lost', async () => {
    vi.useFakeTimers();
    const { cid, mid } = interrupted();
    const stub = stubFetch((url) =>
      url.endsWith('/turn/stream')
        ? jsonError(404, 'no turn is running for this session')
        : // A service that stopped the turn on unload: the transcript never gets its answer.
          json([{ index: 0, role: 'user', text: QUESTION, tool_calls: [] }]),
    );
    restore = stub.restore;

    resumeInterruptedTurn(cid, auth);
    // The live path's budget is 630 s. This one is the bound a turn that is over deserves.
    await vi.advanceTimersByTimeAsync(30_000);

    const settled = message(cid, mid);
    expect(settled.interruptedByReload).toBe(false);
    expect(settled.error?.message).toMatch(/could not be recovered/);
    const reads = stub.calls.filter((c) => c.url.endsWith('/messages')).length;
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(10);
  });
});
