/**
 * The four panels that are not the conversation, and the entry bundle that carried them.
 *
 * `routes.tsx` statically imported `ReviewQueue`, `JobsPanel`, `ProtocolsPanel` and
 * `ProtocolDocument`, so a chemist who only ever chats downloaded all four before the first paint.
 * Measured with `npm run build:client` on one tree with only this file's imports changed: the
 * initial JS set — the entry module plus every chunk `index.html` preloads — went 653.72 kB →
 * 596.79 kB raw and 199.40 kB → 189.42 kB gzip, and the panels left as 60.52 kB of route chunks.
 *
 * Two assertions, because either alone is weak. The behavioural one proves the routes still
 * *work* through Suspense and that the fallback is a real sentence rather than a blank frame; the
 * source one proves they are still split, which is the thing a later edit would silently undo by
 * adding one convenient static import back.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AppRoutes } from '../src/routes.tsx';
import { AuthGate } from '../src/auth/AuthContext.tsx';
import { jsonError, stubFetch } from './helpers.ts';

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthGate>
        <Routes>
          <Route path="*" element={<AppRoutes />} />
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

let restore: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  // The shell mounts the health poll, the session list and the job streams; none of them is what
  // this file is about, and 404 is the quietest answer the client already absorbs.
  restore = stubFetch(() => jsonError(404, 'not found')).restore;
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

describe('a panel route', () => {
  it.each([
    ['/review', 'Opening the review queue…'],
    ['/jobs', 'Opening the jobs list…'],
    ['/protocols', 'Opening the protocols…'],
    ['/protocols/design-0123456789ab', 'Opening the protocol…'],
  ])('%s says what it is fetching while its chunk arrives', (path, fallback) => {
    renderAt(path);

    // Synchronously after render: with a static import there is no chunk and no fallback, so this
    // is the assertion that fails if the split is undone.
    expect(screen.getByText(fallback)).toBeTruthy();
  });

  it('renders the panel once the chunk resolves, inside the shell', async () => {
    renderAt('/review');

    // The fallback goes away because the panel arrived, not because the route gave up. Asserted
    // on the panel's own copy rather than on a heading: with every request answered 404 the queue
    // renders one of its empty states, and which one is the panel's business, not this file's.
    await waitFor(() => expect(screen.queryByText('Opening the review queue…')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Notes waiting for review' })).toBeTruthy();
    // The shell stayed put while the chunk arrived: Suspense is inside `AppShell`, not around it,
    // so the sidebar's two navs are still there beside the panel rather than replaced by it.
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Other views' })).toBeTruthy();
  });
});

describe('the route module', () => {
  it('imports none of the four panels statically', () => {
    // Relative to the project root, which is vitest's cwd — `import.meta.url` is not a file URL
    // under happy-dom, and this file needs the DOM for the half above.
    const source = readFileSync('src/routes.tsx', 'utf8');

    for (const panel of ['ReviewQueue', 'JobsPanel', 'ProtocolsPanel', 'ProtocolDocument']) {
      // A static `import { X } from './components/X.tsx'` is what this forbids; the `import(…)`
      // inside a loader is a call expression and does not match.
      expect(source, panel).not.toMatch(new RegExp(`^import .*${panel}.* from`, 'm'));
      expect(source, panel).toMatch(new RegExp(`import\\('\\./components/${panel}\\.tsx'\\)`));
    }
  });
});
