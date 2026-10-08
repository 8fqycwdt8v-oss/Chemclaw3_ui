/**
 * Response bodies the pinned contract types as an unconstrained `object`, so there is nothing to
 * generate them from. Each is the minimal shape this UI reads and no more; when the contract names
 * one, the entry here is replaced by the generated type and deleted.
 *
 * Not here: the BFF's own routes (`/api/client-events`, `/config.js`), which core does not serve and
 * the contract therefore cannot describe.
 */

/** `GET /healthz` — liveness. Only the HTTP status is read. */
export interface HealthzOut {
  status: string;
}

/** `POST /sessions/{id}/turn/stop` — `deferred` is set for an `unload` stop the service may cancel. */
export interface TurnStopOut {
  stopped: boolean;
  deferred?: boolean;
}
