import { afterEach, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/api/streamTurn.ts';
import { ApiError } from '../src/api/errors.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import { jsonError, sseFrames, sseResponse, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const collect = async (
  body: string,
  chunkSize = 1024,
): Promise<{ events: ChemclawEvent[]; answerText: string }> => {
  const stub = stubFetch(() => sseResponse(body, chunkSize));
  restore = stub.restore;
  const events: ChemclawEvent[] = [];
  const answer = await streamTurn({
    sessionId: SESSION,
    message: 'hello',
    signal: new AbortController().signal,
    getToken: async () => null,
    onEvent: (e) => events.push(e),
  });
  return { events, answerText: answer.text };
};

const HAPPY: ChemclawEvent[] = [
  { type: 'plan', todos: ['gather evidence', 'answer'] },
  { type: 'token', text: 'Acetic ' },
  { type: 'tool_call', tool: 'gather_evidence', arguments: '{"query": "acetic acid pKa"' },
  { type: 'token', text: 'acid has a pKa of 4.76.' },
  { type: 'job_started', job_id: 'qm-abc123', kind: 'qm' },
  {
    type: 'answer',
    text: 'Acetic acid has a pKa of 4.76.',
    confidence: 0.91,
    unsupported_claims: [],
    review_required: false,
  },
];

describe('streamTurn', () => {
  it('yields every event in order and returns the terminal answer', async () => {
    const { events, answerText } = await collect(sseFrames(HAPPY));
    expect(events.map((e) => e.type)).toEqual([
      'plan',
      'token',
      'tool_call',
      'token',
      'job_started',
      'answer',
    ]);
    expect(answerText).toBe('Acetic acid has a pKa of 4.76.');
  });

  it('parses identically when frames are split across chunk boundaries', async () => {
    // A real TCP stream splits wherever it likes. Three bytes at a time cuts frames mid-field,
    // which is precisely the case a naive split-on-"\n\n" parser gets wrong.
    const { events, answerText } = await collect(sseFrames(HAPPY), 3);
    expect(events.map((e) => e.type)).toEqual([
      'plan',
      'token',
      'tool_call',
      'token',
      'job_started',
      'answer',
    ]);
    expect(answerText).toBe('Acetic acid has a pKa of 4.76.');
  });

  it('surfaces an in-stream error event as an agent error', async () => {
    // This is also how a turn that blew the 600s wall clock arrives — as SSE, not an HTTP status.
    const body = sseFrames([
      { type: 'token', text: 'partial' },
      { type: 'error', message: 'The turn exceeded the 600s time limit and was cancelled.' },
    ]);
    const stub = stubFetch(() => sseResponse(body));
    restore = stub.restore;

    await expect(
      streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: new AbortController().signal,
        getToken: async () => null,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'agent' });
  });

  it('fails cleanly when the stream ends without an answer', async () => {
    const stub = stubFetch(() => sseResponse(sseFrames([{ type: 'token', text: 'hi' }])));
    restore = stub.restore;
    await expect(
      streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: new AbortController().signal,
        getToken: async () => null,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'stream' });
  });

  it('skips a malformed frame rather than killing the turn', async () => {
    const body =
      'event: token\ndata: {not json\n\n' +
      sseFrames([
        { type: 'token', text: 'ok' },
        {
          type: 'answer',
          text: 'ok',
          confidence: null,
          unsupported_claims: [],
          review_required: false,
        },
      ]);
    const { events, answerText } = await collect(body);
    expect(events.map((e) => e.type)).toEqual(['token', 'answer']);
    expect(answerText).toBe('ok');
  });

  it('ignores an unknown event type so a newer backend does not break an older UI', async () => {
    const body =
      'event: telemetry\ndata: {"type":"telemetry","v":1}\n\n' +
      sseFrames([
        {
          type: 'answer',
          text: 'done',
          confidence: null,
          unsupported_claims: [],
          review_required: false,
        },
      ]);
    const { events } = await collect(body);
    expect(events.map((e) => e.type)).toEqual(['answer']);
  });

  it('rejects a 200 that is not an event stream', async () => {
    const stub = stubFetch(
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    restore = stub.restore;
    await expect(
      streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: new AbortController().signal,
        getToken: async () => null,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'stream' });
  });

  it.each([
    [401, 'unauthorized', false],
    [404, 'session_not_found', false],
    [409, 'turn_in_flight', false],
    [422, 'message_too_long', false],
    [429, 'budget_exhausted', false],
    [503, 'capacity', true],
  ])('maps HTTP %i to %s', async (status, kind, retryable) => {
    const stub = stubFetch(() => jsonError(status, 'detail text'));
    restore = stub.restore;

    const err = await streamTurn({
      sessionId: SESSION,
      message: 'x',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => undefined,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe(kind);
    expect((err as ApiError).retryable).toBe(retryable);
  });

  it('sends a bearer token when one is available, and none in dev mode', async () => {
    const withToken = stubFetch(() =>
      sseResponse(
        sseFrames([
          {
            type: 'answer',
            text: '',
            confidence: null,
            unsupported_claims: [],
            review_required: false,
          },
        ]),
      ),
    );
    restore = withToken.restore;

    await streamTurn({
      sessionId: SESSION,
      message: 'x',
      signal: new AbortController().signal,
      getToken: async () => 'tok123',
      onEvent: () => undefined,
    });
    const headers = withToken.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok123');

    withToken.restore();

    const devMode = stubFetch(() =>
      sseResponse(
        sseFrames([
          {
            type: 'answer',
            text: '',
            confidence: null,
            unsupported_claims: [],
            review_required: false,
          },
        ]),
      ),
    );
    restore = devMode.restore;
    await streamTurn({
      sessionId: SESSION,
      message: 'x',
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => undefined,
    });
    const devHeaders = devMode.calls[0]?.init?.headers as Record<string, string>;
    expect(devHeaders.authorization).toBeUndefined();
  });

  it('passes dry_run through to the service', async () => {
    const stub = stubFetch(() =>
      sseResponse(
        sseFrames([
          {
            type: 'answer',
            text: '',
            confidence: null,
            unsupported_claims: [],
            review_required: false,
          },
        ]),
      ),
    );
    restore = stub.restore;
    await streamTurn({
      sessionId: SESSION,
      message: 'x',
      dryRun: true,
      signal: new AbortController().signal,
      getToken: async () => null,
      onEvent: () => undefined,
    });
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({
      message: 'x',
      dry_run: true,
    });
  });
});
