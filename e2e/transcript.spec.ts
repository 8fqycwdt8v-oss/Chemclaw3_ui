import { expect, test } from '@playwright/test';

/**
 * A long transcript.
 *
 * Memoising the bubbles fixed the cost of streaming *into* a long conversation. It did nothing
 * about the conversation being expensive to render at all — the reason this window exists. So the
 * thing worth pinning is the property, not the implementation: a 200-message conversation must not
 * put 200 markdown trees in the DOM, and expanding upwards must not throw the reader forward,
 * which is what happens for free when you prepend content to a scroller.
 */

const STORAGE_KEY = 'chemclaw3.chat.v2';
const CONVERSATION = 'e2e-long-transcript';
const TOTAL = 200;

/** A transcript in exactly the shape `partialize` writes, so the app rehydrates it as its own. */
function seededState() {
  const messages = Array.from({ length: TOTAL }, (_, i) =>
    i % 2 === 0
      ? { id: `m${i}`, role: 'user', text: `Question number ${i}`, at: 1700000000000 + i }
      : {
          id: `m${i}`,
          role: 'assistant',
          at: 1700000000000 + i,
          status: 'done',
          streamedText: '',
          finalText: `Answer number ${i}`,
          confidence: null,
          unsupportedClaims: [],
          reviewRequired: false,
          degradedConnectors: [],
          queued: false,
          trace: [],
          latestPlan: null,
          error: null,
        },
  );
  return {
    version: 3,
    state: {
      conversations: {
        [CONVERSATION]: {
          id: CONVERSATION,
          sessionId: null,
          title: 'A very long conversation',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          messages,
          contextLost: false,
          sessionOrigin: 'local',
        },
      },
      order: [CONVERSATION],
      activeId: CONVERSATION,
      jobFeed: [],
      notifyOnJobComplete: false,
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [STORAGE_KEY, JSON.stringify(seededState())],
  );
});

test('renders a window of a 200-message transcript, not all of it', async ({ page }) => {
  await page.goto(`/c/${CONVERSATION}`);

  // The newest message is the one that must be on screen.
  await expect(page.getByText(`Answer number ${TOTAL - 1}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Load earlier \(140 messages\)/ })).toBeVisible();
  // The oldest is not rendered at all — not merely scrolled out of view.
  await expect(page.getByText('Question number 0')).toHaveCount(0);
});

test('content-visibility does not hide text from find-in-page or the a11y tree', async ({
  page,
}) => {
  await page.goto(`/c/${CONVERSATION}`);

  // `content-visibility: auto` skips layout for off-screen subtrees. It must not skip them for
  // search or assistive technology — if it did, the optimisation would have cost the transcript
  // its readability, which is the whole point of it.
  const early = page.getByText('Answer number 141');
  await expect(early).toHaveCount(1);
  await early.scrollIntoViewIfNeeded();
  await expect(early).toBeVisible();
});

test('Load earlier keeps the reader where they were', async ({ page }) => {
  await page.goto(`/c/${CONVERSATION}`);

  const scroller = page.locator('#transcript');
  await page.getByRole('button', { name: /Load earlier/ }).scrollIntoViewIfNeeded();

  const anchor = page.getByText('Answer number 141');
  const before = await anchor.boundingBox();

  await page.getByRole('button', { name: /Load earlier/ }).click();
  await expect(page.getByText('Question number 80')).toHaveCount(1);

  // Prepending leaves scrollTop numerically unchanged, so without the anchor the reader is thrown
  // forward by the entire inserted height — thousands of pixels, sixty messages away from what
  // they were reading. The message they were looking at must still be on screen.
  await expect(anchor).toBeInViewport();

  // A residue of a hundred-odd pixels is expected and is not the bug. The prepended bubbles carry
  // `content-visibility: auto` with a `contain-intrinsic-size` *estimate*; the ones that end up
  // near the viewport get laid out for real and resolve to less than the estimate, moving what is
  // below them. Bounded at a fraction of the viewport, which is the difference between "settled
  // slightly" and "lost your place".
  const viewport = await scroller.evaluate((el) => el.clientHeight);
  expect(before).not.toBeNull();
  expect(Math.abs(((await anchor.boundingBox())?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(
    viewport / 3,
  );

  // And it must not have slammed back to the bottom, which is the other failure mode.
  const atBottom = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
  );
  expect(atBottom).toBe(false);
});
