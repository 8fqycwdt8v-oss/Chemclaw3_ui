/**
 * A 403 is a refusal, and this app had no way to say so.
 *
 * `errorFromStatus` handled 401, 404, 409, 422, 429 and 503 and fell through on 403, so an
 * authorization refusal arrived as `kind: 'network'` — the category reserved for "`fetch` itself
 * threw, the service is unreachable" — carrying `retryable: true` and, whenever the response had
 * no `detail` to borrow, the sentence "The service returned an unexpected status (403)."
 *
 * The service has three live producers of that status on routes this UI whitelists and calls, and
 * every one of them is a *permission* fact rather than a fault:
 *
 *   - `POST /jobs/{id}` cancellation (`routes/jobs.py`) — an operator action, privileged role;
 *   - `POST /pending/{id}/answer` (`routes/pending.py`) — "this request is not routed to you";
 *   - the protocol write gate (`routes/protocols.py`) — somebody else's design, needs a review role.
 *
 * `src/api/client.ts` even names 403 as one of four distinct refusals in its own docstring and then
 * had no kind to map it onto, which left every caller that wanted to tell an entitlement apart from
 * an outage comparing `err.status === 403` — the raw-number guessing `errors.ts` exists to stop.
 *
 * What is pinned here is that the kind exists, that it is NOT retryable (a bare retry of a call the
 * caller is not entitled to make cannot succeed, so nothing may offer Retry for one), and that a
 * refusal with no body still reads as a permission refusal rather than as an unexpected status.
 */

import { describe, expect, it } from 'vitest';
import { ApiError, errorFromStatus } from '../src/api/errors.ts';
import { streamTurn } from '../src/api/streamTurn.ts';
import { jsonError, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

describe('errorFromStatus on 403', () => {
  it('maps it to a refusal, never to a network fault', () => {
    const err = errorFromStatus(403, 'this request is not routed to you');

    expect(err.kind).toBe('forbidden');
    expect(err.status).toBe(403);
    // The service's own sentence: it names the entitlement, which nothing here could invent.
    expect(err.message).toBe('this request is not routed to you');
  });

  it('is never retryable', () => {
    // `retryable` is what offers Retry (`sendMessage` reads it to pick the banner's action). A
    // retry of a call the caller has no role for returns the same 403 for as long as they keep
    // pressing, so this is the one property a future consumer must be able to rely on.
    expect(errorFromStatus(403, 'nope').retryable).toBe(false);
    expect(errorFromStatus(403).retryable).toBe(false);
  });

  it('says it is a permission refusal when the service sent no detail to borrow', () => {
    const message = errorFromStatus(403).message;

    expect(message).not.toContain('unexpected status');
    expect(message.toLowerCase()).toContain('permission');
  });

  it('still carries the correlation id, like every other mapped status', () => {
    expect(errorFromStatus(403, 'nope', null, 'abc123').correlationId).toBe('abc123');
  });
});

describe('a 403 through a real request path', () => {
  it('reaches the caller as forbidden rather than as network', async () => {
    // The mapper is only right if the status actually reaches it.
    const stub = stubFetch(() => jsonError(403, 'this request is not routed to you'));
    try {
      const err = await streamTurn({
        sessionId: SESSION,
        message: 'x',
        signal: new AbortController().signal,
        getToken: async () => null,
        onEvent: () => undefined,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe('forbidden');
      expect((err as ApiError).retryable).toBe(false);
    } finally {
      stub.restore();
    }
  });
});
