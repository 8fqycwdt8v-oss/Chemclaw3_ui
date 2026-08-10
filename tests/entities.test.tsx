/**
 * The conversation's subject index.
 *
 * Two properties carry this feature, and both are easy to lose quietly:
 *
 *  - **Identity.** Two spellings of one molecule must collapse to one row, or the rail shows the
 *    same compound twice and can never join a computed value to the structure it was computed for.
 *  - **The promotion rule.** Entities come from structured sources only. A rail fed by scanning
 *    prose fills with near-misses, and a rail full of noise is worse than none — a chemist stops
 *    reading it, and then the one row that mattered is missed too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  entitiesOf,
  useEntityStore,
  type JobEntity,
  type MoleculeEntity,
} from '../src/chem/entities.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import { EntityRail } from '../src/components/EntityRail.tsx';
import { MessageList } from '../src/components/MessageList.tsx';
import { useChatStore } from '../src/state/chatStore.ts';
import { answerEvent, toolResultEvent } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const store = () => useEntityStore.getState();
/** Every ingest in this file goes into one conversation unless it says otherwise. */
const C1 = 'conversation-1';
const slice = (conversationId = C1) => entitiesOf(useEntityStore.getState(), conversationId);
const entity = (key: string, conversationId = C1) => slice(conversationId).entities[key];
const ingest = (messageId: string, event: ChemclawEvent, conversationId = C1) =>
  store().ingest(conversationId, messageId, event);

beforeEach(() => {
  cleanup();
  store().clear();
});

describe('identity', () => {
  it('collapses two spellings of one molecule into one entity', async () => {
    await ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'COc1ccc(Br)cc1' }),
    });
    await ingest('m2', {
      type: 'tool_call',
      tool: 'compute_xtb_energy',
      arguments: JSON.stringify({ smiles: 'BrC1=CC=C(OC)C=C1' }),
    });

    const molecules = Object.values(slice().entities).filter((e) => e.kind === 'molecule');
    expect(molecules).toHaveLength(1);

    const molecule = molecules[0] as MoleculeEntity;
    expect(molecule.smiles).toBe('COc1ccc(Br)cc1');
    // Both spellings kept: a chemist who typed one form should recognise their own input.
    expect(molecule.aliases).toEqual(['COc1ccc(Br)cc1', 'BrC1=CC=C(OC)C=C1']);
    // Seen in two turns, by two tools.
    expect(molecule.mentions).toHaveLength(2);
  });

  it('does not count one tool naming one molecule twice in a turn as two sightings', async () => {
    const call = {
      type: 'tool_call' as const,
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    };
    await ingest('m1', call);
    await ingest('m1', call);
    expect((entity('CCO') as MoleculeEntity).mentions).toHaveLength(1);
  });
});

describe('the promotion rule', () => {
  it('takes molecules from a tool call that parsed as whole JSON', async () => {
    await ingest('m1', {
      type: 'tool_call',
      tool: 'compute_reaction_energy',
      arguments: JSON.stringify({ reactants: ['CCO', 'CC(=O)O'] }),
    });
    expect(Object.keys(slice().entities).sort()).toEqual(['CC(=O)O', 'CCO']);
  });

  it('takes nothing from a truncated arguments document', async () => {
    // The load-bearing case. A SMILES cut mid-string often still parses as a smaller, valid, wrong
    // molecule — so the whole document is refused rather than mined.
    await ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: '{"smiles": "COc1ccc(Br)c',
    });
    expect(slice().order).toEqual([]);
  });

  it('takes nothing from the answer text', async () => {
    // Prose can link to an entity the store already holds; it cannot mint one.
    await ingest('m1', answerEvent({ text: 'We used CCO and COc1ccc(Br)cc1 throughout.' }));
    expect(slice().order).toEqual([]);
  });

  it('takes nothing from a tool_result preview', async () => {
    await ingest('m1', toolResultEvent({ tool: 'predict_pka', preview: 'CCO gave 15.9' }));
    expect(slice().order).toEqual([]);
  });

  it('drops an argument value RDKit refuses', async () => {
    await ingest('m1', {
      type: 'tool_call',
      tool: 'find_notes',
      arguments: JSON.stringify({ text: 'CCCCP' }),
    });
    // Shape-wise it passes the syntactic recogniser; RDKit is the arbiter, and a row that cannot
    // be drawn or compared only takes up space.
    expect(slice().order).toEqual([]);
  });

  it('takes note ids from the service rather than from prose', async () => {
    await ingest(
      'm1',
      toolResultEvent({ tool: 'gather_evidence', note_ids: ['note-4-bromoanisole'] }),
    );
    expect(entity('note:note-4-bromoanisole')?.kind).toBe('note');
  });
});

describe('jobs', () => {
  it('closes a running job when the push-back stream reports it', async () => {
    await ingest('m1', { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    expect((entity('job:qm-1') as JobEntity).status).toBe('running');

    await ingest('m1', { type: 'job_failed', job_id: 'qm-1', reason: 'walltime' });
    const job = entity('job:qm-1') as JobEntity;
    expect(job.status).toBe('failed');
    expect(job.reason).toBe('walltime');
    // The kind survives the merge — a failure event does not carry one, and losing it would
    // relabel a DFT run as a generic job at the moment it most needs naming.
    expect(job.jobKind).toBe('qm');
  });

  it('promotes the molecule a completed job computed', async () => {
    await ingest('m1', {
      type: 'job_completed',
      job_id: 'qm-2',
      summary: { molecule_smiles: 'OCC', converged: true },
    });
    // Canonicalised on the way in, so it joins the entity a tool call would have created.
    expect(entity('CCO')?.kind).toBe('molecule');
    expect((entity('job:qm-2') as JobEntity).moleculeSmiles).toBe('CCO');
  });
});

describe('switching conversation', () => {
  const C2 = 'conversation-2';

  it('keeps each conversation’s subjects to itself, and gives them back on the way home', async () => {
    await ingest('a1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });
    await ingest(
      'b1',
      { type: 'tool_call', tool: 'predict_pka', arguments: JSON.stringify({ smiles: 'CC(=O)O' }) },
      C2,
    );

    // Neither conversation can see the other's molecule. The store used to be one global bag, so
    // both of these were in both rails.
    expect(Object.keys(slice().entities)).toEqual(['CCO']);
    expect(Object.keys(slice(C2).entities)).toEqual(['CC(=O)O']);
    // And going back is a switch, not a rebuild: nothing re-ingests a stored transcript, so an
    // index cleared on switch would be gone for good.
    expect(entity('CCO')?.kind).toBe('molecule');
  });

  it('does not let one conversation’s selection filter another’s transcript', async () => {
    const chat = useChatStore.getState();
    const c2 = chat.createConversation();
    useChatStore.getState().appendUserMessage(c2, 'asked in the second conversation');

    // A selection in the first conversation. Its mention list names `a1` and nothing else.
    await store().ingest(C1, 'a1', { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    store().select(C1, 'job:qm-1');

    // The failure this replaces: `selected` was global, so the second conversation's messages were
    // filtered against the first conversation's mentions, matched nothing, and the transcript
    // rendered "nothing about that yet" over a conversation full of turns.
    render(<MessageList conversationId={c2} />);
    expect(screen.getByText('asked in the second conversation')).toBeTruthy();
    expect(screen.queryByText(/Nothing about that yet/)).toBeNull();
    // And the rail beside it shows that conversation's subjects — which is none of them.
    expect(render(<EntityRail conversationId={c2} />).container.firstChild).toBeNull();
  });

  it('drops a conversation’s index when the conversation is deleted', async () => {
    const chat = useChatStore.getState();
    const id = chat.createConversation();
    await store().ingest(id, 'm1', { type: 'job_started', job_id: 'qm-9', kind: 'qm' });
    expect(entitiesOf(useEntityStore.getState(), id).order).toEqual(['job:qm-9']);

    useChatStore.getState().deleteConversation(id);
    // An index for a transcript that no longer exists is a rail nobody can ever reach.
    expect(useEntityStore.getState().byConversation[id]).toBeUndefined();
  });
});

describe('<EntityRail>', () => {
  it('renders nothing until the conversation is about something', () => {
    const { container } = render(<EntityRail conversationId={C1} />);
    expect(container.firstChild).toBeNull();
  });

  it('groups what it holds and says which tools touched each row', async () => {
    await ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });
    await ingest('m1', { type: 'job_started', job_id: 'qm-1', kind: 'qm' });

    render(<EntityRail conversationId={C1} />);
    await waitFor(() => expect(screen.getByText('Molecules (1)')).toBeTruthy());
    expect(screen.getByText('Jobs (1)')).toBeTruthy();
    expect(screen.getByText('predict_pka')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('narrows the transcript to the turns that mention the selected subject', async () => {
    const chat = useChatStore.getState();
    const id = chat.createConversation();
    useChatStore.getState().appendUserMessage(id, 'what is its pKa');
    const answered = useChatStore.getState().startAssistantMessage(id);
    useChatStore.getState().appendUserMessage(id, 'unrelated question');

    await store().ingest(id, answered, {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });

    render(
      <>
        <EntityRail conversationId={id} />
        <MessageList conversationId={id} />
      </>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /CCO/ }));

    await waitFor(() => expect(screen.queryByText('unrelated question')).toBeNull());
    // The question that prompted the matching turn comes with it: an answer shown without it
    // reads as the agent volunteering something.
    expect(screen.getByText('what is its pKa')).toBeTruthy();
  });
});
