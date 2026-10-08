/** Types for the part of `contract-check.mjs` that tests import. */

import type { readLock } from './lib/contractLock.mjs';

/**
 * A file of core as it was at the locked commit (`git show <sha>:<path>`), or the reason it could
 * not be read. `required` is `CHEMCLAW3_REQUIRED=1`: it permits fetching the commit into a
 * `CHEMCLAW3_DIR` checkout.
 */
export function coreFileAtPin(
  lock: ReturnType<typeof readLock>,
  required: boolean,
  path?: string,
): { text: string; where: string } | { problem: string };
