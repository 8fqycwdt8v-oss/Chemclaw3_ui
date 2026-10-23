/**
 * A chemist's standing queries, from the browser: each is listed and can be stopped, and a
 * deployment that evaluates none says so rather than letting the list read as a promise of news.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WatchesPanel } from '../src/components/WatchesPanel.tsx';
import { stubFetch } from './helpers.ts';
import { resetQueryCache } from '../src/api/queryClient.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value };
});

let restore: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const WATCH = { id: 42, query: 'biaryl couplings', note_type: 'playbook', last_seen_at: null };

function serve(digestsEnabled: boolean): { deletes: string[] } {
  const deletes: string[] = [];
  restore = stubFetch((url, init) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      return new Response(null, { status: 204 });
    }
    if (url.includes('/watches')) {
      return json({ watches: deletes.length ? [] : [WATCH], digests_enabled: digestsEnabled });
    }
    return json({});
  }).restore;
  return { deletes };
}

const show = (): void => {
  render(
    <MemoryRouter>
      <WatchesPanel />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  cleanup();
  resetQueryCache();
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe('the watches screen', () => {
  it('lists a watch and stops it by its id', async () => {
    const { deletes } = serve(true);
    show();
    expect(await screen.findByRole('heading', { name: 'biaryl couplings', level: 3 })).toBeTruthy();
    expect(screen.getByText(/Only playbook notes/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Stop watching/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Stop watching$/ }));
    await waitFor(() => expect(deletes.some((url) => url.endsWith('/watches/42'))).toBe(true));
    expect(await screen.findByText('You watch for nothing')).toBeTruthy();
  });

  it('says nothing evaluates the watches when the deployment has digests off', async () => {
    serve(false);
    show();
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      expect.stringMatching(/does not evaluate watches/),
    );
  });
});
