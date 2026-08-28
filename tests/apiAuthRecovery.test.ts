/**
 * A 401 on any route reaches the sign-in path, not a dead end.
 *
 * `handleUnauthorized` used to have exactly one caller in the app — the turn send path in
 * `state/sendMessage.ts`. Every other route (the conversation list, the transcript, the review
 * queue, the jobs panel, plan decisions, attachment upload, and both detail fetches) went through
 * `api/client.ts`'s `request`, which threw `unauthorized` and stopped. The
 * user read "Your session has expired. Please sign in again." with nothing to click.
 *
 * These tests are written against `api.*` rather than against `request` directly, because the
 * property that matters is "every route inherits this", and only a call through a real method can
 * say that.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../src/api/client.ts';
import type { SessionSummary } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import type { AuthProvider } from '../src/auth/types.ts';
import { jsonError, stubFetch } from './helpers.ts';

const SESSION = 'a'.repeat(32);

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/**
 * A provider whose recovery result is dictated by the test, recording how often it was asked.
 *
 * `tokens` is a queue, so a test can assert the *second* attempt carried the *refreshed* bearer —
 * a retry that resent the stale token would satisfy a call-count assertion and fix nothing.
 */
function provider(
  recovers: boolean,
  tokens: (string | null)[] = ['stale', 'fresh'],
): AuthProvider & {
  asked: number;
} {
  const queue = [...tokens];
  return {
    mode: 'msal',
    account: null,
    asked: 0,
    async getAccessToken() {
      return queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null);
    },
    async login() {},
    async logout() {},
    async handleUnauthorized() {
      this.asked += 1;
      return recovers;
    },
  };
}

const bearer = (init?: RequestInit): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.authorization;

describe('a 401 on a plain route', () => {
  it('is retried once with the refreshed token when the provider recovers', async () => {
    let call = 0;
    // Typed, so the one route this file asserts a *body* for is bound to its declaration: a field
    // added to `SessionSummary` fails `tsc -b` here rather than leaving the fixture behind.
    const body: SessionSummary[] = [{ session_id: SESSION }];
    const stub = stubFetch(() => {
      call += 1;
      return call === 1
        ? jsonError(401, 'invalid or expired token')
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    });
    restore = stub.restore;
    const auth = provider(true);

    const sessions = await api.listSessions(auth);

    expect(sessions).toEqual([{ session_id: SESSION }]);
    expect(auth.asked).toBe(1);
    expect(stub.calls.map((c) => bearer(c.init))).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('surfaces the error without retrying when the provider cannot recover', async () => {
    const stub = stubFetch(() => jsonError(401, 'invalid or expired token'));
    restore = stub.restore;
    const auth = provider(false);

    await expect(api.getProposal(7, auth)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(auth.asked).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it('retries at most once, so a still-401 refresh cannot become a redirect loop', async () => {
    // The provider claims to recover every time — what a misconfigured audience looks like, since
    // the refresh genuinely succeeds and the resource server rejects the result anyway. The cap
    // here makes an unbounded retry fail as an assertion: without it the loop simply never
    // returns, and a test that fails by hanging tells the next reader nothing.
    let call = 0;
    const stub = stubFetch(() => {
      call += 1;
      if (call > 4) throw new Error(`retried ${call} times — the one-shot cap is gone`);
      return jsonError(401, 'invalid or expired token');
    });
    restore = stub.restore;
    const auth = provider(true);

    await expect(api.getPlan(SESSION, auth)).rejects.toBeInstanceOf(ApiError);
    expect(stub.calls).toHaveLength(2);
    expect(auth.asked).toBe(1);
  });

  it('leaves a bare token getter exactly as it was — nothing to recover with', async () => {
    const stub = stubFetch(() => jsonError(401, 'invalid or expired token'));
    restore = stub.restore;

    await expect(api.listJobs(async () => 'only-a-token')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('does not ask the provider to recover from anything but a 401', async () => {
    const stub = stubFetch(() => jsonError(503, 'server at capacity; retry shortly'));
    restore = stub.restore;
    const auth = provider(true);

    await expect(api.getNote('note-x', auth)).rejects.toMatchObject({ kind: 'capacity' });
    expect(auth.asked).toBe(0);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('the token provider failing before any request is opened', () => {
  /**
   * `getAccessToken` throwing is not the same fault as the fetch it never reaches throwing.
   * `msalAuth.getAccessToken` rethrows a silent-refresh failure that is not
   * `InteractionRequiredAuthError` on purpose, rather than resolving it into a forced redirect —
   * so this failure must not be read by `sendMessage` as `kind: 'network'`, which is exactly what
   * happened before `'token_unavailable'` existed: a bare, non-`ApiError` rejection escaped
   * `request` entirely and was wrapped by `sendMessage`'s outer catch as `kind: 'stream'`, sending
   * a request that was never opened into a ten-minute poll of a session that may not even exist
   * yet (the very call that would have created it is the one that failed).
   */
  it('rejects as token_unavailable, retryable, and never calls fetch', async () => {
    const stub = stubFetch(() => jsonError(500, 'must not be reached'));
    restore = stub.restore;
    const auth: AuthProvider = {
      mode: 'msal',
      account: null,
      getAccessToken: () => Promise.reject(new Error('acquireTokenSilent: network is down')),
      login: async () => undefined,
      logout: async () => undefined,
      handleUnauthorized: async () => false,
    };

    const err = await api.createSession(auth).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('token_unavailable');
    expect((err as ApiError).retryable).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('is the same failure for a bare token getter, not only a full AuthProvider', async () => {
    const stub = stubFetch(() => jsonError(500, 'must not be reached'));
    restore = stub.restore;

    const err = await api
      .listSessions(() => Promise.reject(new Error('token store is corrupt')))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('token_unavailable');
    expect(stub.calls).toHaveLength(0);
  });
});

describe('the routes that swallow a 404', () => {
  it('still recover a 401, because an empty list and a signed-out user are different things', async () => {
    let call = 0;
    const stub = stubFetch(() => {
      call += 1;
      return call === 1
        ? jsonError(401, 'invalid or expired token')
        : new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    });
    restore = stub.restore;
    const auth = provider(true);

    // `listProposals` maps a 404 to `[]` so an older service leaves an empty queue rather than a
    // banner. A 401 must not take that path — it would render "nothing to review" to someone who
    // is simply signed out.
    expect(await api.listProposals(auth)).toEqual([]);
    expect(auth.asked).toBe(1);
    expect(stub.calls).toHaveLength(2);
  });
});
