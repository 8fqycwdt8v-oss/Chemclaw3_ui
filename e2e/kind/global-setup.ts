/**
 * Before any scenario runs: wait until the cluster is *steadily* ready, not just up.
 *
 * Run 3 of this suite started about three minutes after a rollout, while the UI's and the front
 * door's readiness probes were still flapping — a pod answering, then `ERR_EMPTY_RESPONSE`, then
 * answering again as the old ReplicaSet drained. Scenarios failed on a dropped connection, and a
 * reader of the report could not tell that from a product defect. So the run gates on both
 * `/readyz` endpoints answering 200 several rounds **in a row** (one success during a flap proves
 * nothing), bounded, and says on timeout exactly what each one last answered.
 *
 * `CHEMCLAW_KIND_READY_TIMEOUT_MS` overrides the bound (default 10 min); `0` skips the gate.
 */

import type { FullConfig } from '@playwright/test';
import type { KindLane } from '../../playwright.kind.config.ts';

/** Consecutive rounds in which every endpoint must answer 200. */
const STEADY_ROUNDS = 5;
const INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function probe(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // Drained so the connection is released; the body itself is not the question.
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 200 ? null : `HTTP ${res.status}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const lane = config.metadata as unknown as KindLane;
  const raw = process.env.CHEMCLAW_KIND_READY_TIMEOUT_MS?.trim();
  const timeoutMs = raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`CHEMCLAW_KIND_READY_TIMEOUT_MS must be a number of ms, not "${raw}"`);
  }
  if (timeoutMs === 0) return;

  const endpoints = [
    { name: 'UI', url: `${lane.uiUrl}/readyz` },
    { name: 'front door', url: `${lane.coreUrl}/readyz` },
  ];
  const last = new Map<string, string>(endpoints.map((e) => [e.name, 'not asked yet']));
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let rounds = 0;

  console.log(
    `[kind] waiting for ${endpoints.map((e) => e.url).join(' and ')} to answer 200 ` +
      `${STEADY_ROUNDS} times in a row (up to ${Math.round(timeoutMs / 1000)} s)`,
  );
  for (;;) {
    rounds += 1;
    const outcomes = await Promise.all(endpoints.map((e) => probe(e.url)));
    endpoints.forEach((e, i) => last.set(e.name, outcomes[i] ?? 'HTTP 200'));
    const allReady = outcomes.every((o) => o === null);
    if (allReady) {
      streak += 1;
      if (streak >= STEADY_ROUNDS) {
        console.log(`[kind] cluster steadily ready after ${rounds} rounds`);
        return;
      }
    } else {
      if (streak > 0) {
        const down = endpoints.filter((_, i) => outcomes[i] !== null).map((e) => e.name);
        console.log(`[kind] readiness flapped after ${streak} good rounds: ${down.join(', ')}`);
      }
      streak = 0;
    }
    if (Date.now() + INTERVAL_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  const detail = endpoints.map((e) => `  ${e.name} ${e.url}: last ${last.get(e.name)}`).join('\n');
  throw new Error(
    `The kind cluster did not become steadily ready within ${Math.round(timeoutMs / 1000)} s ` +
      `(needs ${STEADY_ROUNDS} consecutive rounds of HTTP 200 from both /readyz; ` +
      `the last streak was ${streak}). No scenario was run, so nothing here is a product result.\n` +
      `${detail}\n` +
      'Check the rollout (kubectl rollout status, pod readiness) and rerun, or set ' +
      'CHEMCLAW_KIND_READY_TIMEOUT_MS to wait longer.',
  );
}
