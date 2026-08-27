/**
 * The data reaches the answer, and it costs what it says it costs.
 *
 * Two properties are load-bearing here and neither is visible in the markup.
 *
 * **The block fetches once.** It is a speculative read the reader never asked for, so a version
 * that re-requests on every render turns one turn into dozens of requests against the service.
 * The first shape of this component did exactly that in reverse — `state.status` in the effect's
 * dependency list meant the effect's own cleanup cancelled the fetch it had just started, the 200
 * came back, and the block rendered nothing for ever while looking entirely correct.
 *
 * **The cap is real.** Every block is a request, so the transcript renders at most a few and says
 * how many it did not — a silent truncation would read as "that is all the turn stored".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MessageList } from '../src/components/MessageList.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { toolResultEvent, stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = (n: number): string => String(n).repeat(64).slice(0, 64);

const HAZARD = JSON.stringify({
  verdict: '1 hazard rule(s) matched (most serious: high).',
  screened: ['CCN=[N+]=[N-]'],
  flags: [
    {
      rule_id: 'organic-azide',
      severity: 'high',
      explanation: 'Low carbon-to-nitrogen ratio.',
      citation: 'Bretherick’s, 7th ed.',
      matched: 'CCN=[N+]=[N-]',
    },
  ],
});

let restore: (() => void) | null = null;
let calls: string[];

/**
 * An `IntersectionObserver` that reports its target as visible.
 *
 * happy-dom defines the constructor and never fires it, and it has no layout to fire it from, so a
 * lazily-fetched block would sit in its anchor state for ever here — a false green that would let
 * the whole feature ship broken. Stubbing the observer says "the reader scrolled to it", which is
 * the condition under test; the laziness itself is exercised by the browser tier.
 */
class ImmediateObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** A conversation with one assistant turn that made `count` stored tool calls. */
function seed(count: number, sessionId: string | null = SID): string {
  const store = useChatStore.getState();
  const cid = store.createConversation();
  useChatStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [cid]: { ...s.conversations[cid]!, sessionId, sessionOrigin: 'local' },
    },
  }));
  const mid = store.startAssistantMessage(cid);
  for (let i = 0; i < count; i += 1) {
    store.applyEvent(cid, mid, {
      type: 'tool_call',
      tool: 'screen_hazards',
      arguments: '{}',
      agent: '',
    });
    store.applyEvent(
      cid,
      mid,
      toolResultEvent({ tool: 'screen_hazards', preview: '{"flags"', result_ref: REF(i + 1) }),
    );
  }
  store.finishTurn(cid, mid, 'done');
  return cid;
}

beforeEach(() => {
  cleanup();
  vi.stubGlobal('IntersectionObserver', ImmediateObserver);
  calls = [];
  useChatStore.setState({ conversations: {}, order: [], activeId: null, jobFeed: [] });
  const stub = stubFetch((url) => {
    calls.push(url);
    return new Response(
      JSON.stringify({
        tool: 'screen_hazards',
        text: HAZARD,
        byte_size: HAZARD.length,
        correlation_id: 'turn-1',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  restore = stub.restore;
});

afterEach(() => {
  restore?.();
  restore = null;
  vi.unstubAllGlobals();
  cleanup();
});

describe('a stored result becomes a block in the answer', () => {
  it('renders the table the answer was written from', async () => {
    render(<MessageList conversationId={seed(1)} />);

    // The severity, the rule and its citation — the three the 200-character preview cut off.
    expect(await screen.findByText('organic-azide')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('Bretherick’s, 7th ed.')).toBeTruthy();
  });

  it('renders the service’s own verdict above the data', async () => {
    render(<MessageList conversationId={seed(1)} />);
    // An empty table reads as "nothing found" unless the sentence above it says otherwise, so the
    // verdict is the block's first line whatever the renderer draws underneath.
    expect(await screen.findByText(/1 hazard rule\(s\) matched/)).toBeTruthy();
  });

  it('asks for each result exactly once', async () => {
    render(<MessageList conversationId={seed(1)} />);
    await screen.findByText('organic-azide');
    await waitFor(() => expect(calls.filter((u) => u.includes('tool-results'))).toHaveLength(1));
  });

  it('caps the blocks and says how many it did not render', async () => {
    render(<MessageList conversationId={seed(5)} />);
    await screen.findAllByText('organic-azide');

    expect(calls.filter((u) => u.includes('tool-results'))).toHaveLength(3);
    expect(screen.getByText(/2 further stored results/)).toBeTruthy();
  });

  it('names the method on the block, and the size of what it fetched', async () => {
    // Provenance at the altitude the number is read at: the method used to be four disclosures
    // down while the value it qualifies sat at depth zero.
    render(<MessageList conversationId={seed(1)} />);
    await screen.findByText('organic-azide');

    // Scoped to the block. The status strip above the answer names the turn's methods too, and
    // deliberately: that line is the ANSWER's provenance, for the numbers the prose quotes with no
    // block behind them at all. This one is the provenance of the table underneath it.
    const block = document.querySelector('[data-result-block]');
    expect(block?.textContent).toContain('Cited reference table');
    expect(block?.textContent).toContain(`${HAZARD.length.toLocaleString()} B`);
  });

  it('renders a small result with no fetch at all, from the event itself', async () => {
    // The preview/ref split is a rule about LARGE results, and it was costing a 300-byte ICH limit
    // a second round trip for a payload smaller than the preview beside it. Under the service's
    // inline cap the text rides along, and the block draws it immediately.
    const cid = seed(1);
    const store = useChatStore.getState();
    const conversation = store.conversations[cid]!;
    const assistant = conversation.messages.findLast((m) => m.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('no assistant message');
    useChatStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [cid]: {
          ...conversation,
          messages: conversation.messages.map((m) =>
            m.id === assistant.id
              ? {
                  ...assistant,
                  trace: assistant.trace.map((e) =>
                    e.kind === 'tool_call' && e.toolCall
                      ? { ...e, toolCall: { ...e.toolCall, resultInline: HAZARD } }
                      : e,
                  ),
                }
              : m,
          ),
        },
      },
    }));

    render(<MessageList conversationId={cid} />);
    expect(await screen.findByText('organic-azide')).toBeTruthy();
    expect(calls.filter((u) => u.includes('tool-results'))).toHaveLength(0);
  });

  it('offers nothing for a transcript with no session to fetch against', () => {
    // A rehydrated transcript has the calls and no session handle; the route is session-scoped, so
    // asking would be asking for a 404.
    render(<MessageList conversationId={seed(1, null)} />);
    expect(calls.filter((u) => u.includes('tool-results'))).toHaveLength(0);
  });

  it('stays quiet when the result can no longer be read', async () => {
    restore?.();
    const stub = stubFetch(() => new Response('{"detail":"gone"}', { status: 404 }));
    restore = stub.restore;

    render(<MessageList conversationId={seed(1)} />);
    // Nothing asked for this read, so its failure raises no banner and leaves no broken card —
    // the step in the agent's work below still offers the same result and reports properly.
    await waitFor(() => expect(screen.queryByText('organic-azide')).toBeNull());
    expect(useChatStore.getState().banner).toBeNull();
  });
});
