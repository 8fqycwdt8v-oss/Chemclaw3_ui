/**
 * The message-length cap is the deployment's, not the bundle's.
 *
 * `CHEMCLAW_SERVICE_MAX_MESSAGE_CHARS` is a setting the service exists to have tuned — its
 * validator refuses with a 422 at whatever the site chose — and the composer held a compile-time
 * copy of the default. Both directions of the resulting disagreement are real: a site that raised
 * the cap got a composer refusing messages the service would have accepted, with no way to send
 * them and nothing on screen explaining why; a site that lowered it got a composer that invited a
 * message, disabled nothing, and let the whole body cross the wire to be rejected at the far end.
 *
 * So the value crosses `/config.js` with the rest of the runtime configuration, and the shared
 * constant is the fallback for a bundle served by something that does not send it. Nothing here
 * enforces anything — the service is still the only party that decides — this is the composer
 * agreeing with the validator about where the line is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MAX_MESSAGE_CHARS } from '../shared/events.ts';
import { useChatStore } from '../src/state/chatStore.ts';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const CONVERSATION = 'conv-cap';

/**
 * Boot the SPA's config the way a page load does, then take a composer built against it.
 *
 * The modules are reset and re-imported because `src/env.ts` resolves `config` once at module
 * scope — which is the behaviour under test, not an inconvenience: a value read at import time is
 * exactly what a runtime bridge has to survive.
 */
async function composerWith(
  runtime: Record<string, unknown> | null,
): Promise<{ Composer: (props: { conversationId: string }) => React.JSX.Element }> {
  delete window.__CHEMCLAW_CONFIG__;
  if (runtime) window.__CHEMCLAW_CONFIG__ = runtime;
  vi.resetModules();
  return (await import('../src/components/Composer.tsx')) as never;
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement;
const send = (): HTMLButtonElement => screen.getByLabelText('Send') as HTMLButtonElement;

function seedStore(): void {
  useChatStore.setState({
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        sessionId: 'a'.repeat(32),
        sessionOrigin: 'local' as const,
        title: 'test',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        contextLost: false,
      },
    },
    order: [CONVERSATION],
    activeId: CONVERSATION,
    drafts: {},
    sessionProfiles: {},
    composerLock: false,
    banner: null,
    streaming: null,
  });
}

beforeEach(() => {
  cleanup();
  seedStore();
});

afterEach(() => {
  cleanup();
  delete window.__CHEMCLAW_CONFIG__;
  vi.resetModules();
});

describe('the composer against a tuned cap', () => {
  it('refuses at the deployment’s limit, not at the built-in default', async () => {
    const { Composer } = await composerWith({ maxMessageChars: 20 });
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'x'.repeat(21) } });

    // Under the compile-time constant this was 21 of 100,000 characters: Send enabled, and a
    // 422 waiting on the other side of the wire.
    expect(send().disabled).toBe(true);
    expect(screen.getByText('21 / 20')).toBeTruthy();
  });

  it('accepts what the deployment raised the limit to', async () => {
    const { Composer } = await composerWith({ maxMessageChars: MAX_MESSAGE_CHARS * 2 });
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'x'.repeat(MAX_MESSAGE_CHARS + 1) } });

    expect(send().disabled).toBe(false);
  });

  it('falls back to the backend’s own default when nothing supplies one', async () => {
    // A BFF that predates the field, or a `vite dev` with no server behind it.
    const { Composer } = await composerWith(null);
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'x'.repeat(MAX_MESSAGE_CHARS + 1) } });

    expect(send().disabled).toBe(true);
  });

  it('ignores a cap that would refuse every message', async () => {
    // Zero is not a stricter limit; it is a composer that cannot send at all. A bad value must
    // not be the one that wins over the default.
    const { Composer } = await composerWith({ maxMessageChars: 0 });
    render(<Composer conversationId={CONVERSATION} />);

    fireEvent.change(box(), { target: { value: 'a real question' } });

    expect(send().disabled).toBe(false);
  });
});
