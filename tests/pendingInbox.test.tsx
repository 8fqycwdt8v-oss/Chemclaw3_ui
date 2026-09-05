/**
 * The third gate, which had no surface at all.
 *
 * `GET /pending` and `POST /pending/{id}/answer` were not proxied, had no client method and no
 * screen. **This is not the `/approvals` inbox that was deleted** — that one had three consumers
 * and no producer, which is what made a permanently empty list a lie about a decision nobody could
 * ever be asked to make. This route has three live producers: the `request_external_input` agent
 * tool, `BoCampaignWorkflow._measure` pausing a campaign at the bench for measured yields, and the
 * connector-job path.
 *
 * With no surface, a question reached a chemist as a durable job that ran for seven days and then
 * expired — because the push channel cannot carry it either: `GET /sessions/{id}/events` filters to
 * `("job_completed", "job_failed")`, so the `awaiting-answer` row the workflow writes is never
 * delivered. That half is the service's and is recorded in `ISSUES.md`; this half is a read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ReviewQueue } from '../src/components/ReviewQueue.tsx';
import type { PendingRequest } from '../src/api/client.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

const REQUEST: PendingRequest = {
  request_id: 'req-yield-7',
  kind: 'measurement',
  subject: 'Isolated yield for arm B3',
  rationale: 'The campaign cannot pick the next batch of conditions until this one is measured.',
  asked_of: '',
  requested_by: 'agent',
  session_id: 'a'.repeat(32),
  state: 'waiting',
  due_at: '2026-09-06T00:00:00Z',
  created_at: '2026-09-04T00:00:00Z',
};

let requests: PendingRequest[] = [];
let answerStatus = 204;
const posted: { url: string; body: unknown }[] = [];
let restore: (() => void) | null = null;

function serve(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/pending/') && init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      if (answerStatus === 204) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({ detail: 'this request is already answered' }, answerStatus));
    }
    if (url.includes('/plans/pending')) {
      return Promise.resolve(json({ plans: [], gated: false, unread: 0 }));
    }
    if (/\/pending$/.test(url)) {
      return Promise.resolve(json({ requests, count: requests.length }));
    }
    // Proposals and anything else.
    return Promise.resolve(json([]));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

const mount = (): void => {
  render(
    <MemoryRouter>
      <ReviewQueue />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  cleanup();
  requests = [REQUEST];
  answerStatus = 204;
  posted.length = 0;
  serve();
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a question the agent is holding work open for', () => {
  it('is shown, with the reason it is blocking something', async () => {
    mount();

    expect(await screen.findByText('Isolated yield for arm B3')).toBeTruthy();
    expect(screen.getByText(/cannot pick the next batch/)).toBeTruthy();
  });

  it('sends a measured number as a number', async () => {
    // A yield typed as "82" must not reach a workflow expecting a measurement as the string "82".
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '82.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send it' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({ payload: { value: 82.4 } });
    expect(posted[0]?.url).toContain('/pending/req-yield-7/answer');
  });

  it('needs a second, deliberate act before it goes', async () => {
    // The workflow resumes on this, attributed, and it cannot be taken back — the same posture as
    // every other irreversible decision on this page.
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '82.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the answer' }));

    expect(posted).toHaveLength(0);
    expect(await screen.findByText(/cannot be taken back/)).toBeTruthy();
  });

  it('says so when somebody else answered it first', async () => {
    // Two chemists at one bench is the ordinary case, and the service answers 409 for it. The
    // second must be told rather than have their answer dropped.
    answerStatus = 409;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '82.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send it' }));

    expect(await screen.findByText(/already answered this one/)).toBeTruthy();
  });

  it('lists nothing for a request that has already been decided', async () => {
    // `open_requests` can return history; only `waiting` can be answered, and an inbox showing a
    // settled row invites an action that will 409.
    requests = [{ ...REQUEST, state: 'answered' }];
    mount();

    expect(await screen.findByText('Nothing is waiting on you')).toBeTruthy();
  });

  it('reports a failed read rather than showing an empty inbox', async () => {
    // The whole reason the deleted holds section was a lie: it swallowed its 404 into `[]` and
    // rendered a confident "nothing is waiting" over a channel that was not answering.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/\/pending$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ detail: 'no' }), { status: 500 }));
      }
      if (url.includes('/plans/pending')) {
        return Promise.resolve(
          new Response(JSON.stringify({ plans: [], gated: false, unread: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
    mount();

    expect(await screen.findByText(/could not be asked what is waiting on you/)).toBeTruthy();
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull();
  });
});
