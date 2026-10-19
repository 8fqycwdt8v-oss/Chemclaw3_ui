/**
 * What this pod did, as numbers a scrape can read.
 *
 * The BFF emitted no traffic signal of any kind: no request rate, no status distribution, no
 * latency, no per-route volume, no upstream error rate. An operator looking at the UI pod during
 * an incident saw three startup lines and silence, and "is the frontend slow or the backend?" —
 * the first question asked in every one of those incidents — had no answer on this side at all.
 *
 * Hand-rolled rather than `prom-client`, and the reason is the same one that keeps this whole
 * process on `node:http`: this is one counter and one histogram over a label set of bounded
 * cardinality, and a dependency here would be more bytes than the exposition it produces.
 *
 * **The label set is bounded by construction and must stay that way.** `route` is the whitelist's
 * *pattern* (`/api/sessions/{id}/messages`), never the path — a per-session label would mint a new
 * time series per conversation and take the scrape down with it. Nothing here takes an actor, a
 * session id, a correlation id or a tool argument as a label; `/metrics` is unauthenticated, as it
 * is on every other service in this family, and its exposition is therefore a public document.
 */

/** Seconds. The tail matters more than the middle here: a 600 s turn is legitimate. */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600] as const;

interface Series {
  route: string;
  method: string;
  status: number;
  count: number;
  sum: number;
  /** Cumulative counts, one per `BUCKETS` entry; `+Inf` is `count`. */
  buckets: number[];
}

const series = new Map<string, Series>();

/** Requests currently being served, so a stuck stream is visible as a level rather than a gap. */
let inFlight = 0;

export const requestStarted = (): void => {
  inFlight += 1;
};

/** Record one finished request. Called from the `finish` handler, so every path lands here. */
export function requestFinished(
  route: string,
  method: string,
  status: number,
  durationSeconds: number,
): void {
  inFlight = Math.max(0, inFlight - 1);
  const key = `${route}\0${method}\0${status}`;
  let entry = series.get(key);
  if (!entry) {
    entry = { route, method, status, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    series.set(key, entry);
  }
  entry.count += 1;
  entry.sum += durationSeconds;
  for (let i = 0; i < BUCKETS.length; i += 1) {
    const bound = BUCKETS[i];
    if (bound !== undefined && durationSeconds <= bound)
      entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
  }
}

/** Upstream failures the proxy answered itself — a 502 the backend never saw. */
let upstreamErrors = 0;
export const upstreamErrorRecorded = (): void => {
  upstreamErrors += 1;
};

/**
 * Sign-in outcomes, by a fixed set of names: the series count is the length of this list, whatever
 * anyone sends. Nothing about who signed in is a label.
 */
const AUTH_EVENTS = [
  'login_started',
  'login_completed',
  'login_failed',
  'logout',
  'refresh',
  'refresh_failed',
  'session_ended',
  'session_missing',
  'csrf_refused',
] as const;
export type AuthEvent = (typeof AUTH_EVENTS)[number];
const authEvents = new Map<AuthEvent, number>(AUTH_EVENTS.map((name) => [name, 0]));
export const authEventRecorded = (event: AuthEvent): void => {
  authEvents.set(event, (authEvents.get(event) ?? 0) + 1);
};

/**
 * Why a sign-in failed, by a fixed set of reasons, so a rise in one is alertable without a label
 * anyone can mint. Nothing about the person or the provider's wording is a label.
 */
const LOGIN_FAILURES = [
  'state',
  'provider_error',
  'exchange_rejected',
  'id_token',
  'idp_unavailable',
  'busy',
] as const;
export type LoginFailure = (typeof LOGIN_FAILURES)[number];
const loginFailures = new Map<LoginFailure, number>(LOGIN_FAILURES.map((name) => [name, 0]));
export const loginFailureRecorded = (reason: LoginFailure): void => {
  loginFailures.set(reason, (loginFailures.get(reason) ?? 0) + 1);
};

const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Signed-in sessions this process holds, read from the store at scrape time so no second count can
 * drift. 0 until a store registers, which is every mode but `AUTH_MODE=bff`.
 */
let countSessions: () => number = () => 0;

/** Called once by the request listener that owns the session store. */
export const sessionsCountedBy = (count: () => number): void => {
  countSessions = count;
};

/** The Prometheus text exposition for everything above. */
export function renderMetrics(): string {
  const lines: string[] = [
    '# HELP chemclaw_ui_requests_total Requests served by the UI server.',
    '# TYPE chemclaw_ui_requests_total counter',
  ];
  for (const s of series.values()) {
    const labels = `route="${escape(s.route)}",method="${escape(s.method)}",status="${s.status}"`;
    lines.push(`chemclaw_ui_requests_total{${labels}} ${s.count}`);
  }

  lines.push(
    '# HELP chemclaw_ui_request_duration_seconds Time to serve a request, including the upstream.',
    '# TYPE chemclaw_ui_request_duration_seconds histogram',
  );
  for (const s of series.values()) {
    const labels = `route="${escape(s.route)}",method="${escape(s.method)}",status="${s.status}"`;
    for (let i = 0; i < BUCKETS.length; i += 1) {
      lines.push(
        `chemclaw_ui_request_duration_seconds_bucket{${labels},le="${BUCKETS[i]}"} ${s.buckets[i] ?? 0}`,
      );
    }
    lines.push(`chemclaw_ui_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`);
    lines.push(`chemclaw_ui_request_duration_seconds_sum{${labels}} ${s.sum}`);
    lines.push(`chemclaw_ui_request_duration_seconds_count{${labels}} ${s.count}`);
  }

  lines.push(
    '# HELP chemclaw_ui_requests_in_flight Requests being served right now.',
    '# TYPE chemclaw_ui_requests_in_flight gauge',
    `chemclaw_ui_requests_in_flight ${inFlight}`,
    '# HELP chemclaw_ui_sessions Signed-in sessions this pod holds.',
    '# TYPE chemclaw_ui_sessions gauge',
    `chemclaw_ui_sessions ${countSessions()}`,
    '# HELP chemclaw_ui_upstream_errors_total Upstream requests that failed before a response.',
    '# TYPE chemclaw_ui_upstream_errors_total counter',
    `chemclaw_ui_upstream_errors_total ${upstreamErrors}`,
    '# HELP chemclaw_ui_auth_events_total Sign-in, sign-out and token-renewal outcomes.',
    '# TYPE chemclaw_ui_auth_events_total counter',
  );
  for (const [event, count] of authEvents) {
    lines.push(`chemclaw_ui_auth_events_total{event="${event}"} ${count}`);
  }
  lines.push(
    '# HELP chemclaw_ui_login_failures_total Sign-ins that failed, by reason.',
    '# TYPE chemclaw_ui_login_failures_total counter',
  );
  for (const [reason, count] of loginFailures) {
    lines.push(`chemclaw_ui_login_failures_total{reason="${reason}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}
