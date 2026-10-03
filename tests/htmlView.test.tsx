// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
//
// happy-dom would otherwise *fetch* the frame's `src` — a sandbox origin nothing here serves. It
// still logs that it did not; the line is expected.

/**
 * The `html` artefact's view (wave 3): when it may run, how it is framed, and what it listens to.
 *
 * Unit-level and therefore about *this app's* half only — the attribute set, the fallback, the
 * handshake and the message filter. What the browser does with that attribute set (no fetch, no
 * storage, no top navigation, no popups) is a property of a real browser and a real second origin,
 * and is `e2e/sandbox.spec.ts`'s to prove.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  HtmlView,
  NO_SANDBOX_NOTICE,
  SANDBOX_DOCS_URL,
  SCRIPT_RISKS,
} from '../src/components/exhibits/views/HtmlView.tsx';
import { config } from '../src/env.ts';
import {
  SANDBOX_MAX_HEIGHT,
  SANDBOX_MIN_HEIGHT,
  heightMessage,
  readyMessage,
  usableSandboxOrigin,
} from '../shared/sandbox.ts';
import { decodeExhibitView, type ExhibitView, type HtmlSpec } from '../shared/exhibits.ts';
import { VIEW } from './exhibitFixtures.ts';

const HTML = '<h1>Hi</h1><script>window.ran = true</script>';
const spec: HtmlSpec = { kind: 'html', html: HTML, height: 300 };
const view = decodeExhibitView({
  ...VIEW,
  kind: 'html',
  title: 'Dose–response',
  author_kind: 'agent',
  spec,
  raw_spec: spec,
}) as ExhibitView & { spec: HtmlSpec };

const SANDBOX = 'http://127.0.0.1:4323';

afterEach(() => {
  cleanup();
  config.sandboxOrigin = '';
  config.appOrigin = '';
  config.htmlScriptsDefault = false;
});

describe('without a sandbox origin', () => {
  it.each([
    ['unset', ''],
    ['the app’s own origin', window.location.origin],
    ['not an origin', 'javascript:alert(1)'],
  ])('shows escaped source and the notice when it is %s', (_case, origin) => {
    config.sandboxOrigin = origin;
    const { container } = render(<HtmlView view={view} spec={spec} />);
    expect(screen.getByRole('note').textContent).toContain(NO_SANDBOX_NOTICE);
    expect(container.querySelector('iframe')).toBeNull();
    // Text, never markup: the heading is not a heading and the script is not a script.
    expect(screen.getByRole('region', { name: 'Dose–response — HTML source' }).textContent).toBe(
      HTML,
    );
    expect(container.querySelector('h1, script')).toBeNull();
  });
});

describe('opened at an address other than APP_ORIGIN', () => {
  it('shows the source with both origins named, rather than a frame that would stay blank', () => {
    config.sandboxOrigin = SANDBOX;
    config.appOrigin = 'http://127.0.0.1:9999';
    const { container } = render(<HtmlView view={view} spec={spec} />);
    expect(container.querySelector('iframe')).toBeNull();
    const notice = screen.getByRole('note').textContent ?? '';
    expect(notice).toContain(window.location.origin);
    expect(notice).toContain('http://127.0.0.1:9999');
    expect(screen.getByRole('region', { name: 'Dose–response — HTML source' }).textContent).toBe(
      HTML,
    );
  });

  it('frames as usual when the page is at APP_ORIGIN', () => {
    config.sandboxOrigin = SANDBOX;
    config.appOrigin = window.location.origin;
    render(<HtmlView view={view} spec={spec} />);
    expect(screen.getByTitle('Dose–response — sandboxed HTML preview')).toBeTruthy();
  });
});

describe('with a sandbox origin', () => {
  /** The frame on screen now, with its window's `postMessage` recorded into `sent`. */
  function grab(sent: [unknown, string][]) {
    const frame = screen.getByTitle('Dose–response — sandboxed HTML preview') as HTMLIFrameElement;
    const frameWindow = {
      postMessage: (data: unknown, target: string) => sent.push([data, target]),
    } as unknown as Window;
    Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });
    return { frame, frameWindow };
  }

  function framed(shown: ExhibitView = view) {
    config.sandboxOrigin = SANDBOX;
    const rendered = render(<HtmlView view={shown} spec={spec} />);
    const sent: [unknown, string][] = [];
    return { ...grab(sent), sent, rendered };
  }

  const post = (data: unknown, origin: string, source: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
    });

  /** The shell saying it is armed, as a sandboxed document posts it: from `"null"`. */
  const ready = (frameWindow: Window) => post({ type: 'ready' }, 'null', frameWindow);

  const message = (scripts: boolean) => ({
    type: 'html',
    html: HTML,
    scripts,
    height: 300,
    title: 'Dose–response — sandboxed HTML preview — content',
  });

  it('frames the sandbox origin with allow-scripts and nothing else', () => {
    const { frame } = framed();
    expect(frame.getAttribute('src')).toBe(`${SANDBOX}/sandbox/frame`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    for (const token of [
      'allow-same-origin',
      'allow-popups',
      'allow-top-navigation',
      'allow-forms',
      'allow-modals',
    ]) {
      expect(frame.getAttribute('sandbox')).not.toContain(token);
    }
    expect(frame.style.height).toBe('300px');
  });

  it('hands the frame its HTML only in answer to its own ready, and only once', () => {
    const { frame, frameWindow, sent } = framed();
    // A load is not a ready: nothing is sent until the shell says its listener is armed.
    fireEvent.load(frame);
    expect(sent).toEqual([]);
    // A ready from anywhere else — this page, another window, the frame under a named origin.
    post({ type: 'ready' }, 'null', window);
    post({ type: 'ready' }, 'null', null);
    post({ type: 'ready' }, SANDBOX, frameWindow);
    expect(sent).toEqual([]);
    ready(frameWindow);
    expect(sent).toEqual([[message(false), '*']]);
    // A second ready is the frame having navigated itself: it is not handed the HTML again.
    ready(frameWindow);
    expect(sent).toHaveLength(1);
  });

  it('with scripts on by default, runs them at once and offers Disable scripts per revision', () => {
    config.htmlScriptsDefault = true;
    const { frameWindow, sent, rendered } = framed();
    ready(frameWindow);
    expect(sent).toEqual([[message(true), '*']]);

    fireEvent.click(screen.getByRole('button', { name: 'Disable scripts' }));
    // A new frame (the shell takes one document per load), handed the HTML with scripts off.
    const off: [unknown, string][] = [];
    ready(grab(off).frameWindow);
    expect(off).toEqual([[message(false), '*']]);
    expect(screen.getByRole('button', { name: 'Run scripts' })).toBeTruthy();

    // A new revision of the same artefact is back to the default — the choice is not carried.
    rendered.rerender(<HtmlView view={{ ...view, revision: 3, head_revision: 3 }} spec={spec} />);
    const next: [unknown, string][] = [];
    ready(grab(next).frameWindow);
    expect(next).toEqual([[message(true), '*']]);
    expect(screen.getByRole('button', { name: 'Disable scripts' })).toBeTruthy();
  });

  it('never stores the choice: a remount is back to the default', () => {
    config.htmlScriptsDefault = true;
    const first = framed();
    fireEvent.click(screen.getByRole('button', { name: 'Disable scripts' }));
    first.rendered.unmount();
    const { frameWindow, sent } = framed();
    ready(frameWindow);
    expect(sent).toEqual([[message(true), '*']]);
  });

  it('with HTML_SCRIPTS_DEFAULT=off, runs nothing until Run scripts, which the risks describe', () => {
    config.htmlScriptsDefault = false;
    const { frameWindow, sent } = framed();
    ready(frameWindow);
    expect(sent).toEqual([[message(false), '*']]);
    const run = screen.getByRole('button', { name: 'Run scripts' });
    const notice = document.getElementById(run.getAttribute('aria-describedby') ?? '');
    expect(notice?.textContent).toContain(SCRIPT_RISKS);
    fireEvent.click(run);
    const scripted: [unknown, string][] = [];
    ready(grab(scripted).frameWindow);
    expect(scripted).toEqual([[message(true), '*']]);
  });

  it.each([true, false])(
    'always says scripts run isolated, what they can still do, and where to read more (default %s)',
    (on) => {
      config.htmlScriptsDefault = on;
      framed();
      const notice = screen
        .getAllByRole('note')
        .find((n) => n.textContent?.includes('isolated frame'));
      expect(notice?.textContent).toContain(SCRIPT_RISKS);
      expect(SCRIPT_RISKS).toMatch(/WebRTC/);
      expect(SCRIPT_RISKS).toMatch(/clipboard/);
      expect(SCRIPT_RISKS).toMatch(/navigate/);
      const link = screen.getByRole('link', { name: 'How the sandbox works' });
      expect(link.getAttribute('href')).toBe(SANDBOX_DOCS_URL);
      expect(link.getAttribute('rel')).toContain('noopener');
    },
  );

  it('says it is no network sandbox nowhere', () => {
    config.htmlScriptsDefault = true;
    framed();
    expect(document.body.textContent).not.toMatch(/no network/i);
  });

  it('takes a height only from its own frame, from the opaque origin, and clamps it', () => {
    const { frame, frameWindow } = framed();
    post({ type: 'height', px: 640 }, 'null', frameWindow);
    expect(frame.style.height).toBe('640px');
    // Another window — this page, or a second sandboxed frame posting from "null" too.
    post({ type: 'height', px: 900 }, 'null', window);
    post({ type: 'height', px: 900 }, 'null', null);
    // The frame, but from a named origin: not a sandboxed document.
    post({ type: 'height', px: 900 }, SANDBOX, frameWindow);
    // Anything but a height.
    post({ type: 'navigate', href: 'https://example.com' }, 'null', frameWindow);
    post({ type: 'height', px: 'tall' }, 'null', frameWindow);
    expect(frame.style.height).toBe('640px');
    post({ type: 'height', px: 1e9 }, 'null', frameWindow);
    expect(frame.style.height).toBe(`${SANDBOX_MAX_HEIGHT}px`);
  });
});

describe('the protocol helpers', () => {
  it('reads a ready as a ready and nothing else', () => {
    expect(readyMessage({ type: 'ready' })).toBe(true);
    expect(readyMessage({ type: 'height', px: 1 })).toBe(false);
    expect(readyMessage('ready')).toBe(false);
    expect(readyMessage(null)).toBe(false);
  });

  it('reads only {type: "height", px} and clamps it', () => {
    expect(heightMessage({ type: 'height', px: 10 })).toBe(SANDBOX_MIN_HEIGHT);
    expect(heightMessage({ type: 'height', px: 512.4 })).toBe(512);
    expect(heightMessage({ type: 'height', px: Number.NaN })).toBeNull();
    expect(heightMessage({ type: 'html', px: 500 })).toBeNull();
    expect(heightMessage('height')).toBeNull();
  });

  it('refuses a sandbox origin equal to the app’s, and normalises the rest', () => {
    expect(usableSandboxOrigin('http://a:1/', 'http://b:2')).toBe('http://a:1');
    expect(usableSandboxOrigin('http://b:2', 'http://b:2')).toBe('');
    expect(usableSandboxOrigin('ftp://a', 'http://b')).toBe('');
    expect(usableSandboxOrigin('', 'http://b')).toBe('');
  });
});
