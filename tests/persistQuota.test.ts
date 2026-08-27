/**
 * A full `localStorage` must not take Send with it.
 *
 * zustand's `persist` re-serialises the whole persisted slice on *every* store write — including
 * each animation-frame token flush — and `createJSONStorage(() => localStorage)` lets a failed
 * write throw straight back out of the action that caused it. `sendMessage` calls
 * `appendUserMessage` before its try/catch, so once the kept history reaches the ~5 MB per-origin
 * quota the throw escapes as an unhandled rejection: no user bubble, no assistant message, no
 * banner, no composer lock. Send does nothing, for ever, with the only diagnostic in the console.
 *
 * Measured before the fix (30 kept conversations of 20 turns each, a 3 kB answer and 6 tool calls
 * per turn): 4.24 MB persisted, and `messages` never pruned at all — 500 sends persisted 500
 * messages. So both halves are asserted here: a write that fails is survivable, and the payload
 * that makes it fail is bounded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushChatPersistence, useChatStore } from '../src/state/chatStore.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { answerEvent, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const devAuth: AuthProvider = {
  mode: 'dev',
  account: null,
  getAccessToken: async () => null,
  login: async () => undefined,
  logout: async () => undefined,
  handleUnauthorized: async () => false,
};

const ANSWER = sseFrames([{ type: 'token', text: 'ok' }, answerEvent({ text: 'ok' })]);

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;

const reset = (): void => {
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
};

beforeEach(reset);

afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reset();
});

/** What the persist middleware would actually write, for the state as it stands. */
const persisted = (): { conversations: Record<string, { messages: unknown[] }> } => {
  const partialize = useChatStore.persist.getOptions().partialize;
  if (!partialize) throw new Error('the store has no partialize');
  return partialize(useChatStore.getState()) as never;
};

/** A `localStorage` whose every write is refused, which is what a full origin looks like. */
const fullStorage = {
  getItem: () => null,
  setItem: () => {
    // Exactly what a browser throws once the origin's quota is spent. The name matters: this is
    // reachable by using the app for a few months, not a broken environment.
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  },
  removeItem: () => undefined,
};

describe('a localStorage write that cannot succeed', () => {
  it('does not stop Send from working', async () => {
    // Fresh module graph with the full storage already in place: `persist` resolves its storage
    // once, at import, so patching afterwards would test a different program.
    vi.resetModules();
    vi.stubGlobal('localStorage', fullStorage);
    const { useChatStore: store } = await import('../src/state/chatStore.ts');
    const { sendMessage: send } = await import('../src/state/sendMessage.ts');

    const stub = stubFetch((url, init) => {
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session_id: SESSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse(ANSWER);
    });
    restore = stub.restore;

    const cid = store.getState().createConversation();

    await expect(
      send({ conversationId: cid, text: 'what is the pKa of this?', auth: devAuth }),
    ).resolves.toBeUndefined();

    const conversation = store.getState().conversations[cid];
    // The user's question, and the answer that came back for it.
    expect(conversation?.messages).toHaveLength(2);
    expect(store.getState().composerLock).toBe(false);
    expect(store.getState().banner).toBeNull();
  });
});

describe('the persisted payload', () => {
  it('bounds one conversation’s transcript instead of growing for ever', () => {
    const cid = useChatStore.getState().createConversation();
    for (let i = 0; i < 500; i += 1) {
      useChatStore.getState().appendUserMessage(cid, `question ${i}`);
    }

    expect(useChatStore.getState().conversations[cid]?.messages).toHaveLength(500);
    // Measured before the fix: 500. Nothing pruned `messages` at all.
    expect(persisted().conversations[cid]?.messages.length).toBeLessThanOrEqual(200);
  });

  it('sheds the oldest conversations rather than losing the write', () => {
    // A storage with a real budget, so the failure is the one a browser produces: the write is
    // refused, the previous value survives, and only a smaller payload can land.
    const BUDGET = 20_000;
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > BUDGET) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal('localStorage', fake);

    const filler = 'x'.repeat(2_000);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = useChatStore.getState().createConversation();
      ids.push(id);
      useChatStore.getState().appendUserMessage(id, `${filler} ${i}`);
    }
    // The disk write is throttled now (only the first of this burst lands synchronously); force
    // the trailing write of the final state out before inspecting what actually persisted.
    flushChatPersistence();

    const written = store.get('chemclaw3.chat.v2');
    expect(written).toBeDefined();
    expect(written?.length).toBeLessThanOrEqual(BUDGET);
    // The newest conversation is the one the chemist is looking at, so it is the one that must
    // survive; the oldest are what gets dropped.
    expect(written).toContain(ids[ids.length - 1] as string);
    expect(written).not.toContain(ids[0] as string);
  });
});
