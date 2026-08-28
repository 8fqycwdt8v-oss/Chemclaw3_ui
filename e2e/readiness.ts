/**
 * What `GET /readyz` actually promises, for the two live suites that assert on it.
 *
 * The front door returns a **summary**, not a roster:
 *
 *     {"status": "ready" | "database unreachable", "connectors_unhealthy": 0}
 *
 * and that is a decision rather than an omission. The route is one of three deliberately
 * unauthenticated ones, so its body is a public document;
 * `chemclaw.api.routes.ops.readyz` refuses to publish connector *names* on it, because
 * `name=state` for every enabled bundle is an inventory of the deployment's internal capability
 * surface plus a live signal of which parts are down — a map of what to probe next, handed to
 * anything that can reach the Route. The names are on `/metrics`
 * (`chemclaw_connectors_unhealthy`) and in the WARNING each failed probe logs, both scrape-side.
 *
 * The asymmetry is the other half: the **database gates and the connectors do not**. An
 * unreachable connector costs one capability and is reported; an unreachable Postgres means the
 * pod cannot serve a turn at all, so it answers 503 with `status` naming the reason.
 *
 * Both suites' scenario 8 used to stringify the body and search it for connector names, which
 * could not pass against any healthy stack — and closed with
 * `expect(body).not.toContain('unreachable')`, which is vacuously true of a body that names no
 * connector. Encoding the contract once, here, is what stops the next suite writing a third
 * version of a shape it has not read.
 *
 * No `@playwright/test` import on purpose: `tests/readyzContract.test.ts` drives this directly, and
 * pulling the browser runner into the vitest process to check an object shape is the coupling
 * `tests/e2eTiers.test.ts` already declined.
 */

/** The body `GET /readyz` returns. Mirrors `readyz()`'s `dict[str, str | int]` return. */
export interface Readiness {
  /** `"ready"`, or the reason it is not — today only `"database unreachable"`. */
  status: string;
  /** How many enabled connector bundles are unhealthy. Reported, never gating. */
  connectors_unhealthy: number;
}

/**
 * Everything wrong with a `/readyz` body, in sentences. Empty means the deployment is serving.
 *
 * Returns rather than throws so a caller can put the whole list in one assertion message: a stack
 * that is both down on the database and short two connectors should say both.
 */
export function readinessProblems(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    return [`/readyz did not return an object: ${JSON.stringify(body)}`];
  }
  const record = body as Record<string, unknown>;
  const problems: string[] = [];

  // Shape first. A body this function cannot read must never be reported as healthy — that is
  // exactly how the assertion it replaces managed to be vacuous.
  if (typeof record.status !== 'string') {
    problems.push(`/readyz has no string \`status\`: ${JSON.stringify(body)}`);
  } else if (record.status !== 'ready') {
    problems.push(`/readyz says "${record.status}" — the database gates readiness, so this is 503`);
  }

  if (typeof record.connectors_unhealthy !== 'number') {
    problems.push(`/readyz has no numeric \`connectors_unhealthy\`: ${JSON.stringify(body)}`);
  } else if (record.connectors_unhealthy !== 0) {
    problems.push(
      `${record.connectors_unhealthy} connector bundle(s) are unhealthy. The body names none of ` +
        `them by design; \`chemclaw_connectors_unhealthy\` on the service's /metrics and the ` +
        `per-probe WARNING in its log are where the names are.`,
    );
  }

  return problems;
}
