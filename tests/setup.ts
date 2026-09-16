/**
 * What every test in this suite starts from, and it is exactly one thing.
 *
 * The query cache is module-scoped — see `src/api/queryClient.ts` for why this app has one client
 * and no `QueryClientProvider` — so without this a case that read a tool result would answer the
 * next case's question, and the next case would pass while making no request at all. That is the
 * same seam `resetPendingPlansCache()` was before it, and the same reason: a fresh page gets a
 * fresh cache, so a fresh case should too.
 *
 * It lives here rather than in a `beforeEach` per file because the failure it prevents is silent in
 * the direction that matters — a test that asserts "one request was made" passes when *zero* were —
 * and a file that forgot the line would be the one place it is not held. Measured while converting
 * `ResultBlock`: three cases in `tests/resultBlocks.test.tsx` failed on a cache one earlier case had
 * filled, which is the loud direction; the quiet direction is the same mechanism with the
 * assertions the other way round.
 *
 * Nothing else belongs here. A setup file is a place every test pays for, so a second entry needs
 * the argument this one has.
 */

import { beforeEach } from 'vitest';
import { resetQueryCache } from '../src/api/queryClient.ts';

beforeEach(() => {
  resetQueryCache();
});
