/**
 * One payload is parsed once, not once per trace mutation.
 *
 * `ResultBlock` parsed `result.text` and walked the renderer registry **in its render body**, and
 * the memoisation around it is exactly what made that look free: `Bubble` is memoised, and
 * `ResultBlocks` is memoised on the trace array, so the block does not re-render per token. It
 * re-renders per *trace mutation* — every tool call, every stored result, every plan revision,
 * every job event — and each of those re-ran `JSON.parse` plus `rendererFor` over the whole
 * payload, for an identical answer.
 *
 * This is the measurement that established that, kept as an assertion. It drives the real store
 * with the events a turn actually produces, each in its own flush because SSE frames arrive in
 * separate tasks and React does not batch across them. Before the `useMemo`, a 4.6 kB result was
 * parsed **15 times** over an eight-step turn; after it, once.
 *
 * **The saving is small and the test is not about the saving.** One parse plus a dispatch measures
 * 0.07 ms at 3 kB and 1.75 ms at 140 kB, so the turn above was losing ~1 ms — the point is that the
 * cost is per mutation over a payload with no bound, and that a component whose render body does
 * work proportional to its input will keep being read as free by the next person who measures the
 * memo around it rather than the body inside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MessageList } from '../src/components/MessageList.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { toolResultEvent } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);

/** A hazard screen big enough to be worth not re-parsing — 4.6 kB, well under the inline cap. */
const PAYLOAD = JSON.stringify({
  verdict: '20 hazard rule(s) matched (most serious: high).',
  screened: ['CCN=[N+]=[N-]'],
  flags: Array.from({ length: 20 }, (_, i) => ({
    rule_id: `organic-azide-${i}`,
    severity: 'high',
    explanation: 'Low carbon-to-nitrogen ratio; shock sensitive on concentration.',
    citation: 'Bretherick’s Handbook of Reactive Chemical Hazards, 7th ed.',
    matched: 'CCN=[N+]=[N-]',
  })),
});

const realParse = JSON.parse;
let parses = 0;

beforeEach(() => {
  cleanup();
  parses = 0;
  useChatStore.setState({ conversations: {}, order: [], activeId: null, jobFeed: [] });
  // Counted by identity of the text, so nothing else the app parses in the same tick — the store's
  // own event payloads, a fetch body — is mistaken for this block's work.
  JSON.parse = ((text: string, reviver?: never) => {
    if (text === PAYLOAD) parses += 1;
    return realParse(text, reviver);
  }) as typeof JSON.parse;
});

afterEach(() => {
  JSON.parse = realParse;
  cleanup();
});

describe('a result block during a long turn', () => {
  it('parses its payload once, however many events the turn goes on to produce', async () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    useChatStore.setState((s) => ({
      conversations: {
        ...s.conversations,
        [cid]: { ...s.conversations[cid]!, sessionId: SID, sessionOrigin: 'local' },
      },
    }));
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, {
      type: 'tool_call',
      tool: 'screen_hazards',
      arguments: '{}',
      agent: '',
    });
    // Inline, so the block draws with no fetch: the parse is the only work under test.
    store.applyEvent(
      cid,
      mid,
      toolResultEvent({ tool: 'screen_hazards', preview: '{"flags"', result_inline: PAYLOAD }),
    );

    render(<MessageList conversationId={cid} />);
    await screen.findByText('organic-azide-0');
    expect(parses).toBe(1);

    // The turn continues for seven more steps. Each event is its own flush, because that is how
    // they arrive: one SSE frame, one task, one render.
    for (let i = 0; i < 7; i += 1) {
      await act(async () => {
        store.applyEvent(cid, mid, {
          type: 'tool_call',
          tool: 'lookup_solvent_properties',
          arguments: '{}',
          agent: '',
        });
      });
      await act(async () => {
        store.applyEvent(cid, mid, {
          type: 'plan',
          todos: [`[x] step ${i}`, '[ ] next'],
          plan_hash: `hash-${i}`,
        });
      });
    }
    await act(async () => {
      store.finishTurn(cid, mid, 'done');
    });

    // 15 without the memo — one per mutation — and the table on screen is the same table.
    expect(parses).toBe(1);
    expect(screen.getByText('organic-azide-0')).toBeTruthy();
  });
});
