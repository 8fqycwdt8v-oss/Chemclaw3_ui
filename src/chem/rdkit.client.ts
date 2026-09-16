/**
 * Where an RDKit call runs: in the worker if this browser has one, on this thread if it does not.
 *
 * `rdkit.ts` is the seam every caller uses and does not know the difference; this file is the only
 * place in the app that does. It exists because the answer has to be the same either way — the
 * same `operations` table is dispatched in both placements (`rdkit.engine.ts`), so the fallback is
 * not a second implementation and cannot drift from the first.
 *
 * **Three ways the worker can be absent, and all three end here rather than at a call site.**
 *
 *  - The environment has no `Worker` at all. That is every unit test in this repository — happy-dom
 *    implements none — and it is also a browser old enough to matter to nobody, so the fallback is
 *    real coverage rather than a branch nothing exercises.
 *  - Construction throws. A CSP without `worker-src` is the realistic one (`server/config.ts`
 *    states it, and the note there records that `worker-src` does **not** fall back to
 *    `script-src`), as is a chunk that did not arrive.
 *  - It is alive and stops answering. `onerror` catches an uncaught throw inside it; what catches
 *    the rest — a thread the browser reclaimed under memory pressure — is the reply budget below.
 *
 * In every one of them the request is **answered**, by running the same engine call here. That is
 * the rule this file is built around: a missing worker is a placement problem, and a placement
 * problem must never reach a chemist as "that is not a molecule". The whole available/unreadable
 * distinction `rdkit.engine.ts` maintains would be worthless if the transport could manufacture a
 * negative.
 */

import { operations } from './rdkit.engine.ts';
import { TOOLKIT_LOAD_TIMEOUT_MS } from './toolkitLoad.ts';
import type { Args, Op, Request, Response, Returns } from './rdkit.protocol.ts';

/**
 * How long a request may go unanswered before the worker is treated as gone.
 *
 * The same budget, and the same argument, as `TOOLKIT_LOAD_TIMEOUT_MS`: it is not a latency target
 * but the point past which "still working" and "never coming" are indistinguishable. It has to be
 * at least that large, because the first request through a cold worker is waiting on exactly that
 * load.
 *
 * It bounds the one failure `onerror` cannot see. Everything the worker does either completes,
 * throws — and a throw is caught and answered — or waits on `loadRDKit`, which carries its own
 * 60 s bound. So the only way a reply never comes is the thread itself ceasing to run, and a
 * silent empty box for the life of the page is precisely the outcome `toolkitLoad.ts` was written
 * to refuse.
 */
const REPLY_BUDGET_MS = TOOLKIT_LOAD_TIMEOUT_MS;

/** `undefined` before the first call, `null` once this page has decided to do without one. */
let worker: Worker | null | undefined;
let nextId = 1;

interface Pending {
  settle: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, Pending>();

/**
 * The worker, or `null` if this page is not going to get one.
 *
 * Built on the first call rather than at module load: importing `rdkit.ts` must stay free, because
 * `Molecule` imports it to read `MAX_PARSED_SMILES_CHARS` on a path that may never draw anything.
 */
function ensureWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    // `new URL(..., import.meta.url)` is the form Vite compiles into a separately emitted chunk;
    // anything else (a string path, a variable) is left alone and 404s in the build.
    const started = new Worker(new URL('./rdkit.worker.ts', import.meta.url), { type: 'module' });
    started.addEventListener('message', (event: MessageEvent<Response>) => {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      pending.delete(event.data.id);
      clearTimeout(waiting.timer);
      waiting.settle(event.data);
    });
    // An uncaught throw inside the worker, or a script that failed to load at all. Either way this
    // page has no worker; the requests in flight are re-run here rather than failed, because a
    // transport fault must not be reported as a chemical verdict.
    const lost = (): void => retire();
    started.addEventListener('error', lost);
    started.addEventListener('messageerror', lost);
    return (worker = started);
  } catch {
    // A CSP refusal, or a browser that has `Worker` and refuses this kind of one.
    return (worker = null);
  }
}

/**
 * Stop using the worker, and let everything waiting on it answer here instead.
 *
 * `ok: false` is what the pending requests are settled with, which is the same thing the worker
 * says when an engine call throws — and `call` below re-runs the operation in-process on it. So a
 * worker dying mid-flight costs the caller the time already spent and nothing else.
 */
function retire(): void {
  const dying = worker;
  worker = null;
  for (const [id, waiting] of pending) {
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.settle({ id, ok: false });
  }
  try {
    dying?.terminate();
  } catch {
    // Already gone. There is nothing to do about a worker that cannot be told to stop.
  }
}

/**
 * Run one engine operation, wherever it belongs.
 *
 * Typed off the engine's own table, so the arguments a caller passes are the arguments the engine
 * takes and the value it gets back is the value the engine returns — the `unknown` on the wire is
 * re-narrowed here exactly once rather than at every call site.
 */
export async function call<K extends Op>(op: K, ...args: Args<K>): Promise<Returns<K>> {
  const active = ensureWorker();
  if (active) {
    const response = await send(active, op, args);
    if (response.ok) return response.value as Returns<K>;
    // Either the engine threw inside the worker — in which case running it here throws too, and
    // the operation's own catch answers with its negative — or the worker is gone and this is the
    // retry that keeps a chemist's structure on screen.
  }
  return (await (operations[op] as (...a: readonly unknown[]) => Promise<unknown>)(
    ...args,
  )) as Returns<K>;
}

/** One message, one reply, bounded. */
function send(active: Worker, op: Op, args: readonly unknown[]): Promise<Response> {
  const id = nextId++;
  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      // The worker has stopped answering. Retiring it settles this request too, so there is
      // exactly one resolution path and no second `resolve` to guard against.
      retire();
    }, REPLY_BUDGET_MS);
    pending.set(id, { settle: resolve, timer });
    const request: Request = { id, op, args };
    try {
      active.postMessage(request);
    } catch {
      // An argument that will not clone. Nothing this app sends can hit it — every operation takes
      // strings and a three-field object — but a `postMessage` that throws would otherwise leave
      // the request pending for the whole budget for no reason.
      pending.delete(id);
      clearTimeout(timer);
      resolve({ id, ok: false });
    }
  });
}

/**
 * Drop the worker, as a test does between cases.
 *
 * Exported for `tests/rdkitWorker.test.ts`, which drives this module against a fake `Worker` and
 * must not carry one case's decision into the next. Nothing in `src/` calls it: a page that has
 * settled on a placement keeps it.
 */
export function resetWorkerForTests(): void {
  retire();
  worker = undefined;
}
