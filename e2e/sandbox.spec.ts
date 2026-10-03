import { expect, test, type Page } from '@playwright/test';

/**
 * The HTML sandbox (artefacts wave 3), proved by a real browser against the real headers.
 *
 * The page under test is the agent's worst case written down (`SANDBOX_PROBE_HTML` in the fixture
 * service): it tries to fetch, read cookies and storage, reach into the app's document, navigate
 * the top window and open a popup, and writes what happened into its own document — where this
 * spec reads it through the frame. Each probe's answer is what the *browser* decided, under the
 * shell's CSP and the frame's `sandbox="allow-scripts"`; nothing here is asserted about a header
 * string that a unit test does not already pin (`tests/sandboxServer.test.ts`).
 *
 * Then the other direction: the app takes a height from that frame and from nothing else — not
 * from its own window, and not from a second sandboxed frame, which posts from the very same
 * opaque origin (`"null"`) and differs only in being a different window.
 */

const STORAGE_KEY = 'chemclaw3.chat.v2.dev-user';
const CONVERSATION = 'e2e-sandbox';
const WAVE3_SESSION = '1'.repeat(32);
const HTML_ID = 'xb-3b0000000000b003';
/** `SANDBOX_PORT` in `playwright.config.ts`, where the BFF's second listener is started. */
const SANDBOX = 'http://127.0.0.1:4323';
const FRAME_TITLE = 'Sandbox probe — sandboxed HTML preview';

async function seed(page: Page): Promise<void> {
  const state = {
    version: 3,
    state: {
      conversations: {
        [CONVERSATION]: {
          id: CONVERSATION,
          sessionId: WAVE3_SESSION,
          title: 'Sandbox probe',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          messages: [],
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
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
      // Something on the app's origin for the frame to try to read.
      document.cookie = 'e2e_app_secret=hunter2; path=/';
    },
    [STORAGE_KEY, JSON.stringify(state)],
  );
}

/** Open the conversation's artefact pane on the HTML probe; hand back the frame element. */
async function openProbe(page: Page, isMobile: boolean) {
  await seed(page);
  await page.goto(`/c/${CONVERSATION}`);
  await page
    .getByRole('button', { name: isMobile ? 'Artefacts (3)' : 'Show artefacts (3)' })
    .click();
  const pane = isMobile
    ? page.getByRole('dialog', { name: 'Artefacts' })
    : page.getByRole('complementary', { name: 'Artefacts' });
  await pane.getByRole('combobox', { name: 'Artefact' }).selectOption(HTML_ID);
  const frame = pane.locator(`iframe[title="${FRAME_TITLE}"]`);
  await expect(frame).toBeVisible();
  return { pane, frame };
}

test('agent-written HTML runs sealed: no network, no app storage, no top, no popups', async ({
  page,
  context,
  isMobile,
}) => {
  const popups: string[] = [];
  context.on('page', (opened) => popups.push(opened.url()));
  const { frame } = await openProbe(page, isMobile);
  const startedAt = page.url();

  // Exactly the contract's attribute set, on a frame from the other origin.
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame).toHaveAttribute('src', `${SANDBOX}/sandbox/frame`);

  const inside = page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
  await expect(inside.getByRole('heading', { name: 'Sandbox probe' })).toBeVisible();
  const probe = (id: string) => inside.locator(`#${id}`);

  // `connect-src 'none'` on the shell: even a fetch of a `data:` URL — no network, no CORS, no
  // CORP — is refused, and the browser names the directive that refused it.
  await expect(probe('fetch')).toHaveText(/^blocked: TypeError/);
  await expect(probe('csp')).toHaveText('connect-src');
  // Opaque origin (no `allow-same-origin`): its own cookie jar and storage do not exist, and the
  // app's document is another origin's.
  await expect(probe('cookie')).toHaveText(/^blocked: SecurityError/);
  await expect(probe('storage')).toHaveText(/^blocked: SecurityError/);
  await expect(probe('parent')).toHaveText(/^blocked: SecurityError/);
  // No `allow-top-navigation`, no `allow-popups`.
  await expect(probe('top')).toHaveText(/^blocked: SecurityError/);
  await expect(probe('popup')).toHaveText('blocked: null');

  // And from the outside: the app is where it was, and no window opened.
  expect(page.url()).toBe(startedAt);
  expect(popups).toEqual([]);
  // The app's cookie is still there and was never the frame's to see.
  expect(await page.evaluate(() => document.cookie)).toContain('e2e_app_secret=hunter2');
});

test('the app takes a height from its frame and from nothing else', async ({ page, isMobile }) => {
  const { frame } = await openProbe(page, isMobile);
  const inside = page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
  await expect(inside.locator('#popup')).not.toHaveText('pending');

  // The shell measured the written page and posted its height: well past the 320 px the spec
  // started at, because the probe page is taller than that. The probe's own `navigate` message
  // and its non-numeric height changed nothing.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(600);
  const settled = (await frame.boundingBox())?.height ?? 0;
  expect(settled).toBeLessThan(1_500);

  // Forged: the app's own window, and a second sandbox frame — a real one, from the same sandbox
  // origin, so it posts from `"null"` exactly as the probe's frame does and differs only in being
  // a different window. (A `srcdoc` frame would prove nothing: the app's CSP blocks its script.)
  await page.evaluate((sandbox) => {
    (window as unknown as { forged: number }).forged = 0;
    window.addEventListener('message', (event) => {
      const data = event.data as { px?: unknown } | null;
      if (event.origin === 'null' && data?.px === 3333) {
        (window as unknown as { forged: number }).forged += 1;
      }
    });
    window.postMessage({ type: 'height', px: 3333 }, '*');
    const forger = document.createElement('iframe');
    forger.setAttribute('sandbox', 'allow-scripts');
    forger.title = 'forger';
    forger.src = `${sandbox}/sandbox/frame`;
    forger.onload = () =>
      forger.contentWindow?.postMessage(
        {
          type: 'html',
          html: "<script>parent.postMessage({ type: 'height', px: 3333 }, '*');</" + 'script>',
        },
        '*',
      );
    document.body.appendChild(forger);
  }, SANDBOX);
  // The forgery really was delivered, from the opaque origin — so ignoring it is the filter's doing.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { forged: number }).forged))
    .toBeGreaterThan(0);
  // Long enough for a debounce on either side to have landed too.
  await page.waitForTimeout(500);
  expect((await frame.boundingBox())?.height).toBe(settled);
});

test('the shell takes content only from the app origin', async ({ page }) => {
  // Loaded top-level, its parent is itself — so the source check passes and the *origin* check is
  // the one that must refuse: a message from the sandbox origin is not one from the app.
  const response = await page.goto(`${SANDBOX}/sandbox/frame`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain(
    `frame-ancestors http://127.0.0.1:4321`,
  );
  await page.evaluate(() =>
    window.postMessage({ type: 'html', html: '<p id="taken">taken</p>' }, '*'),
  );
  await page.waitForTimeout(250);
  await expect(page.locator('#taken')).toHaveCount(0);
  expect(await page.title()).toBe('Artefact sandbox');
});
