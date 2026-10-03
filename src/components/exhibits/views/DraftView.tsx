/**
 * A document the agent is still writing (wave 2's `exhibit_draft`), drawn as it grows.
 *
 * **Not an artefact, and it says so.** No revision picker, no export, no Edit: there is nothing
 * upstream to revise or download until the tool has run, and an Edit on text that the next frame
 * will overwrite would be a control that loses what is typed into it. The heading carries
 * "Drafting…" and the body is `aria-busy`, so nothing about it reads as a finished document.
 *
 * ## Two rates, deliberately decoupled
 *
 * - **What is drawn** follows the text at most once per animation frame. Frames arrive every
 *   ~250 ms (the service's throttle), but each carries the *whole* text so far and a Markdown
 *   render of a long report is not free; scheduling the render with `requestAnimationFrame` and
 *   cancelling a superseded one means a burst of frames costs one render, and a background tab
 *   costs none.
 * - **What is announced** does not follow the text at all. A live region over the body would read
 *   every chunk aloud — a report spoken as overlapping fragments. The one polite status says that
 *   drafting is under way and, when the artefact replaces it, that it has landed; the text itself is
 *   there to be read once it is finished, like an answer is.
 */

import { useEffect, useId, useState } from 'react';
import { PenLine } from 'lucide-react';
import type { ExhibitDraft } from '../../../state/exhibitDrafts.ts';
import { Markdown } from '../../LazyMarkdown.tsx';

/** `value`, but changing at most once per animation frame — the last value of each frame wins. */
export function useFrameThrottled(value: string): string {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

export function DraftView({
  draft,
  revising,
}: {
  draft: ExhibitDraft;
  /** Drawn over an artefact being revised, rather than as a new one — the banner says which. */
  revising?: boolean;
}): React.JSX.Element {
  const text = useFrameThrottled(draft.markdown);
  const landed = draft.settledAs !== null;
  const headingId = useId();
  // Under the artefact's own title when revising it; the pane's heading when it is a new document.
  const Heading = revising ? 'h3' : 'h2';
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-lg border border-brand/40 bg-brand-soft px-3 py-2 text-xs text-brand-ink">
        <PenLine aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <Heading id={headingId} className="font-medium break-words">
            {revising
              ? `Being revised by the agent${draft.title ? ` — ${draft.title}` : ''}`
              : `Drafting${draft.title ? ` “${draft.title}”` : ' a document'}…`}
          </Heading>
          <p role="status" aria-live="polite">
            {landed
              ? 'Written — opening the artefact.'
              : revising
                ? 'The text below is the agent’s new revision as it is written; it is not saved yet.'
                : 'The text below is being written now. It becomes an artefact when the agent finishes.'}
          </p>
        </div>
      </div>
      <div aria-busy={!landed} className="text-sm">
        {text ? (
          <Markdown>{text}</Markdown>
        ) : (
          <p className="text-ink-muted">Nothing written yet.</p>
        )}
      </div>
    </section>
  );
}
