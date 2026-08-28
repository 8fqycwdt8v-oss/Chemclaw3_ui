import { expect, test, type Page } from '@playwright/test';

/**
 * A long transcript.
 *
 * Memoising the bubbles fixed the cost of streaming *into* a long conversation. It did nothing
 * about the conversation being expensive to render at all — the reason this window exists. So the
 * thing worth pinning is the property, not the implementation: a 200-message conversation must not
 * put 200 markdown trees in the DOM, and expanding upwards must not throw the reader forward,
 * which is what happens for free when you prepend content to a scroller.
 */

/**
 * The persisted-history slot, which is per ACCOUNT — `chemclaw3.chat.v2.<oid>`, not the bare base.
 *
 * This read `chemclaw3.chat.v2`, the key the store used before `chatStorageKey` partitioned it, so
 * the seed below landed in a slot nothing reads: `hydrateChatForAccount` looked in the dev
 * principal's slot, found it empty, and every test here ran against a conversation the app had
 * never heard of — failing on `getByText('Answer number 199')`, which reads exactly like the
 * windowing having regressed. `dev-user` is the `AUTH_MODE=dev` principal this tier signs in as
 * (`src/auth/devAuth.ts`); `tests/e2eSeed.test.ts` is what keeps this string and that one together.
 */
const STORAGE_KEY = 'chemclaw3.chat.v2.dev-user';
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

/**
 * Open the seeded conversation, and fail on the seed rather than on the transcript.
 *
 * A seed the app does not read renders the "isn't on this device" panel, and every assertion below
 * then fails five seconds later on a message locator — which points a reader at `MessageList`
 * instead of at the key. Checking the panel first turns that into one sentence.
 */
async function openSeeded(page: Page): Promise<void> {
  await page.goto(`/c/${CONVERSATION}`);
  await expect(
    page.getByRole('heading', { name: /isn’t on this device/ }),
    `the app did not rehydrate the seed at ${STORAGE_KEY} — the persist slot is per-account ` +
      `(chatStorageKey), so this is the seed being written to a key nothing reads, not the ` +
      `transcript failing to render`,
  ).toHaveCount(0);
}

test('renders a window of a 200-message transcript, not all of it', async ({ page }) => {
  await openSeeded(page);

  // The newest message is the one that must be on screen.
  await expect(page.getByText(`Answer number ${TOTAL - 1}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Load earlier \(140 messages\)/ })).toBeVisible();
  // The oldest is not rendered at all — not merely scrolled out of view.
  await expect(page.getByText('Question number 0')).toHaveCount(0);
});

test('content-visibility does not hide text from find-in-page or the a11y tree', async ({
  page,
}) => {
  await openSeeded(page);
  // Wait for the pin to have landed. Acting while the transcript is still settling detaches the
  // node mid-scroll, which is a race in the test and not a property of the page.
  await expect(page.getByText(`Answer number ${TOTAL - 1}`)).toBeVisible();

  // `content-visibility: auto` skips layout for off-screen subtrees. It must not skip them for
  // search or assistive technology — if it did, the optimisation would have cost the transcript
  // its readability, which is the whole point of it.
  const early = page.getByText('Answer number 141');
  await expect(early).toHaveCount(1);
  // textContent reaches a skipped subtree; a rendering-only optimisation is the only acceptable
  // kind here.
  expect(await early.textContent()).toContain('Answer number 141');

  // Scroll the container, not the node. An answer body is rendered by a lazily-loaded markdown
  // component, so the matched text node is replaced when that chunk lands — and an action bound
  // to the old node fails with "not attached" whenever the swap wins the race.
  await page.locator('#transcript').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(early).toBeVisible();
});

test('Load earlier keeps the reader where they were', async ({ page }) => {
  await openSeeded(page);

  await expect(page.getByText(`Answer number ${TOTAL - 1}`)).toBeVisible();

  // Scroll to the top explicitly rather than letting an action decide how far to move. The reader
  // this test is about has scrolled up to the start of the window and is looking at the message
  // just below the button, so put the page in exactly that state before measuring anything.
  const scroller = page.locator('#transcript');
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });

  const anchor = page.getByText('Answer number 141');
  await expect(anchor).toBeVisible();

  // The bubble at the top of the viewport is the one the restore pins, so it is the one to measure.
  // An earlier version of this test measured the *next* message down and allowed it a third of a
  // viewport of slack, which conflated two different things and flaked whenever the second one got
  // large: the restore's accuracy, and how wrong `contain-intrinsic-size` happened to be.
  const anchorId = await scroller.evaluate(
    (el) => (el.querySelector('[data-message-id]') as HTMLElement).dataset.messageId,
  );
  const topOf = (id: string): Promise<number> =>
    page.evaluate(
      (mid) => document.querySelector(`[data-message-id="${mid}"]`)!.getBoundingClientRect().top,
      id,
    );
  const before = await topOf(anchorId!);

  await page.getByRole('button', { name: /Load earlier/ }).click();
  await expect(page.getByText('Question number 80')).toHaveCount(1);

  // Prepending leaves scrollTop numerically unchanged, so without a restore the reader is thrown
  // forward by the entire inserted height — thousands of pixels, sixty messages away from what they
  // were reading. Pinned to the pixel, because the restore anchors on this element's own measured
  // position rather than on `scrollHeight`, which is a fiction while sixty freshly inserted bubbles
  // are still reporting their intrinsic-size estimate. (Measured: it was off by 2204px here.)
  expect(Math.abs((await topOf(anchorId!)) - before)).toBeLessThan(4);

  // Messages *below* the anchor may still settle, and that is a different thing from losing your
  // place. The anchor bubble's own `contain-intrinsic-size` estimate is 220px and a one-line bubble
  // is about 65, so when it resolves everything under it rises by the difference — about 175px
  // here. The reader's message has to stay on screen through that; it does not have to stay still.
  await expect(anchor).toBeInViewport();

  // And it must not have slammed back to the bottom, which is the other failure mode.
  const atBottom = await scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
  );
  expect(atBottom).toBe(false);
});
