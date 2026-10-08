/**
 * The pinned core contract, read once for every script that needs it.
 *
 * `contracts/core-openapi.json` is a verbatim copy of core's `schema/api/openapi.json` at the commit
 * `contracts/core.lock` names. The lock is JSON so a diff of a bump reads as four changed lines:
 * `commit`, `contract_version`, `sha256` and the copy itself change together or not at all.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COPY = join(ROOT, 'contracts', 'core-openapi.json');
export const LOCK = join(ROOT, 'contracts', 'core.lock');

const SHA_SHAPE = /^[0-9a-f]{40}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** @param {string | Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The lock, refused unless every field has the shape the checks rely on.
 *
 * @returns {{ repository: string, path: string, commit: string, contract_version: string, sha256: string }}
 */
export function readLock() {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const problems = [];
  if (typeof lock.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(lock.repository))
    problems.push('repository must be owner/name');
  if (typeof lock.path !== 'string' || lock.path.startsWith('/') || lock.path.includes('..'))
    problems.push('path must be a relative path inside the repository');
  if (!SHA_SHAPE.test(lock.commit ?? '')) problems.push('commit must be a full 40-hex sha');
  if (!VERSION_SHAPE.test(lock.contract_version ?? ''))
    problems.push('contract_version must be MAJOR.MINOR.PATCH');
  if (!HASH_SHAPE.test(lock.sha256 ?? '')) problems.push('sha256 must be 64 hex characters');
  if (problems.length > 0) throw new Error(`contracts/core.lock: ${problems.join('; ')}`);
  return lock;
}

/** The committed copy's bytes and parsed document. */
export function readCopy() {
  const bytes = readFileSync(COPY);
  return { bytes, document: JSON.parse(bytes.toString('utf8')) };
}
