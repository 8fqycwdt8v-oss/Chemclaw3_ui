/**
 * The screen a chemist screenshots has to be worth screenshotting.
 *
 * It printed `error.message` and nothing else. No build version, so nobody could tell which
 * release broke; no correlation id, so nothing joined it to the service's logs; no timestamp, so
 * "this morning" was the whole window; and no way to hand over what the browser had recorded.
 *
 * Also here: the boundary's reporting. `componentDidCatch` was one `console.error`, which is the
 * entire reason a render error nobody was watching happen was a render error nobody heard about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CrashScreen } from '../src/components/CrashScreen.tsx';
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx';
import { logger } from '../src/lib/logger.ts';

beforeEach(() => {
  logger.setContext({ correlationId: 'corr-crash', sessionId: 'sess-crash' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  logger.setContext({ correlationId: '', sessionId: '' });
});

describe('the crash screen', () => {
  it('shows the message, the build, the time and the reference', () => {
    const view = render(<CrashScreen error={new Error('Cannot read properties of null')} />);
    expect(view.getByText(/Cannot read properties of null/)).toBeTruthy();
    expect(view.getByText('corr-crash')).toBeTruthy();
    // The build and a timestamp, both of which a screenshot otherwise loses.
    expect(view.getByText('build')).toBeTruthy();
    expect(view.getByText(/^\d{4}-\d{2}-\d{2}T/)).toBeTruthy();
  });

  it('says so plainly when there is no reference, rather than inventing one', () => {
    logger.setContext({ correlationId: '' });
    const view = render(<CrashScreen error={new Error('boom')} />);
    expect(view.getByText('—')).toBeTruthy();
  });

  it('copies the ring buffer, so the reader can paste what the browser recorded', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    logger.error('render.failed', { name: 'TypeError' });

    const view = render(<CrashScreen error={new Error('boom')} />);
    fireEvent.click(view.getByRole('button', { name: /Copy diagnostics/ }));
    await Promise.resolve();

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('render.failed');
    expect(written[0]).toContain('corr-crash');
  });

  it('shows the text to copy by hand when the clipboard is refused', () => {
    // An insecure origin, a denied permission, an old WebView. Not a failure the reader can act
    // on, so it must not be reported as one — the text is simply put on screen instead.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const view = render(<CrashScreen error={new Error('boom')} />);
    fireEvent.click(view.getByRole('button', { name: /Copy diagnostics/ }));
    expect(view.getByRole('region', { name: /Diagnostics/ })).toBeTruthy();
  });
});

function Boom(): React.JSX.Element {
  throw new Error('render exploded');
}

describe('the boundary', () => {
  it('records the failure as well as showing it', () => {
    // React logs the caught error itself; silence both so the suite output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={(error) => <p>caught: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/caught: render exploded/)).toBeTruthy();
    const entry = logger.snapshot().findLast((e) => e.message === 'render.failed');
    expect(entry?.level).toBe('error');
    expect(entry?.context).toMatchObject({ message: 'render exploded' });
    // The join key, on the report of a crash — which is where support starts from.
    expect(entry?.correlationId).toBe('corr-crash');
  });
});
