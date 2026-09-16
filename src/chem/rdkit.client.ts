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
 *
 * ## What Comlink does here, and the three things it does not
 *
 * The request id, the `Map<number, {settle, timer}>` of pending calls, the `message` listener that
 * dispatched replies back into it and the `{ id, ok, value }` envelope on both sides are all
 * Comlink's now. `Comlink.wrap<typeof operations>(worker)` is the whole client, and the worker is
 * three lines. What is left below is the part Comlink has no opinion about, and each piece is here
 * because removing it would break a property this file exists to hold:
 *
 *  1. **The reply budget.** Comlink has no timeout and no cancellation: a call whose worker stops
 *     running is a promise that never settles, which is the silent empty box for the life of the
 *     page that `toolkitLoad.ts` was written to refuse.
 *  2. **Answering the calls a retired worker was holding.** `retire()` used to settle them
 *     directly, because this file owned the pending map. Comlink owns it now and exposes no way to
 *     reach into it, so each call races its own abandon signal — `inFlight` is a set of thunks
 *     rather than a map of ids, which is the one piece of bookkeeping that did not go away.
 *  3. **Mapping a rejection to the engine's own negative rather than to a verdict.** Comlink
 *     rejects a call whose remote threw, and it rejects a call it could not even post. Both mean
 *     the same thing here — *this placement did not answer* — so both re-run in-process, where the
 *     operation's own `catch` produces the honest `null` or `false`. A version of this file that
 *     let either rejection reach a caller would be reporting a transport fault as chemistry, which
 *     is the one outcome the whole seam is built to prevent.
 */

import * as Comlink from 'comlink';
import { operations } from './rdkit.engine.ts';
import { TOOLKIT_LOAD_TIMEOUT_MS } from './toolkitLoad.ts';
import type { Args, Op, Returns } from './rdkit.protocol.ts';

/**
 * How long a request may go unanswered before the worker is treated as gone.
 *
 * The same budget, and the same argument, as `TOOLKIT_LOAD_TIMEOUT_MS`: it is not a latency target
 * but the point past which "still working" and "never coming" are indistinguishable. It has to be
 * at least that large, because the first request through a cold worker is waiting on exactly that
 * load.
 *
 * It bounds the one failure `onerror` cannot see. Everything the worker does either completes,
 * throws — and a throw is a rejection, which is answered — or waits on `loadRDKit`, which carries
 * its own 60 s bound. So the only way a reply never comes is the thread itself ceasing to run, and
 * a silent empty box for the life of the page is precisely the outcome `toolkitLoad.ts` was
 * written to refuse.
 */
const REPLY_BUDGET_MS = TOOLKIT_LOAD_TIMEOUT_MS;

/** The operations table as it is reached across the worker boundary: same names, same arguments,
 *  every answer a promise. Derived, so a new engine row needs no line here. */
type RemoteOperations = Comlink.Remote<typeof operations>;

/** `undefined` before the first call, `null` once this page has decided to do without one. */
let worker: Worker | null | undefined;
let remote: RemoteOperations | null = null;

/**
 * How to tell each in-flight call that its worker is not going to answer.
 *
 * A set of thunks rather than the id-keyed map this file used to carry, because there is nothing
 * left to key on: Comlink matches replies to calls by its own id and gives no way to settle one
 * from outside. So a call registers how to abandon itself and `retire` calls them all, which is
 * the same guarantee — every waiting caller is answered, by the in-process re-run — reached from
 * the other side.
 */
const inFlight = new Set<() => void>();

/**
 * The worker, or `null` if this page is not going to get one.
 *
 * Built on the first call rather than at module load: importing `rdkit.ts` must stay free, because
 * `Molecule` imports it to read `MAX_PARSED_SMILES_CHARS` on a path that may never draw anything.
 */
function ensureWorker(): RemoteOperations | null {
  if (worker !== undefined) return remote;
  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }
  try {
    // `new URL(..., import.meta.url)` is the form Vite compiles into a separately emitted chunk;
    // anything else (a string path, a variable) is left alone and 404s in the build.
    // `scripts/check-bundle.mjs` asserts the chunk is emitted *and* referenced, so this spelling is
    // load-bearing and survives verbatim.
    const started = new Worker(new URL('./rdkit.worker.ts', import.meta.url), { type: 'module' });
    // An uncaught throw inside the worker, or a script that failed to load at all. Either way this
    // page has no worker; the requests in flight are re-run here rather than failed, because a
    // transport fault must not be reported as a chemical verdict.
    const lost = (): void => retire();
    started.addEventListener('error', lost);
    started.addEventListener('messageerror', lost);
    worker = started;
    return (remote = Comlink.wrap<typeof operations>(started));
  } catch {
    // A CSP refusal, or a browser that has `Worker` and refuses this kind of one.
    worker = null;
    return null;
  }
}

/**
 * Stop using the worker, and let everything waiting on it answer here instead.
 *
 * Abandoning a call is the same outcome the worker reports when an engine call throws, and `call`
 * below re-runs the operation in-process on either. So a worker dying mid-flight costs the caller
 * the time already spent and nothing else.
 */
function retire(): void {
  const dying = worker;
  worker = null;
  remote = null;
  for (const abandon of inFlight) abandon();
  inFlight.clear();
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
 * takes and the value it gets back is the value the engine returns.
 */
export async function call<K extends Op>(op: K, ...args: Args<K>): Promise<Returns<K>> {
  const active = ensureWorker();
  if (active) {
    const answer = await onWorker(active, op, args);
    // `null` is "this placement did not answer", never "the answer is nothing" — an operation that
    // really answers `null` comes back as `{ value: null }`. Conflating the two is how a dead
    // worker would become "that is not a molecule".
    if (answer) return answer.value as Returns<K>;
  }
  return (await (operations[op] as (...a: readonly unknown[]) => Promise<unknown>)(
    ...args,
  )) as Returns<K>;
}

/**
 * One call across the boundary, bounded, and `null` if this placement did not produce an answer.
 *
 * Three ways it does not, raced against each other: the call rejects (the engine threw in there, or
 * Comlink could not post the arguments), the reply budget expires, or the worker is retired under
 * it by the `error` listener. All three mean the same thing to the caller and none of them is
 * allowed to reach one.
 */
async function onWorker(
  active: RemoteOperations,
  op: Op,
  args: readonly unknown[],
): Promise<{ value: unknown } | null> {
  let abandon = (): void => undefined;
  const abandoned = new Promise<null>((resolve) => {
    abandon = () => resolve(null);
  });
  inFlight.add(abandon);
  // Retiring settles this call through `abandoned`, so there is exactly one resolution path and no
  // second resolve to guard against.
  const timer = setTimeout(retire, REPLY_BUDGET_MS);
  try {
    const run = active[op] as (...a: readonly unknown[]) => Promise<unknown>;
    return await Promise.race([
      run(...args).then(
        (value) => ({ value }),
        () => null,
      ),
      abandoned,
    ]);
  } catch {
    // The proxy itself refused — a released endpoint, or an argument that threw on the way out.
    return null;
  } finally {
    clearTimeout(timer);
    inFlight.delete(abandon);
  }
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
