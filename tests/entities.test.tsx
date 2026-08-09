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

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEntityStore, type JobEntity, type MoleculeEntity } from '../src/chem/entities.ts';
import { EntityRail } from '../src/components/EntityRail.tsx';
import { answerEvent, toolResultEvent } from './helpers.ts';

const store = () => useEntityStore.getState();
const entity = (key: string) => useEntityStore.getState().entities[key];

beforeEach(() => {
  cleanup();
  store().clear();
});

describe('identity', () => {
  it('collapses two spellings of one molecule into one entity', async () => {
    await store().ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'COc1ccc(Br)cc1' }),
    });
    await store().ingest('m2', {
      type: 'tool_call',
      tool: 'compute_xtb_energy',
      arguments: JSON.stringify({ smiles: 'BrC1=CC=C(OC)C=C1' }),
    });

    const molecules = Object.values(useEntityStore.getState().entities).filter(
      (e) => e.kind === 'molecule',
    );
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
    await store().ingest('m1', call);
    await store().ingest('m1', call);
    expect((entity('CCO') as MoleculeEntity).mentions).toHaveLength(1);
  });
});

describe('the promotion rule', () => {
  it('takes molecules from a tool call that parsed as whole JSON', async () => {
    await store().ingest('m1', {
      type: 'tool_call',
      tool: 'compute_reaction_energy',
      arguments: JSON.stringify({ reactants: ['CCO', 'CC(=O)O'] }),
    });
    expect(Object.keys(useEntityStore.getState().entities).sort()).toEqual(['CC(=O)O', 'CCO']);
  });

  it('takes nothing from a truncated arguments document', async () => {
    // The load-bearing case. A SMILES cut mid-string often still parses as a smaller, valid, wrong
    // molecule — so the whole document is refused rather than mined.
    await store().ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: '{"smiles": "COc1ccc(Br)c',
    });
    expect(useEntityStore.getState().order).toEqual([]);
  });

  it('takes nothing from the answer text', async () => {
    // Prose can link to an entity the store already holds; it cannot mint one.
    await store().ingest('m1', answerEvent({ text: 'We used CCO and COc1ccc(Br)cc1 throughout.' }));
    expect(useEntityStore.getState().order).toEqual([]);
  });

  it('takes nothing from a tool_result preview', async () => {
    await store().ingest('m1', toolResultEvent({ tool: 'predict_pka', preview: 'CCO gave 15.9' }));
    expect(useEntityStore.getState().order).toEqual([]);
  });

  it('drops an argument value RDKit refuses', async () => {
    await store().ingest('m1', {
      type: 'tool_call',
      tool: 'find_notes',
      arguments: JSON.stringify({ text: 'CCCCP' }),
    });
    // Shape-wise it passes the syntactic recogniser; RDKit is the arbiter, and a row that cannot be
    // drawn or compared only takes up space.
    expect(useEntityStore.getState().order).toEqual([]);
  });

  it('takes note ids from the service rather than from prose', async () => {
    await store().ingest(
      'm1',
      toolResultEvent({ tool: 'gather_evidence', note_ids: ['compound-4-bromoanisole'] }),
    );
    expect(entity('note:compound-4-bromoanisole')?.kind).toBe('note');
  });
});

describe('jobs', () => {
  it('closes a running job when the push-back stream reports it', async () => {
    await store().ingest('m1', { type: 'job_started', job_id: 'qm-1', kind: 'qm' });
    expect((entity('job:qm-1') as JobEntity).status).toBe('running');

    await store().ingest('job:qm-1', { type: 'job_failed', job_id: 'qm-1', reason: 'walltime' });
    const job = entity('job:qm-1') as JobEntity;
    expect(job.status).toBe('failed');
    expect(job.reason).toBe('walltime');
    // The kind survives the merge — a failure event does not carry one, and losing it would
    // relabel a DFT run as a generic job at the moment it most needs naming.
    expect(job.jobKind).toBe('qm');
  });

  it('promotes the molecule a completed job computed', async () => {
    await store().ingest('m1', {
      type: 'job_completed',
      job_id: 'qm-2',
      summary: { molecule_smiles: 'OCC', converged: true },
    });
    // Canonicalised on the way in, so it joins the entity a tool call would have created.
    expect(entity('CCO')?.kind).toBe('molecule');
    expect((entity('job:qm-2') as JobEntity).moleculeSmiles).toBe('CCO');
  });
});

describe('<EntityRail>', () => {
  it('renders nothing until the conversation is about something', () => {
    const { container } = render(<EntityRail />);
    expect(container.firstChild).toBeNull();
  });

  it('groups what it holds and says which tools touched each row', async () => {
    await store().ingest('m1', {
      type: 'tool_call',
      tool: 'predict_pka',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });
    await store().ingest('m1', { type: 'job_started', job_id: 'qm-1', kind: 'qm' });

    render(<EntityRail />);
    await waitFor(() => expect(screen.getByText('Molecules (1)')).toBeTruthy());
    expect(screen.getByText('Jobs (1)')).toBeTruthy();
    expect(screen.getByText('predict_pka')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });
});
