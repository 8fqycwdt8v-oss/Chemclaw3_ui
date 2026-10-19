/**
 * Which image sources an answer may draw.
 *
 * The BFF's `/api` routes refuse a request without `X-Chemclaw-Csrf`, which an `<img>` cannot send,
 * and `/auth` is not an image. A model-written `![](/api/digests)` would only ever be a 403 — or,
 * before the header was required, a read that consumes what it returns — so it is not drawn.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';

const html = (markdown: string): string =>
  render(<Markdown>{markdown}</Markdown>).container.innerHTML;

describe('an image in an answer', () => {
  it.each(['/plate.png', '/assets/plate.png', 'data:image/png;base64,AAAA', 'blob:http://x/abc'])(
    'is drawn from %s',
    (source) => {
      const out = html(`![the plate](${source})`);
      expect(out).toContain('<img');
    },
  );

  it.each([
    '/api/digests',
    '/api/check-ins',
    '/API/digests',
    '/api',
    '/api?x=1',
    '/auth/logout',
    '/auth/login?returnTo=/',
    '//evil.example/x.png',
    'https://evil.example/x.png',
  ])('is not drawn from %s', (source) => {
    const out = html(`![the plate](${source})`);
    expect(out).not.toContain('<img');
    expect(out).toContain('omitted-image');
  });

  it('is drawn from a path that merely starts like one (/apiary.png)', () => {
    expect(html('![](/apiary.png)')).toContain('<img');
  });
});
