/**
 * Handing an artefact back to the agent, and getting the cards back after a reload.
 *
 * "Ask about this" is a *structured* reference — `exhibit_refs` on the message — because the
 * service puts a framed copy of that revision in front of the model as data, which an id typed
 * into the prose could never be. So what is held here is the request: the chips travel with the
 * message they were attached to, carry the revision the chemist saw, stop at the service's cap,
 * and are gone once sent.
 *
 * The transcript half: the `exhibit` frame is streamed and never stored, so a reloaded answer's
 * card is rebuilt from the `create_exhibit`/`revise_exhibit` call that made it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { refsOf, useExhibitPane } from '../src/state/exhibitPane.ts';
import { transcriptToMessages } from '../src/state/transcript.ts';
import { MAX_EXHIBIT_REFS } from '../shared/exhibits.ts';
import { VIEW } from './exhibitFixtures.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value };
});

vi.mock('../src/api/client.ts', () => ({
  api: {
    listProfiles: async () => [],
    listExhibits: async () => ({ enabled: true, exhibits: [VIEW] }),
  },
}));

const sendMessage = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/state/sendMessage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state/sendMessage.ts')>()),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  warmSession: async () => undefined,
}));

const CONVERSATION = 'conv-x';
const SID = 'a'.repeat(32);

beforeEach(() => {
  sendMessage.mockClear();
  useExhibitPane.setState({ refs: {} });
  useChatStore.setState({
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        sessionId: SID,
        sessionOrigin: 'local',
        title: 'x',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
      },
    },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    composerLock: false,
    streaming: null,
    drafts: {},
  });
});

afterEach(cleanup);

describe('the @artefact chips', () => {
  it('ride with the next message, as exhibit_refs, and are cleared by it', async () => {
    useExhibitPane.getState().addRef(CONVERSATION, { exhibit_id: VIEW.exhibit_id, revision: 2 });
    render(<Composer conversationId={CONVERSATION} />);

    const list = await screen.findByRole('list', { name: 'Artefacts attached to this message' });
    expect(list.textContent).toContain('Solvent ranking');
    expect(list.textContent).toContain('r2');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Is row 2 right?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      conversationId: CONVERSATION,
      text: 'Is row 2 right?',
      exhibitRefs: [{ exhibit_id: VIEW.exhibit_id, revision: 2 }],
    });
    expect(refsOf(useExhibitPane.getState(), CONVERSATION)).toEqual([]);
  });

  it('can be removed before sending', async () => {
    useExhibitPane.getState().addRef(CONVERSATION, { exhibit_id: VIEW.exhibit_id, revision: 2 });
    render(<Composer conversationId={CONVERSATION} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Solvent ranking from this message' }),
    );
    expect(screen.queryByRole('list', { name: 'Artefacts attached to this message' })).toBeNull();
  });

  it('stop at the service’s cap, and never hold one artefact twice', () => {
    const add = (n: number): boolean =>
      useExhibitPane.getState().addRef(CONVERSATION, {
        exhibit_id: `xb-${String(n).padStart(16, '0')}`,
        revision: 0,
      });
    expect(add(1)).toBe(true);
    expect(add(1)).toBe(false);
    for (let n = 2; n <= MAX_EXHIBIT_REFS; n += 1) expect(add(n)).toBe(true);
    expect(add(99)).toBe(false);
    expect(refsOf(useExhibitPane.getState(), CONVERSATION)).toHaveLength(MAX_EXHIBIT_REFS);
    // Per conversation: another one's composer is untouched.
    expect(refsOf(useExhibitPane.getState(), 'elsewhere')).toEqual([]);
  });
});

describe('a reloaded answer keeps its artefact cards', () => {
  it('rebuilds them from the calls that made them, and from nothing else', () => {
    const [, answer] = transcriptToMessages([
      { index: 0, role: 'user', text: 'Rank the solvents', tool_calls: [] },
      {
        index: 1,
        role: 'assistant',
        text: 'Here is the ranking.',
        tool_calls: [
          {
            tool: 'create_exhibit',
            arguments: '{"title":"Solvent ranking"}',
            result: '{"exhibit_id": "xb-0123456789abcdef", "revision": 1}',
          },
          {
            tool: 'revise_exhibit',
            arguments: '{}',
            result: '{"exhibit_id": "xb-0123456789abcdef", "revision": 2}',
          },
          // Refused, cut, or not this tool: no card.
          { tool: 'create_exhibit', arguments: '{}', result: 'spec.rows[0]: unknown column' },
          { tool: 'create_exhibit', arguments: '{}', result: null },
          { tool: 'predict_pka', arguments: '{}', result: '{"exhibit_id": "xb-0123456789abcdef"}' },
        ],
      },
    ]);
    expect(answer?.role).toBe('assistant');
    const cards =
      answer?.role === 'assistant'
        ? answer.trace.filter((e) => e.kind === 'exhibit').map((e) => e.exhibit)
        : [];
    expect(cards).toEqual([
      {
        exhibitId: 'xb-0123456789abcdef',
        revision: 1,
        kind: '',
        title: '',
        op: 'created',
        authorKind: 'agent',
        author: '',
      },
      {
        exhibitId: 'xb-0123456789abcdef',
        revision: 2,
        kind: '',
        title: '',
        op: 'revised',
        authorKind: 'agent',
        author: '',
      },
    ]);
  });
});
