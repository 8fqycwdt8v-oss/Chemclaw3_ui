/**
 * Provenance, at the altitude the number is read at.
 *
 * The defect these cover is not a bug; it is a depth. The value sat in the answer at depth 0 and
 * the method that produced it was four disclosures down — behind "Show the agent's work", then the
 * row for the call, then the badge on it. A chemist should never have to ask whether 4.76 came
 * from DFT or from a semiempirical estimate, and at that depth nobody does.
 *
 * So two things are asserted here and they pull against each other on purpose: the method must be
 * *up*, and the caveat must stay *down*. A footer carrying five three-line caveats is the
 * annotation clutter `src/chem/provenance.ts` warns trains a reader to skip the footer entirely,
 * which would be worse than the depth was.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnswerFooter } from '../src/components/AnswerBadges.tsx';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { methodsUsed } from '../src/chem/provenance.ts';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';

function call(tool: string, args: Record<string, unknown> = {}): TraceEntry {
  return {
    id: `${tool}-${Math.random()}`,
    at: 0,
    kind: 'tool_call',
    toolCall: { tool, arguments: JSON.stringify(args), result: 'ok', numbers: [] },
  };
}

function answer(trace: TraceEntry[]): AssistantMessage {
  return {
    id: 'a1',
    role: 'assistant',
    at: 0,
    status: 'done',
    streamedText: '',
    finalText: 'The pKa is 4.76.',
    confidence: null,
    unsupportedClaims: [],
    reviewRequired: false,
    verifiedBy: null,
    degradedConnectors: [],
    queued: false,
    trace,
    latestPlan: null,
    error: null,
  };
}

beforeEach(cleanup);
afterEach(cleanup);

describe('methodsUsed', () => {
  it('deduplicates by the method, not by the tool', () => {
    // predict_pka and predict_logd are both GFN2-xTB. Saying it twice says nothing the once did
    // not, and a footer that repeats itself reads as a footer with more in it than it has.
    expect(methodsUsed([call('predict_pka'), call('predict_logd')])).toEqual([
      'GFN2-xTB · semiempirical',
    ]);
  });

  it('keeps genuinely different methods, in first-use order', () => {
    expect(methodsUsed([call('screen_hazards'), call('predict_pka')])).toEqual([
      'Cited reference table',
      'GFN2-xTB · semiempirical',
    ]);
  });

  it('says nothing about a tool it has no sourced method for', () => {
    // A confidently wrong method label is worse than a missing one, and moving the claim up the
    // page does not change that.
    expect(methodsUsed([call('some_tool_added_next_week')])).toEqual([]);
  });
});

describe('the answer footer', () => {
  it('names the methods even when no verifier ran', () => {
    // The footer used to render nothing at all in this case — which is most deployments, because
    // the verifier is config.
    render(<AnswerFooter message={answer([call('predict_pka')])} />);

    expect(screen.getByText('GFN2-xTB · semiempirical')).toBeTruthy();
  });

  it('carries no caveat text — that stays one disclosure into the trace', () => {
    render(<AnswerFooter message={answer([call('predict_pka')])} />);

    // predict_pka's caveat, verbatim from the backend's manifest. Its place is the trace row.
    expect(document.body.textContent).not.toContain('1.6 units of uncertainty');
  });

  it('renders nothing when there is no method, no score and no unsupported claim', () => {
    const { container } = render(<AnswerFooter message={answer([])} />);
    expect(container.textContent).toBe('');
  });
});

describe('the trace row', () => {
  /** The panel is collapsed until somebody comes to check the work, which is the point of it. */
  const expand = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /Show the agent/ }));
  };

  it('draws the structure the call was actually made on', async () => {
    render(<TracePanel trace={[call('predict_pka', { smiles: 'COc1ccc(Br)cc1' })]} />);
    expand();

    // `smilesFromArguments` was written, tested and proven safe on this exact source, and its only
    // caller was the entity store while this panel showed the same document as raw text.
    await waitFor(() =>
      expect(document.querySelector('[data-smiles="COc1ccc(Br)cc1"]')).toBeTruthy(),
    );
  });

  it('draws nothing from an argument document that did not parse', async () => {
    const truncated: TraceEntry = {
      id: 't1',
      at: 0,
      kind: 'tool_call',
      // The shape a truncated preview has. A SMILES cut at an arbitrary byte very often stays
      // valid as a smaller, different molecule, and nothing downstream could catch that — so the
      // whole-JSON check is the thing that makes this source safe and the preview beside it not.
      toolCall: { tool: 'predict_pka', arguments: '{"smiles": "COc1ccc(Br)c', result: 'ok' },
    };
    render(<TracePanel trace={[truncated]} />);
    expand();

    await waitFor(() => expect(screen.getByText('predict_pka')).toBeTruthy());
    expect(document.querySelector('[data-smiles]')).toBeNull();
  });
});
