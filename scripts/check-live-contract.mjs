/**
 * Does the service a deployment is actually serving still match the contract this UI is pinned to?
 *
 *   node scripts/check-live-contract.mjs [serviceUrl]     # npm run check:live-contract
 *
 * `contract:check` proves the committed copy is core's file at the pinned commit; it cannot see what
 * a *deployment* serves, which is the difference between a pin and a rollout. This fetches the
 * service's `/openapi.json` — directly from the service, because the BFF forwards no such route —
 * and compares it with `contracts/core-openapi.json`. Operator-run (`npm run check:live`): it needs
 * a live service, and exits non-zero when it cannot read one, because a check that reports success
 * it did not perform is worse than no check.
 *
 * The service is the argument, else `CHEMCLAW_API_URL`. With neither, nothing is configured and
 * the check says so and exits 0. `ACCESS_TOKEN` is sent as a bearer when set.
 *
 * Drift names the pinned and served `info.version` and what differs: routes served that are not
 * pinned, pinned routes not served, and models that differ. The comparison is of the parsed
 * documents, not their bytes.
 */

import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readCopy } from './lib/contractLock.mjs';

/** A value with every object's keys sorted, so two documents compare by content. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** What differs between the pinned and served documents; empty when they agree. */
export function drift(pinned, served) {
  const lines = [];
  if (pinned?.info?.version !== served?.info?.version) {
    lines.push(`info.version: pinned ${pinned?.info?.version}, served ${served?.info?.version}`);
  }
  const compare = (what, a = {}, b = {}) => {
    const added = Object.keys(b).filter((key) => !(key in a));
    const removed = Object.keys(a).filter((key) => !(key in b));
    const changed = Object.keys(a).filter((key) => key in b && !same(a[key], b[key]));
    if (added.length) lines.push(`${what} served and not pinned: ${added.join(', ')}`);
    if (removed.length) lines.push(`${what} pinned and not served: ${removed.join(', ')}`);
    if (changed.length) lines.push(`${what} that differ: ${changed.join(', ')}`);
  };
  compare('routes', pinned.paths, served.paths);
  compare('models', pinned.components?.schemas, served.components?.schemas);
  if (lines.length === 0 && !same(pinned, served)) {
    lines.push('the documents differ outside info, paths and components.schemas');
  }
  return lines;
}

async function main() {
  const base = (argv[2] ?? env.CHEMCLAW_API_URL ?? '').trim().replace(/\/$/, '');
  if (!base) {
    console.log(
      'check:live-contract SKIPPED — no service configured. Pass its URL or set CHEMCLAW_API_URL.',
    );
    return;
  }
  const { document: pinned } = readCopy();
  let served;
  try {
    const res = await fetch(`${base}/openapi.json`, {
      headers: {
        accept: 'application/json',
        ...(env.ACCESS_TOKEN ? { authorization: `Bearer ${env.ACCESS_TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GET ${base}/openapi.json answered ${res.status}`);
    served = await res.json();
  } catch (err) {
    console.error(
      `check:live-contract FAILED — could not read the served contract from ${base}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    exit(1);
  }
  const lines = drift(pinned, served);
  if (lines.length > 0) {
    console.error(
      `check:live-contract FAILED — ${base} serves a contract that is not the pinned one ` +
        `(pinned ${pinned.info?.version}, served ${served?.info?.version}):\n` +
        lines.map((line) => `  - ${line}`).join('\n'),
    );
    exit(1);
  }
  console.log(
    `check:live-contract ok — ${base} serves the pinned contract ${pinned.info?.version}.`,
  );
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) await main();
