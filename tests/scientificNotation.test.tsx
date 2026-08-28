/**
 * A number a chemist might write down reads the same to every chemist.
 *
 * `toLocaleString()` with no locale follows the *viewer's browser*, so an unlabelled pKa, an ICH
 * limit or an energy rendered `1,234.5` for one reader and `1.234,5` for the next — two forms that
 * disagree by three orders of magnitude and one decimal place, with nothing on screen saying which
 * convention is in force. Transcribed by hand, quoted in an email, or read off a screenshot, the
 * value is simply wrong and looks fine. The CSV export already refused the question by writing
 * `String(value)`; this is the same decision applied to the screen.
 *
 * The tests below make the browser German, which is what a bare `toLocaleString()` is for. Chrome
 * in `de-DE` is not an exotic configuration in a European pharma estate — it is the default one.
 *
 * Scope is deliberate. A byte size (`ResultSheet`'s stored-result footer) and a character count
 * (the composer's) are facts about the interface rather than measurements anybody transcribes, and
 * there the reader's own conventions are the right ones. They are left alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { formatEnergy, formatScientificNumber } from '../src/lib/format.ts';
import { ResultSheet } from '../src/components/ResultSheet.tsx';
import { EntityRail } from '../src/components/EntityRail.tsx';
import { useEntityStore } from '../src/chem/entities.ts';
import { stubFetch, toolResultEvent } from './helpers.ts';
import type { StoredToolResult } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = 'b'.repeat(64);
const C1 = 'conversation-1';

let restore: (() => void) | null = null;
const nativeToLocaleString = Number.prototype.toLocaleString;

/** Serve one stored tool result and open the panel on it. */
function open(tool: string, payload: unknown): void {
  const text = JSON.stringify(payload);
  const stored: StoredToolResult = {
    ref: REF,
    tool,
    correlation_id: 'turn-9',
    byte_size: text.length,
    text,
  };
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify(stored), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  restore = stub.restore;
  render(
    <ResultSheet sessionId={SID} resultRef={REF} tool={tool} open onOpenChange={() => undefined} />,
  );
}

beforeEach(() => {
  cleanup();
  useEntityStore.getState().clear();
  // A German browser. `toLocaleString()` called with no locale is exactly the call that reads it,
  // so substituting the default is the whole simulation.
  Number.prototype.toLocaleString = function (
    this: number,
    locale?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ): string {
    return nativeToLocaleString.call(this, locale ?? 'de-DE', options);
  };
});

afterEach(() => {
  Number.prototype.toLocaleString = nativeToLocaleString;
  cleanup();
  restore?.();
  restore = null;
});

describe('the helper', () => {
  it('renders a number the same way whatever the browser thinks', () => {
    expect(formatScientificNumber(1234.5)).toBe('1,234.5');
    // The unpinned call is what the app used to make, and it is a different number on the page.
    expect((1234.5).toLocaleString()).toBe('1.234,5');
  });

  it('pins the converted energy beside the hartree value', () => {
    // 2 Eh is 1255.0 kcal/mol — four digits, so the grouping separator is in play, and the
    // `Eh` half was never at risk because `toFixed` is not locale-aware. Only one of the two
    // numbers on this line could disagree with itself, which is what made it easy to miss.
    expect(formatEnergy(2)).toContain('1,255 kcal/mol');
  });
});

describe('a tool result on screen', () => {
  it('renders the generic table’s figures in the pinned notation', async () => {
    open('lookup_solvent_properties', [
      { solvent: 'toluene', boiling_point_k: 383.8, price_per_litre: 1234.5 },
    ]);

    expect(await screen.findByText('1,234.5')).toBeTruthy();
    expect(screen.queryByText('1.234,5')).toBeNull();
  });

  it('renders an ICH limit in the pinned notation', async () => {
    open('lookup_impurity_limit', {
      substance: 'Toluene',
      limit_class: '2',
      class_meaning: 'Solvents to be limited.',
      guideline: 'ICH Q3C(R8)',
      citation: 'Table 2',
      limits: [{ basis: 'PDE', value: 8900, unit: 'µg/day' }],
    });

    // A limit is the number in this whole app that is most likely to be transcribed by hand.
    expect(await screen.findByText('8,900')).toBeTruthy();
    expect(screen.queryByText('8.900')).toBeNull();
  });
});

describe('the entity rail', () => {
  it('renders a tool’s figures in the pinned notation', async () => {
    const store = useEntityStore.getState();
    await store.ingest(C1, 'm1', {
      type: 'tool_call',
      tool: 'compute_electronic_properties',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });
    await store.ingest(
      C1,
      'm1',
      toolResultEvent({ tool: 'compute_electronic_properties', numbers: [1234.5, 1.6] }),
    );

    render(<EntityRail conversationId={C1} />);

    expect(await screen.findByText('1,234.5, 1.6')).toBeTruthy();
  });
});

/**
 * A number too small for three decimal places is still a measurement.
 *
 * `toLocaleString` with no options inherits `Intl`'s `maximumFractionDigits: 3`, which is a
 * *fixed-decimal* clamp rather than a precision: everything below 5e-4 rounds to `0`, and the cell
 * says the measurement was zero rather than that it was rounded. `AutoTable` is the generic
 * renderer for any tool result, so this reached whatever a chemist's `run_python` script returned —
 * a rate-constant column of `4.2e-6` values rendered as a column of `0`, and the decay it describes
 * is gone with it. Below `1e-4` the notation switches so the string stays short; between that and
 * 1 the digits are significant rather than positional. A cap on decimals is fine for a number
 * bigger than one and lethal for one smaller.
 */
describe('a measurement smaller than the default precision', () => {
  it('survives the helper instead of rounding to zero', () => {
    expect(formatScientificNumber(3.2e-6)).toBe('3.2E-6');
    expect(formatScientificNumber(1.2e-9)).toBe('1.2E-9');
    expect(formatScientificNumber(-4.2e-6)).toBe('-4.2E-6');
    // Just inside the fixed range: still positional, and still four significant digits rather
    // than the three decimals that used to collapse it.
    expect(formatScientificNumber(0.0001234)).toBe('0.0001234');
    expect(formatScientificNumber(0.0005)).toBe('0.0005');
  });

  it('leaves a number a chemist reads positionally alone', () => {
    // The grouping this file exists to pin is untouched, and so is every value at or above 1.
    expect(formatScientificNumber(1234.5)).toBe('1,234.5');
    expect(formatScientificNumber(8900)).toBe('8,900');
    expect(formatScientificNumber(0)).toBe('0');
    // A very large one is rendered in full rather than collapsed: no digit is dropped, and the
    // grouping is what makes it readable.
    expect(formatScientificNumber(6.022e23)).toBe('602,200,000,000,000,000,000,000');
  });

  it('prints a value that is not a number as one nobody can mistake for a measurement', () => {
    // Neither can cross JSON, so this is a decision about what the screen says if one ever
    // arrives — not a rounding. `NaN` and `∞` are both unmistakable; `0` would not be.
    expect(formatScientificNumber(Number.NaN)).toBe('NaN');
    expect(formatScientificNumber(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatScientificNumber(Number.NEGATIVE_INFINITY)).toBe('-∞');
  });

  it('still obeys a call site that states its own precision', () => {
    // `formatEnergy` asks for one decimal and must keep getting it, small value or not.
    expect(formatScientificNumber(0.0000032, { maximumFractionDigits: 1 })).toBe('0');
  });

  it('renders a script’s rate-constant column as numbers, in the real table', async () => {
    // `run_python` returns whatever the chemist's script assigned, and a list of records under a
    // key is what reaches `AutoTable`. Every `k_per_s` here used to read `0`.
    open('run_python', {
      result: [
        { time_h: 0, impurity_frac: 0.0121, k_per_s: 4.2e-6 },
        { time_h: 24, impurity_frac: 0.0009, k_per_s: 4.2e-6 },
      ],
    });

    expect((await screen.findAllByText('4.2E-6')).length).toBe(2);
    // 9e-4 is inside the fixed range, so it stays positional — and it is exactly the value
    // three decimals used to round *up* to `0.001`, which is a different number.
    expect(screen.getByText('0.0009')).toBeTruthy();
    expect(screen.queryByText('0.001')).toBeNull();
  });
});

/**
 * The rail is on screen for every structure a turn mentioned, so it is where a rounded-away value
 * is seen most often — and it has no units, no method and no way to say a number was truncated.
 */
describe('the entity rail on small figures', () => {
  it('shows them rather than a row of zeroes', async () => {
    const store = useEntityStore.getState();
    await store.ingest(C1, 'm2', {
      type: 'tool_call',
      tool: 'compute_electronic_properties',
      arguments: JSON.stringify({ smiles: 'CCO' }),
    });
    await store.ingest(
      C1,
      'm2',
      toolResultEvent({ tool: 'compute_electronic_properties', numbers: [0.5136, 3.2e-6] }),
    );

    render(<EntityRail conversationId={C1} />);

    expect(await screen.findByText('0.5136, 3.2E-6')).toBeTruthy();
  });
});
