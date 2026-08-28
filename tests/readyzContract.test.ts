// @vitest-environment node

/**
 * `/readyz` is a summary, and two live specs asserted it was a roster.
 *
 * Scenario 8 of both `e2e/mock-model.spec.ts` and `e2e/full-stack.spec.ts` stringified the body and
 * looked for connector *names* in it — `calc`, `props`, `rxnpredict`, … The front door returns
 * exactly `{"status": "ready" | "database unreachable", "connectors_unhealthy": <int>}` and does so
 * on purpose: the route is unauthenticated, so `chemclaw.api.routes.ops.readyz` refuses to publish
 * "an inventory of the deployment's internal capability surface plus a live signal of which parts
 * are currently down" to anything that can reach the pod. The names live on `/metrics` and in the
 * per-probe WARNING, both of which are scrape-side.
 *
 * So the mock-model assertion could never pass, and the full-stack one could never have passed
 * either — neither had ever been run green. Worse, each closed with
 * `expect(body).not.toContain('unreachable')`, which is *vacuously* true of a body that names no
 * connector at all: the half that was supposed to catch a real outage asserted nothing.
 *
 * The contract now lives in `e2e/readiness.ts` as a pure predicate, so it can be driven here
 * against the shapes the service actually emits rather than only against a stack this suite cannot
 * start.
 */

import { describe, expect, it } from 'vitest';
import { readinessProblems } from '../e2e/readiness.ts';

describe('what /readyz promises', () => {
  it('accepts the healthy body the front door returns', () => {
    expect(readinessProblems({ status: 'ready', connectors_unhealthy: 0 })).toEqual([]);
  });

  it('fails a database outage, which is the only thing that gates readiness', () => {
    const problems = readinessProblems({ status: 'database unreachable', connectors_unhealthy: 0 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('database unreachable');
  });

  it('fails on an unhealthy connector, and says how many', () => {
    // The assertion the old `not.toContain('unreachable')` was reaching for and could not make:
    // the count is the signal, and a body naming no connector cannot be searched for a state.
    const problems = readinessProblems({ status: 'ready', connectors_unhealthy: 2 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2');
  });

  it('refuses a body that is not this shape rather than reading it as healthy', () => {
    // An older or different service answering `{"ok": true}` must not pass: a readiness assertion
    // that cannot see its own subject is the failure this whole file is about.
    expect(readinessProblems({ ok: true })).not.toEqual([]);
    expect(readinessProblems(null)).not.toEqual([]);
    expect(readinessProblems({ status: 'ready' })).not.toEqual([]);
  });
});
