/**
 * The RDKit engine, in a worker.
 *
 * Message plumbing over `rdkit.engine.ts`'s own `operations` table and nothing else, which is the
 * point: there is one implementation of every chemistry answer in this app and this file only
 * decides *where* it runs. A worker that re-implemented any of it would be a second opinion about
 * what a molecule is — the failure `rdkit.ts` spends four paragraphs refusing for a second
 * toolkit.
 *
 * **The heap lives here now.** RDKit's 6.9 MB WASM is instantiated inside this worker, not on the
 * page, so the cost W28.7 measured — 587 ms to draw a legal 600-character chain, 97 ms for a
 * 200-character one (`scripts/measure-rdkit-placement.mjs`) — is spent where no frame is waiting
 * on it. A trap that kills the runtime
 * (see `MAX_PARSED_SMILES_CHARS`) kills it *here*, and the page keeps its own main thread either
 * way.
 *
 * It answers `{ ok: false }` rather than throwing a message back, because the client's fallback
 * for a structural failure is the engine's own negative — see `rdkit.protocol.ts`.
 */

import { operations } from './rdkit.engine.ts';
import type { Request, Response } from './rdkit.protocol.ts';

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { id, op, args } = event.data;
  void (async () => {
    let response: Response;
    try {
      // `rdkit.client.ts` is the only sender and its arguments are checked against the same table
      // this dispatches through, so the tuple is already the operation's own. Re-deriving that
      // here would mean widening the table's types to `unknown[]` for the benefit of a caller that
      // does not exist.
      const run = operations[op] as (...a: readonly unknown[]) => Promise<unknown>;
      response = { id, ok: true, value: await run(...args) };
    } catch {
      response = { id, ok: false };
    }
    self.postMessage(response);
  })();
});
