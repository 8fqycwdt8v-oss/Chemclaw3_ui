import dgram from 'node:dgram';
import { expect, test, type Frame, type Page } from '@playwright/test';

/**
 * The HTML sandbox (artefacts wave 3), proved by a real browser against the real headers.
 *
 * The page under test is the agent's worst case written down (`SANDBOX_PROBE_HTML` in the fixture
 * service): it tries to fetch, read cookies and storage, reach into the app's document, navigate
 * the top window, open a popup and send its secret out over WebRTC, and writes what happened into
 * its own document — where this spec reads it through the frames. Each probe's answer is what the
 * *browser* decided; nothing here is asserted about a header string that a unit test does not
 * already pin (`tests/sandboxServer.test.ts`).
 *
 * **By default that script runs** (the owner's decision of 2026-10-03, contract hardening item 4):
 * the shell puts the artefact in a nested `srcdoc` frame with `sandbox="allow-scripts"`, behind the
 * prelude that removes the WebRTC constructors from the content's realm, and the view offers
 * **Disable scripts**. Under `HTML_SCRIPTS_DEFAULT=off` — the kill switch, served by the second BFF
 * `playwright.config.ts` starts — the nested frame is `sandbox=""` and nothing runs until
 * **Run scripts**; the first test below proves that against a real browser and a UDP listener.
 *
 * **Known residual, deliberately not asserted as safe:** the prelude reaches one realm. A scripted
 * page that creates its own nested `srcdoc` frame gets a fresh realm with `RTCPeerConnection`
 * intact (and `allow-scripts` inherited), and can send UDP from there. Running scripts by default
 * accepts that (docs/production-readiness.md); the README names the browser policies that narrow it
 * and `HTML_SCRIPTS_DEFAULT=off`, which removes it.
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
/** The kill-switch BFF (`HTML_SCRIPTS_DEFAULT=off`) and its sandbox, from `playwright.config.ts`. */
const SCRIPTS_OFF_APP = 'http://127.0.0.1:4324';
const SCRIPTS_OFF_SANDBOX = 'http://127.0.0.1:4325';
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

/** The fixture service's `RTC_PROBE_PORT`: where the probe aims its STUN traffic. */
const RTC_PROBE_PORT = 47140;

/** Open the conversation's artefact pane on the HTML probe; hand back the frame element. */
async function openProbe(page: Page, isMobile: boolean, app = '') {
  await seed(page);
  await page.goto(`${app}/c/${CONVERSATION}`);
  await page
    .getByRole('button', { name: isMobile ? 'Artefacts (3)' : 'Show artefacts (3)' })
    .click();
  const pane = isMobile
    ? page.getByRole('dialog', { name: 'Artefacts' })
    : page.getByRole('complementary', { name: 'Artefacts' });
  await pane.getByRole('combobox', { name: 'Artefact' }).selectOption(HTML_ID);
  const frame = pane.locator(`iframe[title="${FRAME_TITLE}"]`);
  await expect(frame).toBeVisible();
  // The artefact's own document: the shell's nested frame.
  const content = page.frameLocator(`iframe[title="${FRAME_TITLE}"]`).frameLocator('iframe');
  await expect(content.getByRole('heading', { name: 'Sandbox probe' })).toBeVisible();
  return { pane, frame, content };
}

/** The shell's frame and the content frame inside it, as Playwright frames. */
function frames(page: Page, sandbox = SANDBOX): { shell: Frame; content: Frame } {
  const shell = page.frames().find((f) => f.url().startsWith(sandbox));
  const content = shell?.childFrames()[0];
  if (!shell || !content) throw new Error('the sandbox frames are not on the page');
  return { shell, content };
}

/** A UDP listener on the probe's port, counting packets and those carrying the probe's secret. */
async function udpListener(): Promise<{
  packets: () => number;
  secrets: () => number;
  close: () => void;
}> {
  let packets = 0;
  let secrets = 0;
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message) => {
    packets += 1;
    if (message.toString('latin1').includes('USERTYPED42')) secrets += 1;
  });
  await new Promise<void>((resolve) => socket.bind(RTC_PROBE_PORT, '127.0.0.1', resolve));
  // The listener itself works: a packet sent here is counted, so a zero below means none came.
  const sender = dgram.createSocket('udp4');
  await new Promise<void>((resolve) =>
    sender.send('control', RTC_PROBE_PORT, '127.0.0.1', () => resolve()),
  );
  sender.close();
  await expect.poll(() => packets).toBe(1);
  packets = 0;
  return { packets: () => packets, secrets: () => secrets, close: () => socket.close() };
}

/**
 * The two tests that listen on the probe's UDP port, in one worker, one after the other: run in
 * parallel the second could not bind it.
 */
test.describe('WebRTC', () => {
  test.describe.configure({ mode: 'serial' });

  test('with HTML_SCRIPTS_DEFAULT=off the page’s script never runs, and nothing leaves over WebRTC', async ({
    page,
    isMobile,
  }) => {
    // One UDP port, so one project at a time; the browser behaviour is not viewport-dependent.
    test.skip(isMobile, 'the UDP listener is a single port');
    const udp = await udpListener();
    try {
      const { frame, content, pane } = await openProbe(page, isMobile, SCRIPTS_OFF_APP);
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(frame).toHaveAttribute('src', `${SCRIPTS_OFF_SANDBOX}/sandbox/frame`);
      // The shell's nested frame runs no script at all.
      await expect(
        page.frameLocator(`iframe[title="${FRAME_TITLE}"]`).locator('iframe'),
      ).toHaveAttribute('sandbox', '');
      // The marker every probe would have changed first, and every probe, untouched.
      await page.waitForTimeout(2_500);
      await expect(content.locator('#ran')).toHaveText('no script ran');
      for (const id of ['fetch', 'cookie', 'storage', 'parent', 'top', 'popup', 'rtc']) {
        await expect(content.locator(`#${id}`)).toHaveText('pending');
      }
      expect(udp.packets()).toBe(0);
      // Off is said, with what turning it on risks.
      await expect(pane.getByRole('button', { name: 'Run scripts' })).toBeVisible();
      await expect(pane.getByText(/through WebRTC/)).toBeVisible();
    } finally {
      udp.close();
    }
  });

  test('by default the page runs at once, sealed, and without the WebRTC constructors', async ({
    page,
    context,
    isMobile,
  }) => {
    const popups: string[] = [];
    context.on('page', (opened) => popups.push(opened.url()));
    // One UDP port, so the desktop run listens and the mobile run does not.
    const udp = isMobile ? null : await udpListener();
    const startedAt = { url: '' };
    try {
      const { pane, content } = await openProbe(page, isMobile);
      startedAt.url = page.url();
      // Nobody pressed anything: the default is scripts on.
      await expect(
        page.frameLocator(`iframe[title="${FRAME_TITLE}"]`).locator('iframe'),
      ).toHaveAttribute('sandbox', 'allow-scripts');
      const probe = (id: string) => content.locator(`#${id}`);
      await expect(probe('ran')).toHaveText('script ran');

      // `connect-src 'none'` on the shell, inherited by the content: even a fetch of a `data:` URL
      // — no network, no CORS, no CORP — is refused, and the browser names the directive.
      await expect(probe('fetch')).toHaveText(/^blocked: TypeError/);
      await expect(probe('csp')).toHaveText('connect-src');
      // Opaque origin (no `allow-same-origin`): no cookie jar, no storage, no reach into the app.
      await expect(probe('cookie')).toHaveText(/^blocked: SecurityError/);
      await expect(probe('storage')).toHaveText(/^blocked: SecurityError/);
      await expect(probe('parent')).toHaveText(/^blocked: SecurityError/);
      // No `allow-top-navigation`, no `allow-popups`.
      await expect(probe('top')).toHaveText(/^blocked: SecurityError/);
      await expect(probe('popup')).toHaveText('blocked: null');
      // The prelude: the constructors are gone from the content's realm, so the probe's attempt
      // threw. Defence in depth only — see the residual in this file's header.
      await expect(probe('rtc')).toHaveText(/^blocked: TypeError/);
      expect(
        await frames(page).content.evaluate(() => [
          typeof (window as unknown as Record<string, unknown>).RTCPeerConnection,
          typeof (window as unknown as Record<string, unknown>).webkitRTCPeerConnection,
          typeof (window as unknown as Record<string, unknown>).RTCDataChannel,
        ]),
      ).toEqual(['undefined', 'undefined', 'undefined']);
      if (udp) {
        // And the probe's own attempt sent nothing. (Without the prelude it sends its secret here.)
        await page.waitForTimeout(2_000);
        expect(udp.packets()).toBe(0);
      }

      // From the outside: the app is where it was, no window opened, its cookie never the frame's.
      expect(page.url()).toBe(startedAt.url);
      expect(popups).toEqual([]);
      expect(await page.evaluate(() => document.cookie)).toContain('e2e_app_secret=hunter2');
      // Said, always: isolated, and what it can still do.
      await expect(pane.getByText(/through WebRTC/)).toBeVisible();

      // Never persisted: Disable, then loading the page again, is back to the default.
      await pane.getByRole('button', { name: 'Disable scripts' }).click();
      await expect(content.locator('#ran')).toHaveText('no script ran');
      const again = await openProbe(page, isMobile);
      await expect(again.content.locator('#ran')).toHaveText('script ran');
      await expect(again.pane.getByRole('button', { name: 'Disable scripts' })).toBeVisible();
    } finally {
      udp?.close();
    }
  });
});

test('the frame cannot navigate itself off the sandbox origin', async ({ page, isMobile }) => {
  await openProbe(page, isMobile);
  await expect(
    page.frameLocator(`iframe[title="${FRAME_TITLE}"]`).frameLocator('iframe').locator('#ran'),
  ).toHaveText('script ran');
  const { shell, content } = frames(page);
  // Somewhere that would answer, and is not the sandbox: the fixture service.
  const elsewhere = 'http://127.0.0.1:4322/healthz';
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http://127.0.0.1:4322')) asked.push(request.url());
  });
  // The content tries to navigate itself, then the shell's frame does: the shell's
  // `default-src 'none'` bounds the first, the app's `frame-src` (the sandbox origin; in MSAL mode
  // also the Entra authority) bounds the second.
  await content.evaluate((url) => {
    window.location.href = url;
  }, elsewhere);
  await shell.evaluate((url) => {
    window.location.href = url;
  }, elsewhere);
  await page.waitForTimeout(1_000);
  expect(asked).toEqual([]);
  for (const frame of page.frames()) expect(frame.url()).not.toContain('127.0.0.1:4322');
});

test('the app takes a height from its frame and from nothing else', async ({ page, isMobile }) => {
  const { frame } = await openProbe(page, isMobile);

  // The shell sized the content at the spec's height and posted its own: that is what the app took.
  await expect.poll(async () => Math.round((await frame.boundingBox())?.height ?? 0)).toBe(520);
  const settled = (await frame.boundingBox())?.height ?? 0;

  // Forged: the app's own window, and the content of a second sandbox frame — a real one, from the
  // same sandbox origin, so it posts from `"null"` exactly as the probe's frame does and differs
  // only in being a different window.
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
          scripts: true,
          html: "<script>top.postMessage({ type: 'height', px: 3333 }, '*');</" + 'script>',
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
