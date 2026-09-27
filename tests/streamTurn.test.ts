import { afterEach, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/api/streamTurn.ts';
import { ApiError } from '../src/api/errors.ts';
import { readEventStream, type SseFrame } from '../src/lib/sse.ts';
import type { ChemclawEvent } from '../shared/events.ts';
import {
  answerEvent,
  brokenSseResponse,
  errorEvent,
  jsonError,
  sseFrames,
  sseResponse,
  stubFetch,
} from './helpers.ts';

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
  { type: 'plan', todos: ['gather evidence', 'answer'], plan_hash: 'h', scope: [] },
  { type: 'token', text: 'Acetic ' },
  { type: 'tool_call', tool: 'gather_evidence', arguments: '{"query": "acetic acid pKa"' },
  { type: 'token', text: 'acid has a pKa of 4.76.' },
  { type: 'job_started', job_id: 'qm-abc123', kind: 'qm' },
  answerEvent({ text: 'Acetic acid has a pKa of 4.76.', confidence: 0.91 }),
];

describe('streamTurn', () => {
  it('carries a note frame under the new wire name, on the real SSE path', async () => {
    // The unit-level tolerance is in `tests/eventContract.test.ts`; this is the same claim made
    // where it has to hold — a frame off the wire, with the discriminator in BOTH places the
    // service sets it, through the parser this app actually runs. The rename lands on the reader
    // first (see `NoteProposedEvent`), so what a surface receives must be indistinguishable from
    // the old name's event.
    const { events } = await collect(
      'event: note_recorded\ndata: {"type":"note_recorded","note_id":"note-x","reference":"r"}\n\n' +
        sseFrames([answerEvent({ text: 'done' })]),
    );
    expect(events.map((e) => e.type)).toEqual(['note_proposed', 'answer']);
    expect(events[0]).toEqual({ type: 'note_proposed', note_id: 'note-x', reference: 'r' });
  });

  it('keeps reading past a loop-cap error and returns the partial answer it precedes', async () => {
    // The backend calls `loop_cap_reached` "the only member that shares its turn with an answer":
    // the runaway guard stops a turn that has been streaming all along, so the event arrives after
    // those tokens and BEFORE the answer they add up to.
    //
    // Treating it as terminal cost more than the badge. Throwing runs the `finally`, whose
    // `reader.cancel()` the BFF turns into a destroyed upstream request and FastAPI into a client
    // disconnect — so the backend's turn was cancelled at that yield, before it recorded the
    // transcript. The partial answer was lost from the screen AND from the stored conversation,
    // on a turn three events from delivering it.
    const { events, answerText } = await collect(
      sseFrames([
        { type: 'token', text: 'Partial ' },
        errorEvent({ code: 'loop_cap_reached', message: 'reached its 25-iteration limit' }),
        { type: 'token', text: 'work.' },
        answerEvent({ text: 'Partial work.' }),
      ]),
    );
    expect(events.map((e) => e.type)).toEqual(['token', 'error', 'token', 'answer']);
    expect(answerText).toBe('Partial work.');
  });

  it('keeps reading past a spend-cap error too, for the same reason', async () => {
    // `loop_cap_reached`'s sibling in the unit that costs money: the backend bounds a turn's
    // billed tokens as well as its iterations, and both guards stop a turn that has been
    // streaming all along. A separate case rather than a parametrisation of the one above,
    // because what is being asserted is precisely that `PARTIAL_ANSWER_CODES` has *both* — the
    // failure this guards against is a new backend code arriving and nobody adding it here, and
    // the cost of that is the partial answer lost from the screen and from the transcript.
    const { events, answerText } = await collect(
      sseFrames([
        { type: 'token', text: 'Partial ' },
        errorEvent({ code: 'spend_cap_reached', message: 'reached its 1,000,000-token budget' }),
        { type: 'token', text: 'work.' },
        answerEvent({ text: 'Partial work.' }),
      ]),
    );
    expect(events.map((e) => e.type)).toEqual(['token', 'error', 'token', 'answer']);
    expect(answerText).toBe('Partial work.');
  });

  it('still ends the turn on every other error code', async () => {
    // The exception is one code, not a general softening. A `turn_timeout` or an `internal` has no
    // answer behind it, and reading on would hang until the stream closed.
    const stub = stubFetch(() =>
      sseResponse(sseFrames([errorEvent({ code: 'turn_timeout', message: 'too slow' })])),
    );
    restore = stub.restore;
    await expect(
      streamTurn({
        sessionId: SESSION,
        message: 'hello',
        signal: new AbortController().signal,
        getToken: async () => null,
        onEvent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

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
      errorEvent({ message: 'The turn exceeded the 600s time limit and was cancelled.' }),
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

  describe('the error code decides what the UI can offer', () => {
    /** Run a turn that ends in one `error` frame and hand back the thrown `ApiError`. */
    const failWith = async (over: Parameters<typeof errorEvent>[0]): Promise<ApiError> => {
      const stub = stubFetch(() => sseResponse(sseFrames([errorEvent(over)])));
      restore = stub.restore;
      try {
        await streamTurn({
          sessionId: SESSION,
          message: 'x',
          signal: new AbortController().signal,
          getToken: async () => null,
          onEvent: () => undefined,
        });
      } catch (err) {
        return err as ApiError;
      }
      throw new Error('expected the turn to fail');
    };

    it('locks the composer on a budget exhausted that arrived as an event, not a 429', () => {
      // The path that made this worth fixing: the same terminal condition reaches the client two
      // ways, and only the HTTP one used to lock the composer. The other let the chemist send
      // again into a budget that was already gone.
      return failWith({ code: 'budget_exhausted', message: 'Budget exhausted.' }).then((err) => {
        expect(err.kind).toBe('budget_exhausted');
        // Never retryable, whatever the event claims: pressing a button does not refill a budget.
        expect(err.retryable).toBe(false);
      });
    });

    it('reports a shed turn as capacity rather than as a failure nobody classified', async () => {
      // `at_capacity` and `budget_exhausted` reach this client on the same path and mean opposite
      // things: one is "we are busy, come back in a moment", the other is "the budget is gone".
      // Until the code was mirrored here the first normalised to `internal` and arrived as a
      // generic agent error — the offer a chemist needed ("try that again") was the one thing the
      // event said and the UI did not.
      const err = await failWith({
        code: 'at_capacity',
        message: 'server at capacity; retry shortly',
        retryable: true,
      });
      expect(err.kind).toBe('capacity');
      expect(err.retryable).toBe(true);
      // Not the composer-locking kind, which is the whole point of the service having split them.
      expect(err.kind).not.toBe('budget_exhausted');
    });

    it('takes the service’s word on whether a retry is worth offering', async () => {
      const err = await failWith({ code: 'storage_unavailable', retryable: true });
      expect(err.kind).toBe('agent');
      expect(err.retryable).toBe(true);
    });

    it('reports an answerless turn as its own kind, not a stream drop or a service failure', async () => {
      // `empty_answer` means the turn ran to completion and produced nothing — calling it `agent`
      // would imply something broke, and calling it `stream` would make callers poll the
      // transcript for an answer the server has already said will never arrive.
      expect((await failWith({ code: 'empty_answer' })).kind).toBe('empty_answer');
    });

    it('carries the correlation id, which is the only thing support can act on', async () => {
      expect((await failWith({ correlation_id: 'turn-7f3a' })).correlationId).toBe('turn-7f3a');
    });

    it('degrades a code it has never seen rather than dropping the turn’s ending', async () => {
      // Forward-compatibility, but only for the code — the event itself still has to end the turn.
      const err = await failWith({ code: 'a_code_from_a_newer_service' as never });
      expect(err.kind).toBe('agent');
    });
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

  /**
   * The connection dropping is not the user pressing Stop.
   *
   * Every other case in this file ends the stream *cleanly* — the body closes, `read()` resolves
   * `{done: true}`. A dropped Wi-Fi, an evicted pod or an ingress idle-timeout is the other thing:
   * the body raises mid-flight. Both land in the same `catch`, and the only thing that tells them
   * apart is `signal.aborted`.
   *
   * Collapsing them is the worst outcome this surface has. "You stopped this" is presented with no
   * banner and no retry, and the partial text is kept as though it were deliberate — so a chemist
   * whose network died reads a silently truncated answer and believes they caused it.
   */
  describe('a stream that breaks mid-body', () => {
    const runBroken = async (
      prefix: string,
      opts: { abortBeforeBreak?: boolean } = {},
    ): Promise<{ err: ApiError; events: ChemclawEvent[] }> => {
      const abort = new AbortController();
      const stub = stubFetch(() =>
        brokenSseResponse(prefix, new TypeError('network error'), () => {
          if (opts.abortBeforeBreak) abort.abort();
        }),
      );
      restore = stub.restore;
      const events: ChemclawEvent[] = [];
      try {
        await streamTurn({
          sessionId: SESSION,
          message: 'x',
          signal: abort.signal,
          getToken: async () => null,
          onEvent: (e) => events.push(e),
        });
      } catch (err) {
        return { err: err as ApiError, events };
      }
      throw new Error('expected the broken stream to fail the turn');
    };

    it('is a stream failure, not an abort, when nobody pressed Stop', async () => {
      const { err, events } = await runBroken(sseFrames([{ type: 'token', text: 'Partial ' }]));

      expect(err).toBeInstanceOf(ApiError);
      // The assertion that matters is the negative one: `aborted` is the kind `sendMessage` reads
      // as "the user did this", and it must not be reachable without an abort signal.
      expect(err.kind).not.toBe('aborted');
      expect(err.kind).toBe('stream');
      expect(err.message).not.toBe('Stopped.');
      // What arrived before the break is still delivered — losing it would throw away work the
      // service already did and already charged for.
      expect(events.map((e) => e.type)).toEqual(['token']);
    });

    it('IS an abort when the same break follows the user pressing Stop', async () => {
      // The other half, and what makes the first assertion mean something: the signal is the only
      // thing that distinguishes these two, so both directions have to be pinned or a mutation
      // that hardcodes either one survives.
      const { err } = await runBroken(sseFrames([{ type: 'token', text: 'Partial ' }]), {
        abortBeforeBreak: true,
      });
      expect(err.kind).toBe('aborted');
    });

    it('reports a break before the first frame as a stream failure too', async () => {
      const { err, events } = await runBroken('');
      expect(err.kind).toBe('stream');
      expect(events).toEqual([]);
    });
  });

  it('skips a malformed frame rather than killing the turn', async () => {
    const body =
      'event: token\ndata: {not json\n\n' +
      sseFrames([{ type: 'token', text: 'ok' }, answerEvent({ text: 'ok' })]);
    const { events, answerText } = await collect(body);
    expect(events.map((e) => e.type)).toEqual(['token', 'answer']);
    expect(answerText).toBe('ok');
  });

  it('ignores an unknown event type so a newer backend does not break an older UI', async () => {
    const body =
      'event: telemetry\ndata: {"type":"telemetry","v":1}\n\n' +
      sseFrames([answerEvent({ text: 'done' })]);
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
    const withToken = stubFetch(() => sseResponse(sseFrames([answerEvent()])));
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

    const devMode = stubFetch(() => sseResponse(sseFrames([answerEvent()])));
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

  /**
   * `getToken` failing is not the same fault as `fetch` failing, and conflating them is what
   * `D-` (see `src/api/errors.ts`, `'token_unavailable'`) exists to prevent: this is called
   * strictly before the POST is ever opened, so there is zero chance — not merely low odds, as
   * with a `fetch` that throws after being sent — that the server received anything. A caller
   * (`sendMessage`) that read this the way it reads `kind: 'network'` would poll the session
   * transcript for up to ten minutes for a turn that was never asked to start.
   */
  describe('the token provider failing before any request is opened', () => {
    it('rejects as token_unavailable, retryable, and never calls fetch', async () => {
      const stub = stubFetch(() => sseResponse(sseFrames([answerEvent()])));
      restore = stub.restore;

      const err = await streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: new AbortController().signal,
        getToken: () => Promise.reject(new Error('acquireTokenSilent: network is down')),
        onEvent: () => undefined,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe('token_unavailable');
      expect((err as ApiError).retryable).toBe(true);
      // The load-bearing assertion: nothing was ever sent, so a caller that polls the transcript
      // for a "detached" answer would be waiting on a turn that does not exist anywhere.
      expect(stub.calls).toHaveLength(0);
    });

    it('reports Stop rather than token_unavailable when the signal was already aborted', async () => {
      const stub = stubFetch(() => sseResponse(sseFrames([answerEvent()])));
      restore = stub.restore;
      const controller = new AbortController();
      controller.abort();

      const err = await streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: controller.signal,
        getToken: () => Promise.reject(new Error('abandoned')),
        onEvent: () => undefined,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe('aborted');
      expect(stub.calls).toHaveLength(0);
    });
  });

  it('passes dry_run through to the service', async () => {
    const stub = stubFetch(() => sseResponse(sseFrames([answerEvent()])));
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

/**
 * The SSE edge cases, through the parser this app actually runs (`eventsource-parser`, behind
 * `readEventStream`) rather than a stand-in. `src/lib/sse.ts` leans on the parser for multi-line
 * `data:`, CRLF and chunk boundaries and says so; these hold it to that. Each assertion is on what
 * the app receives — the decoded frame — not on parser internals, so they read the same under
 * eventsource-parser 3 and 4 (4 discards an invalid line early instead of buffering it to its
 * terminator; either way, the app must see nothing of it and lose none of its neighbours).
 */
describe('readEventStream on the real SSE parser', () => {
  /** A body delivered as exactly these network chunks, in order. */
  const chunked = (parts: string[]): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i >= parts.length) controller.close();
        else controller.enqueue(enc.encode(parts[i++]));
      },
    });
  };

  const read = async (body: string | string[]): Promise<SseFrame[]> => {
    // Both through a `Response`, so the body is exactly the type `streamTurn` hands the reader.
    const res =
      typeof body === 'string'
        ? sseResponse(body)
        : new Response(chunked(body), { headers: { 'content-type': 'text/event-stream' } });
    const frames: SseFrame[] = [];
    for await (const frame of readEventStream(res.body!)) frames.push(frame);
    return frames;
  };

  // `agent` is what `normalizeEvent` fills in for a token that names none.
  const token = (text: string): ChemclawEvent => ({ type: 'token', text, agent: '' });

  it('joins a multi-line data field into one frame', async () => {
    const frames = await read(
      'event: token\ndata: {\ndata:   "type": "token",\ndata:   "text": "joined"\ndata: }\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toEqual(token('joined'));
  });

  it('joins data lines with a newline, not with nothing', async () => {
    // Joined with "" this would be the valid `"text":"ab"`; joined with "\n" (the spec) the string
    // holds a raw newline, which JSON forbids — so the app sees one malformed frame, not "ab".
    const frames = await read(
      'data: {"type":"token","text":"a\ndata: b"}\n\n' + sseFrames([token('next')]),
    );
    expect(frames.map((f) => f.drop ?? f.event?.type)).toEqual(['malformed', 'token']);
    expect(frames[1]?.event).toEqual(token('next'));
  });

  it('takes a retry field without turning it into a frame or into data', async () => {
    const frames = await read(
      'retry: 5000\n\n' + 'event: token\nretry: 1000\ndata: {"type":"token","text":"r"}\n\n',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toEqual(token('r'));
  });

  it('decodes a frame carrying an id without the id leaking into its payload', async () => {
    // Nothing here resumes by Last-Event-ID (a turn is not resumable, a job watch re-subscribes
    // from scratch), so the id is only required not to disturb the frame it rides on.
    const frames = await read(
      'id: 42\nevent: token\ndata: {"type":"token","text":"i"}\n\n' +
        'id\ndata: {"type":"token","text":"j"}\n\n',
    );
    expect(frames.map((f) => f.event)).toEqual([token('i'), token('j')]);
  });

  it('reads CRLF and lone-CR line endings the same as LF', async () => {
    const lf = 'event: token\ndata: {"type":"token","text":"x"}\n\n: hb\n\n';
    const crlf = lf.replaceAll('\n', '\r\n');
    const cr = lf.replaceAll('\n', '\r');
    for (const body of [crlf, cr]) {
      const frames = await read(body);
      expect(frames).toHaveLength(1);
      expect(frames[0]?.event).toEqual(token('x'));
    }
  });

  it('reassembles an event split across two network chunks, wherever the split falls', async () => {
    const body =
      'event: token\r\ndata: {"type":"token","text":"split"}\r\n\r\n' + sseFrames([token('after')]);
    // Every cut point, including inside `data:`, inside the JSON, and between a CR and its LF.
    for (let cut = 1; cut < body.length; cut++) {
      const frames = await read([body.slice(0, cut), body.slice(cut)]);
      expect(
        frames.map((f) => f.event),
        `split at ${cut}`,
      ).toEqual([token('split'), token('after')]);
    }
  });

  it('ignores an invalid line without losing the frames around it', async () => {
    const frames = await read(
      sseFrames([token('before')]) +
        'this line is not an SSE field\n' +
        'event: token\nbogus: nope\ndata: {"type":"token","text":"with junk"}\n\n' +
        sseFrames([token('after')]),
    );
    expect(frames.map((f) => f.event)).toEqual([
      token('before'),
      token('with junk'),
      token('after'),
    ]);
  });

  it('ignores an invalid line that is split across chunks', async () => {
    // eventsource-parser 4 discards such a line as soon as it can tell it is invalid rather than
    // at its terminator; the frame that follows in the same chunk must survive either way.
    const frames = await read([
      'nonsense-that-',
      'keeps-going\nevent: token\ndata: {"type":"token","text":"ok"}\n\n',
    ]);
    expect(frames.map((f) => f.event)).toEqual([token('ok')]);
  });
});
