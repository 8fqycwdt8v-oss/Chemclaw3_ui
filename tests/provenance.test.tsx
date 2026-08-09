/**
 * The provenance overlay.
 *
 * The load-bearing tests here are the tolerance ones. `tool_result.numbers` is the only structured
 * chemistry on the wire, and checking an answer's figures against it is worth doing only if the
 * check is *right about the boundary*: a model writes "4.76" for a tool that returned 4.7601 and
 * "45%" for one that returned 0.45, and calling either of those a fabrication is the exact failure
 * the backend documented — its own grounding check graded 19 of 36 answers as fabrication against
 * the truncated preview, and nine of nine verdicts checked by hand were false.
 *
 * The second load-bearing case is the empty one. A turn that called no tool, or whose tools
 * returned no numbers, has nothing to check against, and an overlay that painted every figure in
 * such an answer as unsupported would be manufacturing an accusation out of missing evidence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useChatStore } from '../src/state/chatStore.ts';
import {
  capabilityLoss,
  figuresIn,
  groundingOf,
  isGroundedFigure,
  methodFor,
  returnedFigures,
  writtenTolerance,
} from '../src/chem/provenance.ts';
import { errorNextStep } from '../src/lib/format.ts';
import { Markdown } from '../src/components/Markdown.tsx';
import { AnswerFooter, CapabilityDegradedPill, ReviewRequiredPill } from '../src/components/AnswerBadges.tsx';
import { TracePanel } from '../src/components/TracePanel.tsx';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';
import { toolResultEvent } from './helpers.ts';

/** A grounded/unmatched decision for one written literal, which is what the marks render from. */
const verdict = (literal: string, returned: number[]): string | null => {
  const figure = figuresIn(`x ${literal} y`)[0];
  if (!figure) return 'NOT-A-FIGURE';
  return groundingOf(figure, returned);
};

beforeEach(() => {
  cleanup();
  useChatStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    composerLock: false,
    banner: null,
    jobFeed: [],
    streaming: null,
  });
});

describe('carrying numbers off the wire', () => {
  it('puts tool_result.numbers on the trace row rather than dropping them', () => {
    // They died at this boundary: `closeToolCall` took only the preview, so the one untruncated
    // field on the wire never reached a component.
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{}' });
    store.applyEvent(
      cid,
      mid,
      toolResultEvent({ tool: 'predict_pka', preview: 'pKa 4.7', numbers: [4.7601, 1.6] }),
    );

    const message = useChatStore.getState().conversations[cid]?.messages.at(-1);
    if (!message || message.role !== 'assistant') throw new Error('no assistant message');
    expect(message.trace[0]?.toolCall?.numbers).toEqual([4.7601, 1.6]);
    expect(returnedFigures(message.trace)).toEqual([4.7601, 1.6]);
  });

  it('deduplicates across calls, because the answer does not say which call a figure came from', () => {
    const trace = [
      { id: 'a', at: 0, kind: 'tool_call', toolCall: { tool: 't', arguments: '', numbers: [1, 2] } },
      { id: 'b', at: 0, kind: 'tool_call', toolCall: { tool: 'u', arguments: '', numbers: [2, 3] } },
    ] as TraceEntry[];
    expect(returnedFigures(trace)).toEqual([1, 2, 3]);
  });

  it('reports no figures for a turn whose calls returned none', () => {
    const trace = [
      { id: 'a', at: 0, kind: 'tool_call', toolCall: { tool: 't', arguments: '', numbers: [] } },
    ] as TraceEntry[];
    expect(returnedFigures(trace)).toEqual([]);
  });
});

describe('tolerance', () => {
  it('reads a literal at the precision it was written to', () => {
    // Half a unit in the last written place. It scales itself, which is why there is no constant
    // to tune: 0.005 for two decimals, 0.5 for an integer.
    expect(writtenTolerance('4.76')).toBeCloseTo(0.005, 12);
    expect(writtenTolerance('4.8')).toBeCloseTo(0.05, 12);
    expect(writtenTolerance('5000')).toBeCloseTo(0.5, 12);
    expect(writtenTolerance('5,000')).toBeCloseTo(0.5, 12);
    // The exponent moves the last written place with it: one mantissa decimal at 1e3 is 100.
    expect(writtenTolerance('1.2e3')).toBeCloseTo(50, 12);
  });

  it('grounds a figure the model rounded from the returned value', () => {
    // The two cases named in the brief, and the ones a real answer produces constantly.
    expect(isGroundedFigure('4.76', 4.76, [4.7601])).toBe(true);
    expect(isGroundedFigure('5000', 5000, [5000.0])).toBe(true);
    // Rounded harder: "4.8" asserts one decimal and nothing finer, so 4.7601 *is* that figure.
    expect(isGroundedFigure('4.8', 4.8, [4.7601])).toBe(true);
    expect(isGroundedFigure('5', 5, [4.7601])).toBe(true);
  });

  it('does not ground a figure that is simply a different number', () => {
    // The boundary has to bite somewhere or the mark means nothing. 4.76 written to two decimals
    // claims two decimals, and 4.9 is not it.
    expect(isGroundedFigure('4.76', 4.76, [4.9])).toBe(false);
    expect(isGroundedFigure('5000', 5000, [4600])).toBe(false);
  });

  it('applies the relative slack on top of the written precision', () => {
    // 0.5% of 5000 is 25, which the half-unit precision rule alone would not reach. This is what
    // absorbs a value that arrived through an intermediate the wire never carried.
    expect(isGroundedFigure('5000', 5000, [4998.3])).toBe(true);
    expect(isGroundedFigure('5000', 5000, [4970])).toBe(false);
  });

  it('grounds a percent written from a returned fraction, and vice versa', () => {
    // Units are not on the wire. Refusing this would flag correct arithmetic as fabrication.
    expect(isGroundedFigure('45', 45, [0.45])).toBe(true);
    expect(isGroundedFigure('0.45', 0.45, [45])).toBe(true);
    // And the metric prefix step: 5.2 mmol against a returned 0.0052 mol.
    expect(isGroundedFigure('5.2', 5.2, [0.0052])).toBe(true);
  });

  it('does not treat every scale as interchangeable', () => {
    // A closed list of factors, not "any power of ten" — otherwise every figure matches every
    // other figure at some scale and the highlight stops carrying information.
    expect(isGroundedFigure('4.5', 4.5, [45000])).toBe(false);
  });
});

describe('what may be flagged', () => {
  it('marks a decimal that matches nothing returned', () => {
    expect(verdict('4.76', [9.2])).toBe('unmatched');
  });

  it('never marks a bare integer as missing', () => {
    // A whole number in a chemistry answer is a count, an equivalent, a step number or a
    // temperature far more often than a measurement. Flagging them buries the one mark that
    // matters under a dozen that do not — which is the clutter failure, not a safety win.
    expect(verdict('3', [9.2])).toBeNull();
    expect(verdict('298', [9.2])).toBeNull();
    // It is still highlighted when it *does* match, because that costs nothing.
    expect(verdict('3', [3])).toBe('grounded');
  });

  it('does not read digits that are part of a name', () => {
    // `GFN2-xTB`, `Q3D`, `pH7` — the digits are part of an identifier, not a quantity.
    expect(figuresIn('computed with GFN2-xTB').map((f) => f.text)).toEqual([]);
    expect(figuresIn('the ICH Q3D limit').map((f) => f.text)).toEqual([]);
    expect(figuresIn('10mL of solvent').map((f) => f.text)).toEqual([]);
  });

  it('reads a leading minus as a sign only where a number could start', () => {
    expect(figuresIn('ΔG = -12.3 kcal/mol').map((f) => f.value)).toEqual([-12.3]);
    // A range is two positive numbers, not one negative one.
    expect(figuresIn('pKa 5-10').map((f) => f.value)).toEqual([5, 10]);
  });

  it('skips a leading zero and a version string', () => {
    expect(figuresIn('on 2026-08-04').map((f) => f.text)).toEqual(['2026']);
    expect(figuresIn('version 1.2.3').map((f) => f.text)).toEqual(['1.2']);
  });
});

describe('rendering the marks', () => {
  const html = (body: string, figures: number[]): string => {
    const { container } = render(<Markdown figures={figures}>{body}</Markdown>);
    return container.innerHTML;
  };

  it('marks a matching figure grounded and a missing one unmatched', () => {
    const out = html('The pKa is 4.76 and the logD is 2.31.', [4.7601]);
    expect(out).toContain('matches a value a tool returned');
    expect(out).toContain('Not among the values');
  });

  it('annotates nothing when the turn returned no numbers at all', () => {
    // The case that decides whether this feature is safe to ship. With no basis for the check,
    // every figure would otherwise be painted as unsupported.
    const out = html('The pKa is 4.76 and the logD is 2.31.', []);
    expect(out).not.toContain('Not among the values');
    expect(out).not.toContain('matches a value a tool returned');
  });

  it('leaves figures inside code spans and citations alone', () => {
    // A remark plugin rather than a regex over HTML for exactly this: `C1CCOC1` is full of digits
    // that are not quantities, and a note id's digits are not a measurement either. A regex over
    // rendered HTML would rewrite both.
    const out = html('See rxn-4821 and `C1CCOC1` for the figure.', [1]);
    expect(out).not.toContain('Not among the values');
    expect(out).not.toContain('matches a value a tool returned');
    // And the chip still carries its id — the destructure that dropped it rendered every citation
    // as an empty button.
    expect(screen.getByTitle(/expand rxn-4821/i)).toBeTruthy();
  });
});

describe('verified_by', () => {
  const message = (over: Partial<AssistantMessage>): AssistantMessage =>
    ({ reviewRequired: false, verifiedBy: null, confidence: null, unsupportedClaims: [], trace: [], ...over }) as AssistantMessage;

  it('says the judge scored it when the judge scored it', () => {
    render(<ReviewRequiredPill message={message({ reviewRequired: true, verifiedBy: 'judge' })} />);
    expect(screen.getByText(/could not fully support/i)).toBeTruthy();
    expect(screen.queryByText(/not judged/i)).toBeNull();
  });

  it('says the judge never ran when it did not', () => {
    // The whole point of the field: a turn scored badly and a turn nobody scored used to render
    // as one sentence, and a reviewer's next action differs between them.
    render(
      <ReviewRequiredPill message={message({ reviewRequired: true, verifiedBy: 'citation-gate' })} />,
    );
    expect(screen.getByText(/not judged/i)).toBeTruthy();
    expect(screen.getByText(/deterministic citation gate/i)).toBeTruthy();
  });

  it('says verification was off when it was', () => {
    render(<ReviewRequiredPill message={message({ reviewRequired: true, verifiedBy: null })} />);
    expect(screen.getByText(/not enabled on this deployment/i)).toBeTruthy();
  });

  it('names the check beside the confidence score', () => {
    // A citation-gate 1.00 and a judged 1.00 are not the same object; the backend measured the
    // fallback as the more generous of the two.
    render(<AnswerFooter message={message({ confidence: 1, verifiedBy: 'citation-gate' })} />);
    expect(screen.getByText(/checked by: citation gate/i)).toBeTruthy();
  });
});

describe('method badges', () => {
  it('names the method and quotes the manifest caveat for a tool that has one', () => {
    render(
      <TracePanel
        trace={[
          {
            id: 't1',
            at: 0,
            kind: 'tool_call',
            toolCall: { tool: 'compute_interaction_energy', arguments: '{}', result: 'ok', numbers: [] },
          },
        ]}
      />,
    );
    // Collapsed by default; opening it is a click the test does not need — assert on the map.
    const method = methodFor('compute_interaction_energy');
    expect(method?.method).toContain('xTB');
    expect(method?.caveat).toContain('ranking between candidate partners, not an absolute binding energy');
    expect(screen.getByText(/1 step/)).toBeTruthy();
  });

  it('quotes the caveat verbatim for the tools whose manifests state one', () => {
    expect(methodFor('scan_coordinate')?.caveat).toContain(
      'upper bound on the ground-state profile and is not a transition state',
    );
    expect(methodFor('screen_hazards')?.caveat).toContain('does NOT mean the chemistry is safe');
    expect(methodFor('compute_dft_energy')?.method).toContain('DFT');
    expect(methodFor('suggest_next_experiment')?.method).toContain('BoFire');
    expect(methodFor('resolve_compound')?.method).toBe('RDKit');
    expect(methodFor('find_notes')?.method).toContain('retrieval');
  });

  it('says nothing about a tool it has no sourced method for', () => {
    // A confidently wrong method label is worse than the silence it replaced.
    expect(methodFor('some_tool_added_next_year')).toBeNull();
  });

  it('carries no caveat where the manifest states none', () => {
    expect(methodFor('stoichiometry_table')?.caveat).toBeUndefined();
  });
});

describe('capability_degraded as a chemistry statement', () => {
  it('maps each bundle to what its absence cost the answer', () => {
    expect(capabilityLoss('safety')).toContain('hazard screen');
    expect(capabilityLoss('calc')).toContain('computed properties');
    expect(capabilityLoss('qm')).toContain('DFT');
    expect(capabilityLoss('molfp')).toContain('precedent search');
    expect(capabilityLoss('rxnfp')).toContain('precedent search');
    expect(capabilityLoss('bo')).toContain('experiment design');
  });

  it('treats durable-jobs as the subsystem it is, not a bundle', () => {
    // The backend puts it in the same list because a surface does the identical thing with the
    // name, and prefixes it so it cannot be mistaken for a connector in the registry.
    expect(capabilityLoss('durable-jobs (Temporal)')).toContain('durable job');
  });

  it('stays honest about a name it has never seen', () => {
    // The event's own contract warns that a name here need not resolve in the registry.
    expect(capabilityLoss('eln')).toContain('eln');
  });

  it('renders the loss, not the connector name, above the answer', () => {
    render(
      <CapabilityDegradedPill
        message={{ degradedConnectors: ['safety'] } as unknown as AssistantMessage}
      />,
    );
    expect(screen.getByText(/hazard screen/)).toBeTruthy();
  });
});

describe('typed turn errors', () => {
  it('offers a narrower question for an empty answer, not an internal error', () => {
    // The turn ran and wrote nothing. Nothing broke, and the backend gave it its own code for
    // exactly this reason.
    const step = errorNextStep('empty_answer', true) ?? '';
    expect(step).toMatch(/narrower/i);
    expect(step).not.toMatch(/internal error/i);
  });

  it('reads budget_exhausted together with retryable, because one code carries both answers', () => {
    expect(errorNextStep('budget_exhausted', true)).toMatch(/at capacity/i);
    expect(errorNextStep('budget_exhausted', false)).toMatch(/does not replenish/i);
  });

  it('tells a user not to retry what cannot succeed unchanged', () => {
    expect(errorNextStep('bad_tool_arguments', false)).toMatch(/unchanged cannot work/i);
    expect(errorNextStep('loop_cap_reached', false)).toMatch(/narrower/i);
  });

  it('suggests nothing for a failure that never reached the service', () => {
    // A dropped socket has no code, and inventing a next step for it would be a guess.
    expect(errorNextStep(undefined, undefined)).toBeNull();
  });
});
