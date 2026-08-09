/**
 * The markdown renderer, split out of the initial bundle.
 *
 * `react-markdown` + `remark-gfm` + `unist-util-visit` are around 90 KB and are not needed until
 * the first answer *settles* — while a turn streams the transcript deliberately renders plain
 * pre-wrap text, and a fresh conversation needs none of it at all.
 *
 * Two things make this safe rather than a flash:
 *
 *  - The Suspense fallback is the identical pre-wrap text, in the same type and leading. If it
 *    were a spinner or a skeleton, every answer would blink at the exact moment it finished.
 *  - `prefetchMarkdown()` is called from the turn orchestrator on the first token, so the chunk is
 *    almost always resolved before the answer lands and the fallback never renders.
 */

import { lazy, Suspense } from 'react';

const loader = () => import('./Markdown.tsx').then((m) => ({ default: m.Markdown }));

const Inner = lazy(loader);

let prefetched = false;

/** Warm the chunk. Safe to call repeatedly; only the first call fetches. */
export function prefetchMarkdown(): void {
  if (prefetched) return;
  prefetched = true;
  void loader();
}

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <Suspense
      fallback={<div className="text-base leading-relaxed whitespace-pre-wrap">{children}</div>}
    >
      <Inner>{children}</Inner>
    </Suspense>
  );
}
