/**
 * Citation chips: the authoritative list, and the guess behind it.
 *
 * `tool_result.note_ids` is the untruncated list of ids the service actually put in front of the
 * model for a turn. It has been on the wire and on the trace row for a while, and the renderer went
 * on recognising citations by their prefix — a list that has already been wrong once in a way
 * nobody noticed, when it read `reaction-`, `note-` and `qm-` and the first two matched nothing the
 * backend has ever written.
 *
 * So both directions are pinned here. With the list, the chips are exactly it. Without it — an
 * older backend, a turn that called no tool, a stored note body with no turn behind it — the
 * heuristic still runs, because chipping nothing would be a worse answer than chipping a guess.
 */

import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Markdown } from '../src/components/Markdown.tsx';
import { returnedNoteIds } from '../src/lib/citations.ts';
import type { TraceEntry } from '../src/state/types.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { toolResultEvent } from './helpers.ts';

afterEach(cleanup);

const chips = (): string[] =>
  screen.queryAllByRole('button').map((button) => button.textContent ?? '');

describe('reading the authoritative list off the trace', () => {
  it('carries note_ids from the wire to the renderer’s input', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'find_notes', arguments: '{}' });
    store.applyEvent(
      cid,
      mid,
      toolResultEvent({ tool: 'find_notes', note_ids: ['compound-4-bromoanisole', 'rxn-suzuki'] }),
    );

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    if (!message || message.role !== 'assistant') throw new Error('no assistant message');
    expect(returnedNoteIds(message.trace)).toEqual(['compound-4-bromoanisole', 'rxn-suzuki']);
  });

  it('deduplicates across calls, because the answer never says which call cited what', () => {
    const trace = [
      { id: 'a', at: 0, kind: 'tool_call', toolCall: { tool: 't', arguments: '', noteIds: ['a', 'b'] } },
      { id: 'b', at: 0, kind: 'tool_call', toolCall: { tool: 'u', arguments: '', noteIds: ['b', 'c'] } },
    ] as TraceEntry[];
    expect(returnedNoteIds(trace)).toEqual(['a', 'b', 'c']);
  });

  it('reads a turn with no tool results as having no list, not as an empty one', () => {
    // The distinction the fallback hangs on: absent means "this turn cannot answer the question",
    // which is what puts the heuristic back in charge.
    const trace = [
      { id: 'a', at: 0, kind: 'tool_call', toolCall: { tool: 't', arguments: '' } },
    ] as TraceEntry[];
    expect(returnedNoteIds(trace)).toEqual([]);
  });
});

describe('with the authoritative list', () => {
  it('chips exactly the ids the turn’s tools returned', () => {
    render(
      <Markdown noteIds={['compound-4-bromoanisole']}>
        {'Methoxy directs para, per compound-4-bromoanisole.'}
      </Markdown>,
    );
    expect(chips()).toEqual(['compound-4-bromoanisole']);
  });

  it('chips an id the prefix heuristic would never have recognised', () => {
    // The heuristic can only ever match shapes someone wrote down. The service's list is the ids
    // themselves, so it is right about a note type the frontend has never heard of.
    render(
      <Markdown noteIds={['sop-quench-protocol']}>{'See sop-quench-protocol.'}</Markdown>,
    );
    expect(chips()).toEqual(['sop-quench-protocol']);
  });

  it('leaves a note-shaped token the turn did not return as plain text', () => {
    // Not chipped, and not marked either: a chip would promise a citation this turn cannot show
    // was in front of the model, and a warning would be the fabrication verdict this codebase
    // refuses to hand out on evidence this thin.
    const { container } = render(
      <Markdown noteIds={['compound-4-bromoanisole']}>
        {'Both compound-4-bromoanisole and rxn-never-returned agree.'}
      </Markdown>,
    );
    expect(chips()).toEqual(['compound-4-bromoanisole']);
    expect(container.textContent).toContain('rxn-never-returned');
  });

  it('will not chip a prefix of an id as though the whole id had matched', () => {
    render(<Markdown noteIds={['rxn-4821']}>{'Recorded under rxn-4821.a for now.'}</Markdown>);
    expect(chips()).toEqual([]);
  });

  it('chips an id that ends a sentence, full stop and all', () => {
    // The other side of the same boundary, and the common case: a `.` is part of an id only when a
    // character of the id follows it. Refusing every trailing `.` chipped nothing at a sentence end.
    render(<Markdown noteIds={['rxn-4821']}>{'The precedent is rxn-4821.'}</Markdown>);
    expect(chips()).toEqual(['rxn-4821']);
  });

  it('still recognises job ids, which the list says nothing about', () => {
    render(
      <Markdown noteIds={['compound-4-bromoanisole']}>
        {'Launched qm-a1b2c3d4 for compound-4-bromoanisole.'}
      </Markdown>,
    );
    expect(chips().sort()).toEqual(['compound-4-bromoanisole', 'qm-a1b2c3d4']);
  });
});

describe('without one', () => {
  it('falls back to the prefix heuristic rather than chipping nothing', () => {
    render(<Markdown>{'Methoxy directs para, per compound-4-bromoanisole.'}</Markdown>);
    expect(chips()).toEqual(['compound-4-bromoanisole']);
  });

  it('takes an empty list as no list at all — an older backend sends exactly that', () => {
    render(<Markdown noteIds={[]}>{'Per rxn-suzuki-4-bromoanisole.'}</Markdown>);
    expect(chips()).toEqual(['rxn-suzuki-4-bromoanisole']);
  });
});

describe('what neither mode may do', () => {
  it('never rewrites inside a code span or a fence', () => {
    // The reason this is a remark plugin and not a regex over rendered HTML.
    const { container } = render(
      <Markdown noteIds={['compound-4-bromoanisole']}>
        {'Use `compound-4-bromoanisole` as the key.\n\n```\ncompound-4-bromoanisole\n```\n'}
      </Markdown>,
    );
    expect(chips()).toEqual([]);
    expect(container.querySelectorAll('code').length).toBe(2);
  });
});
