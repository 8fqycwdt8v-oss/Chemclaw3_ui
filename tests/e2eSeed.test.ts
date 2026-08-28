// @vitest-environment node

/**
 * A browser spec that seeds `localStorage` must seed the key the app actually reads.
 *
 * `e2e/transcript.spec.ts` writes a 200-message conversation into storage and then asserts what
 * the transcript renders. It hardcoded `chemclaw3.chat.v2` — which *was* the persist key until the
 * store was partitioned by account (`chatStorageKey`, `chemclaw3.chat.v2.<oid>`). Nothing connected
 * the two, so the seed went to a slot nothing reads, `hydrateChatForAccount` found the dev
 * principal's slot empty, and all three tests in that file ran against a conversation the app had
 * never heard of. They failed on `getByText('Answer number 199')` — which reads as "the windowing
 * regressed", and is why the campaign that found it spent two hypotheses on `MessageList`.
 *
 * The failure a re-keying like that deserves is this test, not six timeouts in a browser: the key
 * is computed here from the same functions the app uses, and compared with what the spec literally
 * writes. Read as text rather than imported, for the reason `e2eTiers.test.ts` gives — the thing
 * under test is what the file *says*, which is what a reviewer reads.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatStorageKey } from '../src/state/chatStore.ts';
import { createDevAuth } from '../src/auth/devAuth.ts';

const spec = readFileSync(new URL('../e2e/transcript.spec.ts', import.meta.url), 'utf8');

/** The `const STORAGE_KEY = '…'` the spec seeds, as written. */
function seededKey(source: string): string {
  const found = /const STORAGE_KEY = '([^']+)'/.exec(source);
  if (!found?.[1]) throw new Error('transcript.spec.ts no longer declares a STORAGE_KEY literal');
  return found[1];
}

describe('the transcript spec seeds the slot the app reads', () => {
  it('uses the dev principal’s per-account key', () => {
    // The fixture tier runs `AUTH_MODE=dev`, so the account whose slot is rehydrated is the dev
    // provider's own — the one place that principal's id is declared.
    const expected = chatStorageKey(createDevAuth().account?.id);
    expect(
      seededKey(spec),
      'e2e/transcript.spec.ts seeds a localStorage key nothing reads, so the app boots with an ' +
        'empty store and renders "That conversation isn’t on this device"',
    ).toBe(expected);
  });

  it('is not the bare base key, which no account ever reads', () => {
    // The specific regression: `CHAT_STORAGE_BASE` on its own is a prefix now, never a slot.
    expect(seededKey(spec)).not.toBe('chemclaw3.chat.v2');
  });
});
