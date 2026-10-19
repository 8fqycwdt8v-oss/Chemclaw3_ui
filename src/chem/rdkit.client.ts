/**
 * Where an RDKit call runs: in the worker when this browser has one, on this thread otherwise — the
 * same `operations` table either way (`rdkit.engine.ts`). The worker may be absent (no `Worker`,
 * e.g. happy-dom), fail to construct (CSP, missing chunk), or stop answering; in every case the
 * request is still answered by running the call here. A missing worker must never surface as "not a
 * molecule".
 *
 * Comlink handles messaging. This file adds what Comlink lacks: a reply budget (Comlink has no
 * timeout), answering calls held by a retired worker, and mapping any rejection to an in-process
 * re-run rather than a verdict.
 */

import * as Comlink from 'comlink';
import { operations } from './rdkit.engine.ts';
import { TOOLKIT_LOAD_TIMEOUT_MS } from './toolkitLoad.ts';
import type { Args, Op, Returns } from './rdkit.protocol.ts';

/**
 * How long a request may go unanswered before the worker is treated as gone — the same budget as
 * `TOOLKIT_LOAD_TIMEOUT_MS`, since the first request waits on the load. Catches the one failure
 * `onerror` cannot: the thread stops running.
 */
const REPLY_BUDGET_MS = TOOLKIT_LOAD_TIMEOUT_MS;

/** The operations table as it is reached across the worker boundary: same names, same arguments,
 *  every answer a promise. Derived, so a new engine row needs no line here. */
type RemoteOperations = Comlink.Remote<typeof operations>;

/** `undefined` before the first call, `null` once this page has decided to do without one. */
let worker: Worker | null | undefined;
let remote: RemoteOperations | null = null;

/**
 * How to abandon each in-flight call when its worker is retired (Comlink owns the reply matching).
 */
const inFlight = new Set<() => void>();

/** The worker, or `null`. Built on first call so importing `rdkit.ts` stays free. */
function ensureWorker(): RemoteOperations | null {
  if (worker !== undefined) return remote;
  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }
  try {
    // `new URL(..., import.meta.url)` is the form Vite emits as a separate chunk;
    // `scripts/check-bundle.mjs` asserts it.
    const started = new Worker(new URL('./rdkit.worker.ts', import.meta.url), { type: 'module' });
    // The worker failed: requests in flight are re-run here rather than failed.
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

/** Stop using the worker; everything waiting on it is answered here instead. */
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

/** Run one engine operation wherever it belongs, typed off the engine's table. */
export async function call<K extends Op>(op: K, ...args: Args<K>): Promise<Returns<K>> {
  const active = ensureWorker();
  if (active) {
    const answer = await onWorker(active, op, args);
    // `null` means "this placement did not answer"; a real `null` answer arrives as `{ value: null
    // }`.
    if (answer && 'value' in answer) return answer.value as Returns<K>;
    if (answer && isStackExhaustion(answer.thrown)) {
      const spent = await escalationWithNowhereToGo(op);
      if (spent) return spent.value as Returns<K>;
    }
  }
  return (await (operations[op] as (...a: readonly unknown[]) => Promise<unknown>)(
    ...args,
  )) as Returns<K>;
}

/**
 * A canonical read when the worker ran out of stack and the page cannot run RDKit (the production
 * CSP grants `'unsafe-eval'` only to the worker): answer `too-complex`, not the page's `unreadable`
 * (`e2e/rdkit-too-complex.spec.ts`). Other operations fall through as before.
 */
const STACK_REFUSAL: { [K in Op]?: Returns<K> } = {
  readCanonicalSmiles: { status: 'too-complex' },
  readCanonicalSmilesFromMolblock: { status: 'too-complex' },
};

/** A rejection that is the worker's escalation of a stack exhaustion. Comlink rebuilds a thrown
 *  error as a plain `Error` carrying the original `name`, so the name is what survives the hop. */
const isStackExhaustion = (thrown: unknown): boolean =>
  (thrown as { name?: unknown } | null)?.name === 'RangeError';

async function escalationWithNowhereToGo(op: Op): Promise<{ value: unknown } | null> {
  if (!(op in STACK_REFUSAL)) return null;
  // The page can take it — a deployment without the CSP split, or the Vite dev server — so it
  // should, and its answer is the better one.
  if (await operations.toolkitLoads()) return null;
  return { value: STACK_REFUSAL[op] };
}

/**
 * One bounded call across the boundary: its answer, what it threw, or `null` if it went silent
 * (rejection, budget expired, or worker retired). The rejection reason lets `call` recognise a
 * stack exhaustion.
 */
async function onWorker(
  active: RemoteOperations,
  op: Op,
  args: readonly unknown[],
): Promise<{ value: unknown } | { thrown: unknown } | null> {
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
        // Kept rather than dropped, for one reader: a stack exhaustion the page may be unable to
        // take (`escalationWithNowhereToGo`). Every other rejection is still "no answer".
        (thrown: unknown) => ({ thrown }),
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

/** Drop the worker between tests (`tests/rdkitWorker.test.ts`); not used in `src/`. */
export function resetWorkerForTests(): void {
  retire();
  worker = undefined;
}
