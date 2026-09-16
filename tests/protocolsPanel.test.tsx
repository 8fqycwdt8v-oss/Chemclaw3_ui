/**
 * The protocol list, and the one thing it has to say about a service that is not answering.
 *
 * **This panel had no test file at all**, which is how a regression got into it during the
 * react-query migration and came out again only because somebody read the render conditions. It
 * renders the spinner and the error message from two *independent* conditions — `{!designs && …}`
 * and `{failed && …}` — so a `designs` that stays `null` on a failure shows both at once: a
 * "Reading the designs…" that will never finish, under a banner saying it already failed.
 *
 * `data` on a failed query is `undefined`, so the default decides which of those two states a
 * failure is. The catch this replaced answered `{ list: [], error }` for exactly this reason, and
 * nothing recorded that the `[]` was load-bearing.
 *
 * **A broken service is not an empty lab**, which is the other half and the one that was already
 * argued: an earlier version of this component caught everything into an empty list, so a 500 and
 * an expired session both rendered "No experiment design yet" with no banner at all. Both
 * directions are driven here, because either alone is satisfied by the wrong behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ProtocolsPanel } from '../src/components/ProtocolsPanel.tsx';
import { stubFetch } from './helpers.ts';

vi.mock('../src/auth/AuthContext.tsx', () => {
  // Stable identity, as the real context value is: a fresh object per render re-fires every
  // `[auth]` dependency.
  const value = { auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true };
  return { useAuth: () => value, useIsReviewer: () => true };
});

let restore: (() => void) | null = null;

const serve = (status: number, body: unknown): void => {
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  restore = stub.restore;
};

const mount = (): void => {
  render(
    <MemoryRouter>
      <ProtocolsPanel />
    </MemoryRouter>,
  );
};

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('the protocol list against a service that will not answer', () => {
  it('says what went wrong and stops reading, rather than doing both at once', async () => {
    serve(500, { detail: 'the design store is unreachable' });

    mount();

    expect(await screen.findByRole('status')).toBeTruthy();
    // The spinner is gone. Leaving it up under the banner is "still loading" and "this failed and
    // will never load" on the screen together, which is worse than either.
    expect(screen.queryByText('Reading the designs…')).toBeNull();
  });

  it('does not report a broken service as an empty lab', async () => {
    // The direction that was already argued in the component: catching everything into an empty
    // list made a 500 and an expired session both render "No experiment design yet". The empty
    // state and the banner are mutually exclusive on purpose.
    serve(500, { detail: 'the design store is unreachable' });

    mount();

    await screen.findByRole('status');
    expect(screen.queryByText('No experiment design yet')).toBeNull();
  });

  it('shows the empty state, and no banner, when the service answers with nothing', async () => {
    // The positive control: without this the two cases above pass for a component that renders
    // neither state ever.
    serve(200, { designs: [] });

    mount();

    expect(await screen.findByText('No experiment design yet')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Reading the designs…')).toBeNull();
  });
});
