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

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { Markdown } from '../src/components/Markdown.tsx';
import { CapabilityDegradedPill } from '../src/components/AnswerBadges.tsx';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';
import { toolResultEvent } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

/** A grounded/unmatched decision for one written literal, which is what the marks render from. */
const verdict = (literal: string, returned: number[]): string | null => {
  const figure = figuresIn(`x ${literal} y`)[0];
  if (!figure) return 'NOT-A-FIGURE';
  return groundingOf(figure, returned);
};

beforeEach(() => {
  cleanup();
  useChatStore.setState({ conversations: {}, order: [], activeId: null, streaming: null });
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
      {
        id: 'a',
        at: 0,
        kind: 'tool_call',
        toolCall: { tool: 't', arguments: '', numbers: [1, 2] },
      },
      {
        id: 'b',
        at: 0,
        kind: 'tool_call',
        toolCall: { tool: 'u', arguments: '', numbers: [2, 3] },
      },
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

  it('reads the locants in a compound name as no figure at all', () => {
    // The pattern used to allow a comma anywhere inside a digit run, so `1,2` came out as the
    // literal "1,2" and `Number` read it as twelve — and a turn whose tools returned 12, 1.2 or
    // 1 200 would have painted the *name* of the compound as a grounded figure. Locant lists are
    // the common case in chemical names, not an oddity.
    expect(figuresIn('1,2-dichloroethane in 2,6-lutidine').map((f) => f.text)).toEqual([]);
    expect(figuresIn('1,3-butadiene and 1,2,4-trimethylbenzene').map((f) => f.text)).toEqual([]);
    expect(verdict('1,2', [12])).toBe('NOT-A-FIGURE');
  });

  it('still reads a thousands separator as one number', () => {
    // The reason the comma was allowed in the first place, and it survives: three digits after it.
    expect(figuresIn('5,000 g and 1,234.5 mL').map((f) => f.value)).toEqual([5000, 1234.5]);
    expect(verdict('1,234.5', [1234.5])).toBe('grounded');
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
    // rendered HTML would rewrite both. It also pins the plugin ORDER: citations run first, so
    // the grounding pass sees a link node rather than the digits inside the id.
    //
    // The id is a real one. This test used to say `note-4821`, and that fixture is why the chip
    // patterns went unfixed for so long: nothing the backend writes is filed under `note-`, so the
    // assertion passed against a shape the service never emits. A test can only disagree with the
    // fixture it was handed.
    const out = html('See rxn-suzuki-4821 and `C1CCOC1` for the figure.', [1]);
    expect(out).not.toContain('Not among the values');
    expect(out).not.toContain('matches a value a tool returned');
    expect(screen.getByRole('button', { name: 'rxn-suzuki-4821' })).toBeTruthy();
  });
});

describe('method badges', () => {
  it('quotes the caveat verbatim for the tools whose manifests state one', () => {
    expect(methodFor('compute_interaction_energy')?.method).toContain('xTB');
    expect(methodFor('compute_interaction_energy')?.caveat).toContain(
      'ranking between candidate partners, not an absolute binding energy',
    );
    expect(methodFor('scan_coordinate')?.caveat).toContain(
      'upper bound on the ground-state profile and is not a transition state',
    );
    expect(methodFor('screen_hazards')?.caveat).toContain('does NOT mean the chemistry is safe');
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

  it('has a sourced method for every tool the bo bundle advertises', () => {
    // Transcribed from `connectors/bo/connector.yaml` — its five `endpoint.tools` plus the one
    // `jobs[].name` — rather than derived from `KNOWN_TOOLS`, for the reason `TOOL_METHOD` is keyed
    // on `KnownTool` in the first place: this list going stale against the backend is the failure,
    // and a list that reads itself out of the same file it is checking cannot catch it.
    //
    // A per-tool assertion rather than one over the set, so a failure names the tool that is
    // missing. Every one of these is a surrogate's opinion or a reading of runs supplied, and this
    // panel's whole rule is that a number arrives with what produced it: a BO tool missing here
    // shows a chemist a recommended condition with no method beside it at all.
    for (const tool of [
      'suggest_next_experiment',
      'resume_campaign',
      'generate_screening_design',
      'campaign_progress',
      'predict_outcome',
      'start_optimization_campaign',
    ]) {
      expect(methodFor(tool), `no method for ${tool}`).not.toBeNull();
    }
    // And the two that decide how a chemist reads a recommendation say what they are not.
    expect(methodFor('suggest_next_experiment')?.caveat).toContain('proposals a human runs');
    expect(methodFor('predict_outcome')?.caveat).toContain('endorses nothing');
  });
});

describe('capability_degraded as a chemistry statement', () => {
  it('maps each bundle to what its absence cost the answer', () => {
    expect(capabilityLoss('safety')).toContain('hazard screen');
    expect(capabilityLoss('calc')).toContain('computed properties');
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
