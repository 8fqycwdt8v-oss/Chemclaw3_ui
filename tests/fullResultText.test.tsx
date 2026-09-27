/**
 * A tool result the assistant read only part of, opened in full by the chemist.
 *
 * Core #473: when a result is cut to fit the model's context, the full text is kept and
 * `tool_result.result_cut` (and `TranscriptToolCall.result_cut`) says so; `result_ref` then opens
 * the full text. These tests hold the four things that matter about that here:
 *
 *  - the flag survives the wire, live and from storage, and defaults to "not cut";
 *  - a cut step says so and offers the full text, and an uncut one does not;
 *  - the full text is rendered as text — untrusted tool output never becomes markup — bounded on
 *    screen while copy carries the whole of it;
 *  - a swept result says it is gone and why, rather than an error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { normalizeEvent } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';
import { transcriptToMessages } from '../src/state/transcript.ts';
import { TracePanel } from '../src/components/TracePanel.tsx';
import { CutResultNotice, SHOWN_CHARS, shownPart } from '../src/components/FullResultText.tsx';
import type { StoredToolResult, TranscriptMessage } from '../src/api/client.ts';
import type { TraceEntry } from '../src/state/types.ts';
import { stubFetch, toolResultEvent } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const SID = 'a'.repeat(32);
const REF = 'c'.repeat(64);

let restore: (() => void) | null = null;
let calls: { url: string }[] = [];

function serve(text: string | null, status = 200): void {
  const stored: StoredToolResult | null =
    text === null
      ? null
      : {
          ref: REF,
          tool: 'fetch_page',
          correlation_id: 'turn-42',
          byte_size: new TextEncoder().encode(text).length,
          text,
        };
  const stub = stubFetch(() =>
    stored && status === 200
      ? new Response(JSON.stringify(stored), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ detail: 'unknown tool result' }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  );
  calls = stub.calls;
  restore = stub.restore;
}

const openNotice = (): void => {
  render(<CutResultNotice sessionId={SID} resultRef={REF} tool="fetch_page" />);
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Result was shortened for the assistant — open full result',
    }),
  );
};

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('result_cut on the wire', () => {
  it('is carried when set and defaults to not cut when an older service omits it', () => {
    expect(
      normalizeEvent({ type: 'tool_result', tool: 't', result_ref: REF, result_cut: true }),
    ).toEqual(toolResultEvent({ tool: 't', result_ref: REF, result_cut: true }));
    expect(normalizeEvent({ type: 'tool_result', tool: 't' })).toMatchObject({ result_cut: false });
    // Not a boolean is not "cut": a truthy string must not claim the model read less.
    expect(normalizeEvent({ type: 'tool_result', tool: 't', result_cut: 'yes' })).toMatchObject({
      result_cut: false,
    });
  });

  it('marks the live trace row cut, and leaves an uncut row without the flag', () => {
    const store = useChatStore.getState();
    const cid = store.createConversation();
    const mid = store.startAssistantMessage(cid);
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'fetch_page', arguments: '{}' });
    store.applyEvent(cid, mid, { type: 'tool_call', tool: 'predict_pka', arguments: '{}' });
    store.applyEvent(
      cid,
      mid,
      toolResultEvent({ tool: 'fetch_page', preview: 'head…', result_ref: REF, result_cut: true }),
    );
    store.applyEvent(cid, mid, toolResultEvent({ tool: 'predict_pka', preview: 'pKa 4.76' }));
    const message = useChatStore.getState().conversations[cid]?.messages.find((m) => m.id === mid);
    const trace = message?.role === 'assistant' ? message.trace : [];
    expect(trace[0]?.toolCall).toMatchObject({ resultRef: REF, resultCut: true });
    expect(trace[1]?.toolCall?.resultCut).toBeUndefined();
  });

  it('recovers the flag from a stored transcript', () => {
    const remote: TranscriptMessage[] = [
      {
        index: 0,
        role: 'assistant',
        text: 'Read it.',
        tool_calls: [
          {
            tool: 'fetch_page',
            arguments: '{}',
            result: 'head…',
            result_ref: REF,
            result_cut: true,
          },
          { tool: 'predict_pka', arguments: '{}', result: 'pKa 4.76', result_ref: '' },
        ],
      } as TranscriptMessage,
    ];
    const assistant = transcriptToMessages(remote).find((m) => m.role === 'assistant');
    const trace = assistant?.role === 'assistant' ? assistant.trace : [];
    expect(trace[0]?.toolCall).toMatchObject({ resultRef: REF, resultCut: true });
    expect(trace[1]?.toolCall?.resultCut).toBeUndefined();
  });
});

describe('the step rail', () => {
  const step = (toolCall: NonNullable<TraceEntry['toolCall']>): TraceEntry => ({
    id: toolCall.tool,
    at: 0,
    kind: 'tool_call',
    toolCall,
  });

  it('offers the full text on a cut step, instead of the typed full-result control', () => {
    render(
      <TracePanel
        sessionId={SID}
        trace={[
          step({
            tool: 'fetch_page',
            arguments: '{}',
            result: 'head…',
            resultRef: REF,
            resultCut: true,
          }),
          step({
            tool: 'predict_pka',
            arguments: '{}',
            result: 'pKa 4.76',
            resultRef: 'd'.repeat(64),
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /The agent’s work/ }));
    expect(
      screen.getAllByText('Result was shortened for the assistant — open full result'),
    ).toHaveLength(1);
    // One control per ref: the uncut step keeps its own, the cut one does not get both.
    expect(screen.getAllByText('See the full result')).toHaveLength(1);
  });

  it('offers nothing to open without a session to fetch against', () => {
    const { container } = render(
      <CutResultNotice sessionId={null} resultRef={REF} tool="fetch_page" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('the full text', () => {
  it('renders untrusted output as text, with its size and correlation', async () => {
    const hostile = '<script>window.__pwned = 1</script><b>bold</b>\n<img src=x onerror=alert(1)>';
    serve(hostile);
    openNotice();

    const region = await screen.findByRole('region', { name: 'Full text returned by fetch_page' });
    expect(region.textContent).toBe(hostile);
    // Escaped, not parsed: nothing the tool said became an element.
    expect(region.querySelector('script, b, img')).toBeNull();
    expect(screen.getByTestId('full-result-size').textContent).toBe(
      `${new TextEncoder().encode(hostile).length} bytes`,
    );
    expect(screen.getByText('turn-42')).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual([`/api/sessions/${SID}/tool-results/${REF}`]);
  });

  it('draws a bounded part of a very large result, and copies the whole of it', async () => {
    const big = 'x'.repeat(SHOWN_CHARS * 3);
    serve(big);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    openNotice();

    const region = await screen.findByRole('region', { name: 'Full text returned by fetch_page' });
    expect(region.textContent).toHaveLength(SHOWN_CHARS);
    expect(screen.getByText(/Showing the first 65\D?536 of 196\D?608 characters/)).toBeTruthy();
    expect(screen.getByTestId('full-result-size').textContent).toBe('192.0 KB');

    fireEvent.click(screen.getByRole('button', { name: 'Copy full text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(big));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says a swept result is gone and why, rather than reporting an error', async () => {
    serve(null, 404);
    openNotice();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This full result is no longer available.')).toBeTruthy();
    expect(within(alert).getByText(/Retention may have removed it/)).toBeTruthy();
    // Nothing to retry: a 404 here does not heal.
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('offers a retry for a failure that might heal', async () => {
    serve(null, 503);
    openNotice();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The full result could not be read.')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('never splits a surrogate pair at the drawing bound', () => {
    const text = `${'a'.repeat(9)}🧪tail`;
    expect(shownPart(text, 10)).toBe('a'.repeat(9));
    expect(shownPart('short', 10)).toBe('short');
  });
});
