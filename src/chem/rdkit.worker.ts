/**
 * The RDKit engine, in a worker.
 *
 * `rdkit.engine.ts`'s own `operations` table, handed to `Comlink.expose` and nothing else, which is
 * the point: there is one implementation of every chemistry answer in this app and this file only
 * decides *where* it runs. A worker that re-implemented any of it would be a second opinion about
 * what a molecule is — the failure `rdkit.ts` spends four paragraphs refusing for a second toolkit.
 *
 * It used to carry its own `message` listener, dispatch and `{ id, ok, value }` envelope. Comlink
 * owns all three now, and the *whole* surface it exposes is the table, so a new engine call is one
 * row there and nothing here — where before it was one row plus a wire type that could be hand-
 * copied wrong.
 *
 * **The heap lives here now.** RDKit's 6.9 MB WASM is instantiated inside this worker, not on the
 * page, so the cost W28.7 measured — 587 ms to draw a legal 600-character chain, 97 ms for a
 * 200-character one (`scripts/measure-rdkit-placement.mjs`) — is spent where no frame is waiting
 * on it. A trap that kills the runtime (see `MAX_PARSED_SMILES_CHARS`) kills it *here*, and the
 * page keeps its own main thread either way.
 *
 * An engine call that throws in here rejects on the page, where `rdkit.client.ts` runs the same
 * call in-process rather than reporting it. That mapping is the whole reason a transport fault
 * never reaches a chemist as "that is not a molecule", and it is that file's, not this one's.
 */

import * as Comlink from 'comlink';
import { operations } from './rdkit.engine.ts';

Comlink.expose(operations);
