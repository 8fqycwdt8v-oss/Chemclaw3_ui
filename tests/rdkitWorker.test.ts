/**
 * W28.7 — the RDKit toolkit runs off the main thread, and every way that can fail answers anyway.
 *
 * The measurement that forced this is `scripts/measure-rdkit-placement.mjs`, and the table it
 * produces is in `src/chem/rdkit.ts`: through the app's own module in real Chromium, a legal
 * 600-character chain cost **587 ms of blocked main thread** to draw, a single `longtask` with the
 * frame loop stopped for its whole duration. After the move: **zero** long tasks, zero blocked
 * main thread, and the widest gap between animation frames is 19.1 ms — the frame cadence itself.
 * The figure is not transcribed here twice over, because it shipped that way once and the two
 * copies disagreed.
 *
 * What this file drives is the *wiring*, because the placement is the whole feature and none of it
 * is visible in an answer. It runs the **real** `rdkit.client.ts` against a fake `Worker` whose
 * other end is the **real** `rdkit.worker.ts` dispatching into the **real** `rdkit.engine.ts` —
 * only the `Worker` constructor and the RDKit binary are doubles. So a request really is
 * serialised, dispatched by name and answered, and a test cannot pass by talking to a mock that
 * agrees with it.
 *
 * happy-dom implements no `Worker` at all, which is why every *other* test in this repository
 * exercises the in-process fallback — real coverage of the branch a browser without workers takes,
 * rather than a branch nothing visits.
 *
 * **What this file cannot see**, stated rather than implied: that Vite emits the worker chunk and
 * that something in the built bundle references it. That is a fact about the build output and it is
 * `scripts/check-bundle.mjs`'s, which the gate runs; `e2e/worker.spec.ts` then asserts a real
 * browser actually starts the thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { canonicalSmiles, isMolecule, moleculeSvg } from '../src/chem/rdkit.ts';
import { resetWorkerForTests } from '../src/chem/rdkit.client.ts';
import { operations } from '../src/chem/rdkit.engine.ts';
import { CANONICALISATION_OVERFLOWS, resetHandles } from './stubs/rdkit.ts';
// Side-effect import: this registers the worker's own `message` listener on the global, which is
// what `deliver` below drives. Importing it is the only way to exercise the real dispatch.
import '../src/chem/rdkit.worker.ts';

/** How a given fake worker treats what it is sent. */
type Mode = 'deliver' | 'refuse' | 'silent';

/**
 * The other end of a worker that refuses everything, built out of the real `Comlink.expose`.
 *
 * A refusal is an engine call throwing inside the worker, and what `rdkit.client.ts` has to do with
 * it is map it back to the engine's own negative rather than to a verdict. Hand-writing the reply
 * would make this a test of *this file's* idea of Comlink's error frame; exposing a table whose
 * every member throws drives Comlink's own serialisation, which is the thing the client actually
 * meets.
 *
 * Returns the way to push a request in. The endpoint is a plain `EventTarget` because that is all
 * `Comlink.Endpoint` needs beyond a `postMessage`, and the `postMessage` is the reply channel back
 * to the fake worker.
 */
function refusingEnd(reply: (data: unknown) => void): (request: unknown) => void {
  const target = new EventTarget();
  Comlink.expose(
    new Proxy(
      {},
      {
        get: () => (): never => {
          throw new Error('the engine threw inside the worker');
        },
      },
    ),
    {
      addEventListener: (type, listener) =>
        target.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) =>
        target.removeEventListener(type, listener as EventListener),
      postMessage: (data) => reply(data),
    },
  );
  return (request) => target.dispatchEvent(new MessageEvent('message', { data: request }));
}

/**
 * A `Worker` whose other end is the real worker module.
 *
 * `postMessage` dispatches a `message` event on the global, which is where
 * `src/chem/rdkit.worker.ts`'s `Comlink.expose(operations)` attached its listener under happy-dom;
 * the reply comes back through the stubbed `globalThis.postMessage` below and is handed to
 * whichever instance is live. That is as close to the real channel as a single-realm test can get.
 *
 * `sent` holds Comlink's own `APPLY` frames, and `ops` reads the operation name out of `path[0]`.
 * That is a coupling to Comlink's protocol and it is deliberate: the alternative is asserting
 * nothing about *which* call crossed the boundary, and the shape is the one documented thing about
 * a remote method call.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructorThrows = false;
  /** What the next instance does with what it is sent. Set before the call under test, so no
   *  case depends on winning a race against the worker's own reply. */
  static defaultMode: Mode = 'deliver';

  readonly sent: { path?: readonly string[] }[] = [];
  terminated = false;
  mode: Mode = FakeWorker.defaultMode;
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();
  private readonly refuse = refusingEnd((data) => this.reply(data));

  constructor(
    readonly url: URL | string,
    readonly options?: { type?: string },
  ) {
    if (FakeWorker.constructorThrows) throw new Error('refused by the content security policy');
    FakeWorker.instances.push(this);
  }

  /** The operations this worker was asked for, in order. */
  get ops(): string[] {
    return this.sent.flatMap((frame) => (frame.path?.[0] === undefined ? [] : [frame.path[0]]));
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
  }

  postMessage(data: { path?: readonly string[] }): void {
    this.sent.push(data);
    if (this.mode === 'silent') return;
    if (this.mode === 'refuse') {
      this.refuse(data);
      return;
    }
    globalThis.dispatchEvent(new MessageEvent('message', { data }));
  }

  terminate(): void {
    this.terminated = true;
  }

  /** A reply arriving from the other end. */
  reply(response: unknown): void {
    this.emit('message', { data: response });
  }

  /** The worker died — an uncaught throw inside it, or a script that never loaded. */
  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

/** The instance the worker module's replies are routed to: the newest one still alive. */
const live = (): FakeWorker | undefined =>
  FakeWorker.instances.findLast((worker) => !worker.terminated);

beforeEach(() => {
  resetHandles();
  FakeWorker.instances = [];
  FakeWorker.constructorThrows = false;
  FakeWorker.defaultMode = 'deliver';
  vi.stubGlobal('Worker', FakeWorker);
  // The worker module answers with `self.postMessage`, which under happy-dom is the page's own.
  // Routing it to the live fake is what closes the loop; leaving it alone would post the reply
  // back into the listener that produced it.
  vi.stubGlobal('postMessage', (data: unknown) => live()?.reply(data));
});

afterEach(() => {
  resetWorkerForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('where an RDKit call runs', () => {
  it('sends the work to a module worker rather than doing it here', async () => {
    expect(await moleculeSvg('CCO', { width: 320, height: 220 })).toContain('data-smiles="CCO"');

    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0]!;
    // The two facts that make it the *right* worker: the module Vite compiles into a chunk, and
    // the module type `vite.config.ts`'s `worker.format` is set to match.
    expect(String(worker.url)).toMatch(/\/chem\/rdkit\.worker\.ts(\?|$)/);
    expect(worker.options?.type).toBe('module');
    expect(worker.ops).toEqual(['drawSvg']);
  });

  it('keeps the drawing cache on the calling thread, so a hit costs no round trip', async () => {
    const opts = { width: 320, height: 220 };
    const first = await moleculeSvg('CC(=O)O', opts);
    const second = await moleculeSvg('CC(=O)O', opts);

    expect(second).toBe(first);
    // One depiction for two calls. A cache behind the worker would have answered the second from
    // its own map and still paid a message, a reply and a structured clone of the SVG.
    expect(FakeWorker.instances[0]!.ops.filter((op) => op === 'drawSvg')).toHaveLength(1);
  });

  it('answers the same, with no worker at all', async () => {
    vi.stubGlobal('Worker', undefined);

    expect(await canonicalSmiles('OCC')).toBe('CCO');
    expect(await isMolecule('CCO')).toBe(true);
    expect(await moleculeSvg('CCO', { width: 320, height: 220 })).toContain('data-smiles="CCO"');
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('answers the same when the worker cannot be constructed', async () => {
    FakeWorker.constructorThrows = true;

    // The realistic cause is a CSP without `worker-src` — which does *not* fall back to
    // `script-src`, so it is one deleted directive away at any time (`server/config.ts`).
    expect(await canonicalSmiles('OCC')).toBe('CCO');
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('a worker that stops answering', () => {
  it('does not turn a dead worker into "that is not a molecule"', async () => {
    // The whole hazard of moving chemistry off the page: a transport fault and a chemical verdict
    // are both "no answer", and reporting the first as the second tells a chemist their structure
    // is not one.
    //
    // Silent from the start, so the worker cannot answer first and make this pass for the wrong
    // reason — the only thing that can produce `CCO` here is the in-process re-run.
    FakeWorker.defaultMode = 'silent';
    const answer = canonicalSmiles('OCC');
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    worker.emit('error', new Event('error'));

    expect(await answer).toBe('CCO');
    expect(worker.terminated).toBe(true);
  });

  it('gives up on a worker that never replies, and answers here instead', async () => {
    vi.useFakeTimers();
    FakeWorker.defaultMode = 'silent';

    const answer = canonicalSmiles('OCC');
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    // Nothing has come back and nothing will. Without the reply budget this promise is pending for
    // the life of the page, which is the silent empty box `toolkitLoad.ts` refuses.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await answer).toBe('CCO');
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('does not re-run a real null answer, which is not the same as no answer', async () => {
    // The trap in mapping Comlink onto this seam. A rejection means "this placement did not
    // answer" and a `null` means "this string is not a molecule", and the two arrive on the same
    // channel — so a client that folded them together would take the engine's own honest negative
    // as a transport fault and pay a second, in-process run for every unreadable string a chemist
    // pastes. The answer is wrapped rather than returned bare for exactly this reason.
    // Counted on the engine table itself, because both placements dispatch through *this* object
    // in this realm — the worker's `Comlink.expose(operations)` and the client's in-process
    // fallback both look the name up at call time. So the count is the number of times the
    // operation actually ran, which is the only thing that tells a real answer from a retry.
    // Asserting on what crossed the worker boundary cannot: the retry does not cross it.
    const ran = vi.spyOn(operations, 'canonicalSmiles');

    expect(await canonicalSmiles('not-a-smiles')).toBeNull();

    expect(FakeWorker.instances[0]!.ops).toEqual(['canonicalSmiles']);
    expect(ran).toHaveBeenCalledTimes(1);
    ran.mockRestore();
  });

  it('re-runs here when the worker reports a failure', async () => {
    FakeWorker.defaultMode = 'refuse';

    // A rejection is what Comlink delivers when an engine call throws inside the worker — which is
    // how a stack exhaustion arrives (see below). The page has the bigger stack, so it runs the
    // same call and answers. What must NOT happen is the rejection reaching `canonicalSmiles`,
    // where a transport fault would read as a chemical verdict.
    expect(await canonicalSmiles('OCC')).toBe('CCO');
    expect(FakeWorker.instances[0]!.ops).toEqual(['canonicalSmiles']);
  });
});

describe('a stack exhaustion is a fact about a thread, not about a molecule', () => {
  /**
   * The engine, loaded as the worker loads it.
   *
   * `OFF_MAIN_THREAD` is read once at module load — it is a property of the thread and cannot
   * change under a running module — so the two placements are two module instances. `resetModules`
   * plus a global that only a worker scope has is the honest way to get the worker's one.
   */
  const engineIn = async (scope: 'worker' | 'page') => {
    vi.resetModules();
    if (scope === 'worker') vi.stubGlobal('WorkerGlobalScope', class {});
    else vi.stubGlobal('WorkerGlobalScope', undefined);
    return import('../src/chem/rdkit.engine.ts');
  };

  it('is reported by the worker instead of being answered as null', async () => {
    const engine = await engineIn('worker');
    // Measured in Chromium: `C`*500 canonicalises on the page and raises a `RangeError` on a
    // worker, whose stack is smaller. Swallowing that into `null` is a claim about the string.
    await expect(engine.canonicalSmiles(CANONICALISATION_OVERFLOWS)).rejects.toThrow(RangeError);
  });

  it('is the end of the line on the page, where there is nowhere better to send it', async () => {
    const engine = await engineIn('page');
    // The same throw, from the placement with the biggest stack there is. Here `null` is the
    // honest answer and is what the 999-atom molblock in `withSmilesMol`'s docstring already got.
    await expect(engine.canonicalSmiles(CANONICALISATION_OVERFLOWS)).resolves.toBeNull();
  });
});
