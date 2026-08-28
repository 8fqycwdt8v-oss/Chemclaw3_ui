/**
 * The two strips above an answer, and the rail below it.
 *
 * All three replace surfaces that were correct and unreadable: three equal amber boxes, a plan card
 * printed in full above every answer, and a flat list of steps at one visual weight. What is
 * asserted here is the *ranking*, because that is the whole of the change and none of it is visible
 * to a type checker.
 *
 * The rule the first group pins: a qualifier that stops a reader acting keeps a bar and its
 * `role="alert"`; one they merely consult becomes a chip. Nothing is dropped and nothing is
 * softened — a test that only counted elements would pass on a version that quietly lost the
 * review notice.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusStrip } from '../src/components/StatusStrip.tsx';
import { PlanStrip } from '../src/components/PlanStrip.tsx';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { answerStep } from '../src/components/MessageList.tsx';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

afterEach(cleanup);

let seq = 0;
const entry = (over: Partial<TraceEntry> & Pick<TraceEntry, 'kind'>): TraceEntry => ({
  id: `e${(seq += 1)}`,
  at: 0,
  ...over,
});

const message = (over: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    id: 'a1',
    role: 'assistant',
    at: 0,
    status: 'done',
    streamedText: '',
    finalText: 'an answer',
    confidence: null,
    unsupportedClaims: [],
    reviewRequired: false,
    verifiedBy: null,
    degradedConnectors: [],
    partialReason: null,
    queued: false,
    trace: [],
    latestPlan: null,
    latestPlanHash: null,
    error: null,
    ...over,
  }) as AssistantMessage;

describe('the status strip ranks by what the reader has to do', () => {
  it('gives an alert to what stops the reader acting on the answer', () => {
    render(<StatusStrip message={message({ reviewRequired: true })} />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('Needs expert review');
  });

  it('gives an alert to a turn that was cut short, and keeps the service’s own sentence', () => {
    render(<StatusStrip message={message({ partialReason: 'the model-call cap was reached' })} />);
    expect(screen.getByRole('alert').textContent).toContain('the model-call cap was reached');
  });

  it('gives a chip — not an alert — to a connector that did not come up', () => {
    render(<StatusStrip message={message({ degradedConnectors: ['safety'] })} />);
    expect(screen.queryByRole('alert')).toBeNull();
    // The chemistry, not the pod: what the chemist now has to do about it.
    expect(screen.getByText(/hazard screen/)).toBeTruthy();
  });

  it('holds the unsupported claims one click in, and lets them out', () => {
    render(
      <StatusStrip
        message={message({ confidence: 0.4, unsupportedClaims: ['the yield was 82%'] })}
      />,
    );
    expect(screen.queryByText('the yield was 82%')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 unsupported claim/ }));
    expect(screen.getByText('the yield was 82%')).toBeTruthy();
  });

  it('names which verifier produced a score, because the two are not comparable', () => {
    render(<StatusStrip message={message({ confidence: 0.91, verifiedBy: 'citation-gate' })} />);
    fireEvent.click(screen.getByRole('button', { name: /0.91/ }));
    expect(screen.getByText(/scored against this turn/)).toBeTruthy();
  });
});

describe('the plan strip', () => {
  const trace: TraceEntry[] = [];

  it('states where the plan has got to without printing it', () => {
    render(
      <PlanStrip
        message={message({ latestPlan: ['[x] screen', '[ ] estimate the pKa'] })}
        trace={trace}
      />,
    );
    expect(screen.getByText(/1 of 2 steps done/)).toBeTruthy();
    expect(screen.queryByText('estimate the pKa')).toBeNull();
  });

  it('opens on click', () => {
    render(
      <PlanStrip
        message={message({ latestPlan: ['[x] screen', '[ ] estimate the pKa'] })}
        trace={trace}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('estimate the pKa')).toBeTruthy();
  });

  it('opens itself when the turn is waiting on a plan approval', () => {
    // A decision is bound to the hash of the plan that was SHOWN, so a reader being asked to
    // approve one must not have to go looking for it.
    render(
      <PlanStrip
        message={message({ latestPlan: ['[ ] screen'] })}
        trace={[
          entry({
            kind: 'approval_request',
            approval: { prompt: 'Approve the plan?', approvalId: '' },
          }),
        ]}
      />,
    );
    expect(screen.getByText('screen')).toBeTruthy();
  });

  it('opens itself when the approval arrives mid-turn', () => {
    // The case that actually happens. `useState(awaiting)` reads the trace once at mount, and a
    // live turn mounts its strip long before it asks for anything — so every real approval left
    // the plan folded away behind a reader being asked to approve it, while the rehydrated case
    // this was first written against passed.
    const props = { message: message({ latestPlan: ['[ ] screen'] }), trace: [] as TraceEntry[] };
    const { rerender } = render(<PlanStrip {...props} />);
    expect(screen.queryByText('screen')).toBeNull();

    rerender(
      <PlanStrip
        {...props}
        trace={[
          entry({
            kind: 'approval_request',
            approval: { prompt: 'Approve the plan?', approvalId: '' },
          }),
        ]}
      />,
    );
    expect(screen.getByText('screen')).toBeTruthy();
  });

  it('renders nothing at all when the turn had no plan', () => {
    const { container } = render(<PlanStrip message={message()} trace={trace} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('the step rail', () => {
  it('summarises the work rather than counting it', () => {
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_call',
            toolCall: { tool: 'predict_pka', arguments: '{}', result: 'ok' },
          }),
          entry({ kind: 'job_started', job: { jobId: 'calc-1', kind: 'calc' } }),
        ]}
        durationMs={4200}
      />,
    );
    expect(screen.getByRole('button', { name: /2 steps · 1 tool · 1 job · 4s/ })).toBeTruthy();
  });

  it('names a gate refusal as a refusal rather than counting it among the failures', () => {
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_failed',
            toolFailure: { tool: 'submit_qm_job', message: 'held', reason: 'plan_gate' },
          }),
        ]}
      />,
    );
    // The collapsed trigger says there is something to look at, because a panel that has to be
    // opened before trouble is visible is the depth problem this surface exists to fix …
    const trigger = screen.getByRole('button');
    expect(trigger.textContent).toContain('1 to look at');
    expect(trigger.textContent).not.toContain('failure');

    // … and the panel's own header says which kind it is, because the reader's next move on a
    // refusal is an approval and not a bug report.
    fireEvent.click(trigger);
    expect(screen.getByText('1 refusal')).toBeTruthy();
  });

  it('reads a sweep as one row naming every source and what it returned', () => {
    // One entry, because the fold happens in the store as the events arrive — see
    // `chatStore.test.ts`. The rail's job here is only to read it: who was asked, and what did
    // each contribute.
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'evidence_source',
            evidenceSweep: [
              { source: 'graph', chunks: 6, failed: false },
              { source: 'lexical', chunks: 0, failed: true },
            ],
            evidenceSource: { source: 'graph', chunks: 6, failed: false },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(screen.getByText('Evidence sweep')).toBeTruthy();
    // "failed" and "0" are different answers, and the flag is the only thing that tells them
    // apart: a dark source is a question about the corpus, a broken one is a page for whoever
    // owns the index.
    expect(screen.getByText('graph').parentElement?.textContent).toContain('6');
    expect(screen.getByText('lexical').parentElement?.textContent).toContain('failed');
  });

  it('still draws a trace persisted before the sweep field existed', () => {
    // A transcript in a reader's browser from before the fold moved to the store carries only
    // `evidenceSource`. It is one source rather than a sweep of five, and drawing nothing at all
    // for it would look exactly like a retrieval that never happened.
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'evidence_source',
            evidenceSource: { source: 'graph', chunks: 6, failed: false },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(screen.getByText('graph').parentElement?.textContent).toContain('6');
  });

  it('says how long a call took, and says nothing when it never saw it end', () => {
    render(
      <TracePanel
        trace={[
          {
            id: 'timed',
            at: 1000,
            kind: 'tool_call',
            toolCall: { tool: 'predict_pka', arguments: '{}', result: 'ok', endedAt: 5000 },
          },
          {
            id: 'rehydrated',
            at: 1000,
            kind: 'tool_call',
            toolCall: { tool: 'predict_logd', arguments: '{}', unresolved: true },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('4s')).toBeTruthy();
    // A reloaded transcript has no clock of ours on it, so the row says the one true thing.
    expect(screen.getByText('outcome not recorded')).toBeTruthy();
  });

  it('opens every step at once, and lets a reader close one afterwards', () => {
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_call',
            toolCall: { tool: 'predict_pka', arguments: '{"smiles":"CCO"}', result: 'pKa 15.9' },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    // A closed <details> keeps its content in the DOM, so the assertion is on the disclosure's own
    // state rather than on whether the text can be found.
    const details = (): HTMLDetailsElement | null => document.querySelector('details');
    expect(details()?.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(details()?.open).toBe(true);
    expect(screen.getByText('pKa 15.9')).toBeTruthy();
    // A default rather than a controlled value: the rows re-mount with it and the reader's own
    // toggling afterwards is their own.
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeTruthy();
  });

  it('carries the structures and the method on the line, not one caret in', () => {
    // The two questions a reader opens this panel with — "was that the compound I meant" and "was
    // that a table or an estimate" — were both behind a disclosure.
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_call',
            toolCall: { tool: 'predict_pka', arguments: '{"smiles":"COc1ccc(Br)cc1"}' },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(screen.getByText('COc1ccc(Br)cc1')).toBeTruthy();
    expect(screen.getByText('GFN2-xTB · semiempirical')).toBeTruthy();
  });

  it('names the plan step a durable job was launched for, by its number', () => {
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'job_started',
            job: { jobId: 'calc-1', kind: 'calc', planStep: 'estimate the pKa' },
          }),
        ]}
        plan={['[x] screen', '[ ] estimate the pKa']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(screen.getByText(/for step 2 · estimate the pKa/)).toBeTruthy();
  });

  it('closes the rail with the answer, in words rather than tokens', () => {
    // The service announces every step except the one that produced the text, so without this the
    // rail stops at the last tool call and a four-minute turn looks like a four-second one.
    render(
      <TracePanel
        trace={[entry({ kind: 'tool_call', toolCall: { tool: 'predict_pka', arguments: '{}' } })]}
        answer={{ words: 418, duration: '9s' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(screen.getByText('Answer written')).toBeTruthy();
    expect(screen.getByText('418 words')).toBeTruthy();
  });

  it('prints a returned value under the name the tool gave it', () => {
    // `numbers` alone could only ever say "predict_pka returned 4.76, 1.6". What it still must not
    // say is "4.76 ± 1.6": that the second is an uncertainty on the first is a relationship no
    // tool has stated, so the two are printed as the two values they are.
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_call',
            toolCall: {
              tool: 'predict_pka',
              arguments: '{}',
              result: '{"pka": 4.76}',
              numbers: [4.76, 1.6],
              values: [
                { label: 'pka', value: 4.76, unit: '' },
                { label: 'sd', value: 1.6, unit: '' },
              ],
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText(/pka 4\.76/)).toBeTruthy();
    expect(screen.getByText(/sd 1\.6/)).toBeTruthy();
  });

  it('falls back to the bare figures when the result had no names to give', () => {
    render(
      <TracePanel
        trace={[
          entry({
            kind: 'tool_call',
            toolCall: {
              tool: 'find_notes',
              arguments: '{}',
              result: 'the pKa is about 4.76',
              numbers: [4.76],
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    // A prose result has no names, and a guessed one would be the invention the service refuses.
    expect(screen.getByText('4.76')).toBeTruthy();
  });

  it('states what a plan revision changed instead of repeating the plan', () => {
    render(
      <TracePanel
        trace={[
          entry({ kind: 'plan', plan: { todos: ['[ ] screen'] } }),
          entry({ kind: 'plan', plan: { todos: ['[x] screen', '[ ] estimate the pKa'] } }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('1 step')).toBeTruthy();
    expect(screen.getByText('1 added · 1 ticked off')).toBeTruthy();
  });
});

describe('the answer’s own step is measured from where the work stopped', () => {
  it('runs from the last thing that ENDED, not the last thing that started', () => {
    // A `tool_call` row is stamped when the call was ISSUED and its result closes that same row in
    // place, so measuring from `at` charges the whole of the last tool's runtime to the answer:
    // here a 3-minute call inside a turn that ended 9 seconds after it, reported as 3m 9s of
    // writing. The rail's rows then sum to more than the turn took, which is how the error shows
    // up to a reader.
    const step = answerStep(
      message({
        endedAt: 189_000,
        trace: [
          entry({
            kind: 'tool_call',
            at: 0,
            toolCall: { tool: 'run_crest', arguments: '{}', result: 'ok', endedAt: 180_000 },
          }),
        ],
      }),
    );
    expect(step).toEqual({ words: 2, duration: '9s' });
  });

  it('counts a durable job’s ending too', () => {
    // Same argument, other row: a `job_started` row is stamped at the launch and settled in place
    // when the job reports, which for a durable job is usually minutes later.
    const step = answerStep(
      message({
        endedAt: 65_000,
        trace: [
          entry({
            kind: 'job_started',
            at: 0,
            job: { jobId: 'calc-1', kind: 'calc', settled: true, endedAt: 60_000 },
          }),
        ],
      }),
    );
    expect(step?.duration).toBe('5s');
  });

  it('says nothing about a duration the turn never recorded', () => {
    // A transcript rehydrated from the server has no `endedAt` of ours. A row inventing one from
    // the clock would report the age of the transcript as the time spent writing it.
    expect(answerStep(message({ trace: [entry({ kind: 'tool_call', at: 0 })] }))).toEqual({
      words: 2,
    });
  });

  it('claims no answer step for a turn that produced no text', () => {
    // The card says "the turn finished without producing any answer text"; a row underneath it
    // reporting "0 words" would be the two halves of one screen disagreeing.
    expect(answerStep(message({ finalText: '', streamedText: '' }))).toBeNull();
  });
});
