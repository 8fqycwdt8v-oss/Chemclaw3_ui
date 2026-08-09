/**
 * The live region announces transitions, and never the answer itself.
 *
 * This exists because the region shipped once already as a mounted, documented, completely inert
 * component: `announceStatus` had no call sites, so `role="status"` rendered empty for the app's
 * whole lifetime while three comments claimed otherwise. A test that only checked the region was
 * present would have passed.
 *
 * The second assertion is the one that keeps the design honest. Streaming text must NOT reach the
 * live region: at one mutation per animation frame a screen reader queues every mutation and reads
 * the answer from the top, over and over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceStatus, describeAnswer, registerAnnouncer } from '../src/state/announce.ts';
import { sendMessage, stopStreaming } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { sseFrames, sseResponse, stubFetch } from './helpers.ts';

const auth = {
  mode: 'dev' as const,
  account: null,
  getAccessToken: async () => null,
  login: async () => {},
  logout: async () => {},
  handleUnauthorized: async () => false,
};

let announced: string[];
let dispose: () => void;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  announced = [];
  dispose = registerAnnouncer((m) => announced.push(m));
  useChatStore.setState({
    conversations: {
      c1: {
        id: 'c1',
        sessionId: 'a'.repeat(32),
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
  dispose();
  restoreFetch?.();
  restoreFetch = null;
  vi.restoreAllMocks();
});

describe('announcements', () => {
  it('is a no-op when no region is mounted', () => {
    dispose();
    expect(() => announceStatus('nobody is listening')).not.toThrow();
  });

  it('counts words for the completion sentence', () => {
    expect(describeAnswer('The pKa is 4.76.')).toBe('Answer complete, 4 words.');
    expect(describeAnswer('  Yes  ')).toBe('Answer complete, 1 word.');
  });

  it('announces completion once, and never the answer text', async () => {
    const stub = stubFetch(() =>
      sseResponse(
        sseFrames([
          { type: 'token', text: 'The pKa ' },
          { type: 'token', text: 'is 4.76.' },
          { type: 'answer', text: 'The pKa is 4.76.' },
        ] as never),
      ),
    );
    restoreFetch = stub.restore;

    await sendMessage({ conversationId: 'c1', text: 'pKa?', auth });

    expect(announced).toEqual(['Answer complete, 4 words.']);
    // The decisive one: no fragment of the streamed answer went through the polite region.
    expect(announced.join(' ')).not.toContain('The pKa');
  });

  it('announces a queued turn, because silence and a hang are indistinguishable', async () => {
    const stub = stubFetch(() =>
      sseResponse(
        sseFrames([
          { type: 'queued', position: 2 },
          { type: 'answer', text: 'Done.' },
        ] as never),
      ),
    );
    restoreFetch = stub.restore;

    await sendMessage({ conversationId: 'c1', text: 'pKa?', auth });

    expect(announced[0]).toBe('Waiting for a free slot on the server.');
  });

  it('announces a stop', async () => {
    // A request that never answers, so Stop is what ends it. Rejecting the fetch on abort is what
    // a real fetch does; the mid-stream variant of the same path is covered in streamTurn.test.ts,
    // and what is under test here is the announcement, not the plumbing.
    const stub = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    restoreFetch = stub.restore;

    const turn = sendMessage({ conversationId: 'c1', text: 'pKa?', auth });
    // Let the request reach the stub and register its abort listener before stopping.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useChatStore.getState().streaming).not.toBeNull();

    stopStreaming();
    await turn;

    expect(announced).toContain('Stopped before the answer was complete.');
  });

  it('does not announce a failure — the banner carries role="alert" for that', async () => {
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'at capacity' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    restoreFetch = stub.restore;

    await sendMessage({ conversationId: 'c1', text: 'pKa?', auth });

    expect(useChatStore.getState().banner?.text).toContain('capacity');
    // Announcing here too would read the same sentence twice.
    expect(announced).toEqual([]);
  });
});
