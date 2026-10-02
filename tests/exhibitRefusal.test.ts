/**
 * A refused message gives back its `@artefact` chips with its text.
 *
 * Review finding: the composer clears the chips at submit, as it clears the text, and every
 * refusal path put only the text back — so "is row 3 of this right?" came back with "this" no
 * longer attached, and sent again it would ask the agent about an artefact it was never shown.
 * Driven through the real `sendMessage` against a refusing service.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendMessage } from '../src/state/sendMessage.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { refsOf, useExhibitPane } from '../src/state/exhibitPane.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { stubFetch } from './helpers.ts';

const CONVERSATION = 'conv-refused';
const SID = 'a'.repeat(32);
const REF = { exhibit_id: 'xb-0123456789abcdef', revision: 2 };
const auth = {
  mode: 'dev',
  getAccessToken: async () => null,
  handleUnauthorized: async () => false,
} as unknown as AuthProvider;

let restore: (() => void) | null = null;

beforeEach(() => {
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

afterEach(() => {
  restore?.();
  restore = null;
});

const refuseWith = (status: number, detail: unknown): void => {
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify({ detail }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  restore = stub.restore;
};

describe('a refused message', () => {
  it('puts the artefacts it carried back beside the text', async () => {
    refuseWith(422, "no artefact 'xb-0123456789abcdef' at revision 2 in this session");
    await sendMessage({
      conversationId: CONVERSATION,
      text: 'Is row 3 right?',
      auth,
      exhibitRefs: [REF],
    });
    expect(useChatStore.getState().drafts[CONVERSATION]).toBe('Is row 3 right?');
    expect(refsOf(useExhibitPane.getState(), CONVERSATION)).toEqual([REF]);
  });

  it('does not overwrite chips attached since, as it does not overwrite text typed since', async () => {
    refuseWith(503, 'at capacity');
    const newer = { exhibit_id: 'xb-1111111111111111', revision: 0 };
    const sending = sendMessage({
      conversationId: CONVERSATION,
      text: 'q',
      auth,
      exhibitRefs: [REF],
    });
    useExhibitPane.getState().addRef(CONVERSATION, newer);
    await sending;
    expect(refsOf(useExhibitPane.getState(), CONVERSATION)).toEqual([newer]);
  });
});
