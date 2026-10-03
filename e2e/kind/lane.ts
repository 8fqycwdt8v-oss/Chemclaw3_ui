/**
 * The kind suite's shared vocabulary: who signs in, how a turn is asked and settled, and what a
 * scenario may claim against the lane it is running on.
 *
 * Everything here drives the real UI. Nothing is routed, stubbed or seeded into storage — the
 * one shortcut is reading a bearer off the page's own `/api` traffic, for the few assertions that
 * are about the service's record rather than about what is on screen (and each says so).
 */

import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import type { KindLane } from '../../playwright.kind.config.ts';

export { expect };

export interface Person {
  key: 'alice' | 'bob';
  name: string;
  upn: string;
  oid: string;
}

/** Chemclaw3_mock's preset testers (`app/entra/oidc.py::PRESET_USERS`). */
export const ALICE: Person = {
  key: 'alice',
  name: 'Alice Chemist',
  upn: 'alice@mock-tenant.test',
  oid: '00000000-0000-0000-0000-00000000a11c',
};
export const BOB: Person = {
  key: 'bob',
  name: 'Bob Chemist',
  upn: 'bob@mock-tenant.test',
  oid: '00000000-0000-0000-0000-000000000b0b',
};
/** `src/auth/devAuth.ts`'s principal — the only person there is in devauth mode. */
export const DEV_NAME = 'Dev principal';

export type AuthMode = 'dev' | 'msal';

/** One signed-in person: their own browser context, and the page they are looking at. */
export interface Session {
  person: Person;
  context: BrowserContext;
  page: Page;
  /** Console errors and uncaught page errors seen so far — quoted by failing assertions. */
  problems: string[];
}

export const lane = (info: TestInfo = base.info()): KindLane => info.config.metadata as KindLane;

export const realModel = (): boolean => lane().modelGateway.kind === 'real';

/** Pick the prompt for the lane: a mock behaviour marker, or a question a model has to route. */
export const say = (mock: string, real: string): string => (realModel() ? real : mock);

/**
 * Skip the rest of a scenario whose claim is a *model decision* when there is no model.
 *
 * The scripted mock does not read the question (`chemclaw.cli.mock_llm`): it answers by marker. A
 * claim like "it proposed a plan" or "it cited the record" measures the script against it, so it is
 * skipped with the reason on the line rather than asserted into a meaningless green.
 */
export function requireRealModel(what: string): void {
  base.skip(
    !realModel(),
    `${what} needs a real model: the gateway is the scripted mock ` +
      `(${lane().modelGateway.reason}); run with CHEMCLAW_KIND_LLM=live`,
  );
}

/** A partial scenario: record what was not asserted on this lane, visibly, in the report. */
export function notOnThisLane(description: string): void {
  base.info().annotations.push({ type: 'not asserted on this lane', description });
}

let cachedMode: AuthMode | null = null;

/** The BFF's own answer to "how does this SPA sign in" — its `window.__CHEMCLAW_CONFIG__`. */
export async function authModeOf(uiUrl: string): Promise<AuthMode> {
  if (cachedMode) return cachedMode;
  const res = await fetch(`${uiUrl}/config.js`);
  expect(res.ok, `${uiUrl}/config.js answered ${res.status}`).toBe(true);
  const match = /"authMode":"(dev|msal)"/.exec(await res.text());
  expect(match, 'config.js names no authMode').toBeTruthy();
  cachedMode = match![1] as AuthMode;
  return cachedMode;
}

/** Skip a scenario (or its rest) that needs two distinct people when the lane has only one. */
export function requireTwoPeople(mode: AuthMode): void {
  base.skip(
    mode !== 'msal',
    'needs two distinct people: the cluster is in devauth mode (one dev principal); ' +
      'run make kind-up with CHEMCLAW_KIND_AUTH=oidc-mock',
  );
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The account button in the top bar — its text is the signed-in person's display name. */
export const accountButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Account and build details' });

/**
 * Open a fresh browser context and sign `person` in, ending on whatever page sign-in lands on.
 *
 * In msal mode a signed-out visitor is sent to the authority by the SPA's first `/api` call, so
 * there is nothing to click on the SPA side; the mock tenant's login page offers each preset as
 * `mock-login-<key>`. In dev mode there is no sign-in and every person is the dev principal.
 */
export async function signIn(browser: Browser, person: Person): Promise<Session> {
  const { uiUrl, authority } = lane();
  const mode = await authModeOf(uiUrl);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`));

  await page.goto('/');
  if (mode === 'msal') {
    const choose = page.getByTestId(`mock-login-${person.key}`);
    await expect(choose, `never reached the mock tenant; ${problems.join(' | ')}`).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(authority)}/`));
    await choose.click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(uiUrl)}/`), { timeout: 30_000 });
    await expect(
      accountButton(page),
      `sign-in did not complete; ${problems.join(' | ')}`,
    ).toHaveText(person.name, { timeout: 30_000 });
  } else {
    await expect(accountButton(page)).toHaveText(DEV_NAME, { timeout: 30_000 });
  }
  return { person, context, page, problems };
}

/** The sidebar's "New conversation" — `exact`, because the not-found panel says "Start a new…". */
export async function newConversation(page: Page): Promise<void> {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await expect(composer(page)).toBeVisible();
  await expect(answers(page)).toHaveCount(0);
}

export const composer = (page: Page): Locator => page.getByPlaceholder(/Ask about a reaction/);
export const sendButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Send', exact: true });
export const stopButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Stop', exact: true });
export const answers = (page: Page): Locator =>
  page.getByRole('article', { name: 'Assistant answer', exact: true });
export const lastAnswer = (page: Page): Locator => answers(page).last();
/** The app-level banner — every turn failure lands here as well as in the answer. */
export const banner = (page: Page): Locator => page.getByRole('banner').getByRole('alert');

/** Put a message in the composer and press Send. Does not wait for anything after that. */
export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await sendButton(page).click();
}

/**
 * Ask one question and wait for the turn to settle: the Stop button is present for exactly as long
 * as a turn streams, so its disappearance is the honest "done" (`e2e/full-stack.spec.ts`).
 */
export async function ask(page: Page, text: string, timeout = 240_000): Promise<Locator> {
  const before = await answers(page).count();
  await send(page, text);
  await expect(answers(page)).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(stopButton(page)).toBeHidden({ timeout });
  return lastAnswer(page);
}

/** The trace disclosure of the last turn, expanded, with every step expanded. */
export async function openTrace(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: /The agent’s work/ }).last();
  await expect(trigger, 'the last turn rendered no trace — no tool was called').toBeVisible();
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const expandAll = page.getByRole('button', { name: 'Expand all' });
  if (await expandAll.isVisible()) await expandAll.click();
  const controls = await trigger.getAttribute('aria-controls');
  expect(controls, 'the trace disclosure names no content region').toBeTruthy();
  return page.locator(`[id="${controls}"]`);
}

/** The tool identifiers in the last turn's trace (snake_case names, never prose). */
export async function toolsCalled(page: Page): Promise<string[]> {
  const text = await (await openTrace(page)).innerText();
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
}

/**
 * The bearer the page attaches to its next `/api` request, provoked by a reload. `null` in dev
 * mode, where the BFF signs nothing and the service trusts the dev principal.
 */
export async function bearerOf(page: Page): Promise<string | null> {
  if ((await authModeOf(lane().uiUrl)) !== 'msal') return null;
  const request = page.waitForRequest(
    (r) => r.url().includes('/api/') && !!r.headers().authorization,
  );
  await page.reload();
  const header = (await request).headers().authorization ?? '';
  expect(header).toMatch(/^Bearer /);
  return header.slice('Bearer '.length);
}

/** A JWT's claims, unverified — what the page *sent*. */
export const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

/** The service session id behind the conversation on screen, read off the page's own requests. */
export async function sessionIdOf(page: Page): Promise<string> {
  const ids = await page.evaluate(() => {
    const found: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? '';
      if (!key.startsWith('chemclaw3.chat.')) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as {
          state?: {
            activeId?: string;
            conversations?: Record<string, { sessionId?: string | null }>;
          };
        };
        const active = parsed.state?.activeId;
        const sid = active ? parsed.state?.conversations?.[active]?.sessionId : null;
        if (sid) found.push(sid);
      } catch {
        // not ours
      }
    }
    return found;
  });
  expect(ids.length, 'the active conversation has no service session yet').toBeGreaterThan(0);
  return ids[0]!;
}

/** A tag that makes this run's conversations findable in a sidebar the cluster keeps. */
export const runTag = (): string => `k4-${Date.now().toString(36)}`;

interface Fixtures {
  authMode: AuthMode;
  alice: Session;
  bob: Session;
}

/**
 * `alice` and `bob` are each a signed-in browser context of their own, opened on first use and
 * closed after the test. In dev mode both are the dev principal in separate contexts — which is
 * enough for every single-person scenario and is why the two-person ones call `requireTwoPeople`.
 */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  authMode: async ({}, provide) => {
    await provide(await authModeOf(lane().uiUrl));
  },
  alice: async ({ browser }, provide) => {
    const session = await signIn(browser, ALICE);
    await provide(session);
    await session.context.close();
  },
  bob: async ({ browser }, provide) => {
    const session = await signIn(browser, BOB);
    await provide(session);
    await session.context.close();
  },
});
