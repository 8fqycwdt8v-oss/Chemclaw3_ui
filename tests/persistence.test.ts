/**
 * What happens to state that was written by an older build.
 *
 * The storage key is frozen (`chemclaw3.chat.v2`) precisely so this path carries the weight
 * instead: bumping the key again would be a silent wipe of everyone's local history. So a
 * migration that quietly drops a field, or invents one, is unrecoverable for the person it
 * happens to — and it only ever shows up on a real machine, after shipping.
 */

import { describe, expect, it } from 'vitest';
import { migratePersisted } from '../src/state/chatStore.ts';
import type { Conversation } from '../src/state/types.ts';

/** A conversation as v2 wrote it: no `sessionOrigin`, because the field did not exist. */
const v2Conversation = (id: string, extra: Record<string, unknown> = {}): Conversation =>
  ({
    id,
    sessionId: null,
    title: 'Ligand screen',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    contextLost: false,
    ...extra,
  }) as unknown as Conversation;

const v2State = (extra: Record<string, unknown> = {}) => ({
  conversations: { a: v2Conversation('a') },
  order: ['a'],
  activeId: 'a',
  ...extra,
});

describe('migratePersisted', () => {
  it('gives a v2 conversation an empty feed rather than inventing completions', () => {
    const next = migratePersisted(v2State(), 2);

    expect(next.jobFeed).toEqual([]);
    expect(next.notifyOnJobComplete).toBe(false);
    // And it did not lose the conversation on the way.
    expect(next.order).toEqual(['a']);
  });

  it('keeps a feed that is already there', () => {
    const item = {
      event: { type: 'job_completed' as const, job_id: 'qm-1', summary: {} },
      sessionId: 'a'.repeat(32),
      conversationId: 'a',
      receivedAt: 1700000000000,
      seen: true,
      dismissed: false,
    };
    const next = migratePersisted(v2State({ jobFeed: [item] }), 2);
    expect(next.jobFeed).toEqual([item]);
  });

  it("defaults sessionOrigin to 'local'", () => {
    // 'server' would send the transcript rehydrate off to GET /messages for a conversation that
    // never had a remote copy — a wasted round-trip, and a warn banner if it fails.
    const next = migratePersisted(v2State(), 2);
    expect(next.conversations.a?.sessionOrigin).toBe('local');
  });

  it('does not overwrite a sessionOrigin that is already recorded', () => {
    const state = v2State({
      conversations: { a: v2Conversation('a', { sessionOrigin: 'server' }) },
    });
    expect(migratePersisted(state, 2).conversations.a?.sessionOrigin).toBe('server');
  });

  it('applies every step a v1 payload has missed, not just the first', () => {
    // The shape this replaced returned early at v2 and so ran no step at all for a v1 payload
    // once v3 existed: the mid-stream repair happened, the feed did not.
    const state = {
      conversations: {
        a: v2Conversation('a', {
          messages: [{ id: 'm1', role: 'assistant', at: 1, status: 'streaming', trace: [] }],
        }),
      },
      order: ['a'],
      activeId: 'a',
    };
    const next = migratePersisted(state, 1);

    const message = next.conversations.a?.messages[0];
    expect(message?.role === 'assistant' && message.status).toBe('aborted');
    expect(next.jobFeed).toEqual([]);
    expect(next.conversations.a?.sessionOrigin).toBe('local');
  });

  it('falls back to a clean slate rather than guessing at unreadable state', () => {
    expect(migratePersisted(undefined, 1).order).toEqual([]);
    expect(migratePersisted({ conversations: {} }, 2).conversations).toEqual({});
  });
});
