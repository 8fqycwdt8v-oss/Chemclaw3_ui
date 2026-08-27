/**
 * The plan checklist's rendering rule: the service encodes each step's completion state as a
 * leading `[x] ` / `[ ] ` prefix (its plan event re-emits on every status flip so steps can tick
 * over live), and this used to reach the chemist as literal text beside a square that never
 * filled. The prefix is parsed into a real checkbox; a line without one — the GET plan route
 * returns bare step text — stays a plain bullet rather than claiming a state nobody reported.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlanItems, parsePlanItem } from '../src/components/PlanItems.tsx';

afterEach(cleanup);

describe('parsePlanItem', () => {
  it('splits the status prefix from the step text', () => {
    expect(parsePlanItem('[x] compute the pKa')).toEqual({
      status: 'done',
      text: 'compute the pKa',
    });
    expect(parsePlanItem('[ ] propose a note')).toEqual({
      status: 'open',
      text: 'propose a note',
    });
  });

  it('leaves a line without a prefix as plain, prefix-lookalikes included', () => {
    expect(parsePlanItem('compute the pKa')).toEqual({
      status: 'plain',
      text: 'compute the pKa',
    });
    // Only the exact rendering counts — `[X] ` (capital) is step text, not a status.
    expect(parsePlanItem('[X] not a status').status).toBe('plain');
  });
});

describe('PlanItems', () => {
  it('renders the status as a checkbox, never as literal prefix text', () => {
    render(<PlanItems todos={['[x] compute the pKa', '[ ] propose a note']} />);
    expect(screen.getByText('compute the pKa')).toBeTruthy();
    expect(screen.getByText('propose a note')).toBeTruthy();
    expect(screen.queryByText(/\[x\]/)).toBeNull();
    expect(screen.queryByText(/\[ \]/)).toBeNull();
  });

  it('says the state in words for a reader who cannot see the box', () => {
    render(<PlanItems todos={['[x] compute the pKa', '[ ] propose a note']} />);
    expect(screen.getByText('Done:')).toBeTruthy();
    expect(screen.getByText('To do:')).toBeTruthy();
  });

  it('strikes a completed step through and leaves an open one alone', () => {
    render(<PlanItems todos={['[x] done step', '[ ] open step']} />);
    expect(screen.getByText('done step').closest('span')?.className).toContain('line-through');
    expect(screen.getByText('open step').closest('span')?.className).not.toContain('line-through');
  });

  it('renders a bare line as a plain bullet with no claimed state', () => {
    render(<PlanItems todos={['bare step from the plan route']} />);
    expect(screen.getByText('bare step from the plan route')).toBeTruthy();
    expect(screen.queryByText('Done:')).toBeNull();
    expect(screen.queryByText('To do:')).toBeNull();
  });

  it('badges the step a durable job runs for, matched on the bare text', () => {
    // The service stamps the todo's bare content on the job, while the streamed line carries the
    // `[ ] ` prefix — the join only lines up because the prefix is parsed off first.
    const jobs = new Map([['run the conformer search', 'running' as const]]);
    render(
      <PlanItems todos={['[ ] run the conformer search', '[ ] propose a note']} jobs={jobs} />,
    );
    expect(screen.getByText('job running')).toBeTruthy();
    // The unbadged step wears nothing — one running job must not read as two.
    expect(screen.getAllByText(/job running/)).toHaveLength(1);
  });

  it('shows how a step’s job ended, in words', () => {
    const jobs = new Map<string, 'done' | 'failed'>([
      ['step A', 'done'],
      ['step B', 'failed'],
    ]);
    render(<PlanItems todos={['[x] step A', '[ ] step B']} jobs={jobs} />);
    expect(screen.getByText('job done')).toBeTruthy();
    expect(screen.getByText('job failed')).toBeTruthy();
  });

  it('wears no chip when no jobs map is given at all', () => {
    render(<PlanItems todos={['[ ] run the conformer search']} />);
    expect(screen.queryByText(/job (running|done|failed)/)).toBeNull();
  });
});
