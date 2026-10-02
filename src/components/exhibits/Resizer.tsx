/**
 * The handle between the transcript and the artefact pane — a window splitter, written by hand.
 *
 * Hand-written for the reason `Charts.tsx` gives about charting: every runtime dependency here is
 * somebody's review, and a split-pane package would be one more for about sixty lines. What it has
 * to get right is the WAI-ARIA *window splitter* pattern, because a handle only a mouse can move is
 * a pane whose width a keyboard user cannot choose:
 *
 *  - `role="separator"`, focusable, with `aria-valuenow`/`-valuemin`/`-valuemax` — a focusable
 *    separator *is* a widget, and axe requires the value for it;
 *  - **Left/Right arrows** move it by a step, **Shift** by four; the pane is on the right, so Left
 *    widens it — the handle moves the way the key points;
 *  - **Home/End** go to the pane's minimum and maximum;
 *  - the pointer drags it, captured, so a fast drag that leaves the handle keeps resizing.
 *
 * The value is the pane's width in CSS pixels, which is what a screen reader announces as
 * `aria-valuetext`. The bounds live in `state/exhibitPane.ts`, which also clamps — this component
 * only reports where the reader is trying to put the edge.
 */

import { useRef } from 'react';
import { PANE_MAX_PX, PANE_MIN_PX, PANE_STEP_PX, clampWidth } from '../../state/exhibitPane.ts';
import { cn } from '@/lib/utils';

export function Resizer({
  width,
  onResize,
  controls,
}: {
  width: number;
  onResize: (px: number) => void;
  /** The id of the pane this separator sizes — `aria-controls`, so the relationship is stated. */
  controls: string;
}): React.JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? PANE_STEP_PX * 4 : PANE_STEP_PX;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = width + step;
    else if (e.key === 'ArrowRight') next = width - step;
    else if (e.key === 'Home') next = PANE_MIN_PX;
    else if (e.key === 'End') next = PANE_MAX_PX;
    if (next === null) return;
    e.preventDefault();
    onResize(clampWidth(next));
  };

  return (
    // A *focusable* separator is an interactive widget in WAI-ARIA (the window splitter pattern),
    // which `jsx-a11y` cannot tell from a decorative `<hr>`-style separator: both rules below are
    // about the static kind, and the value attributes axe checks are exactly what make this one a
    // widget. axe passes it in `e2e/a11y.spec.ts`.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the artefact pane"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={PANE_MIN_PX}
      aria-valuemax={PANE_MAX_PX}
      aria-valuetext={`${width} pixels wide`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(clampWidth(drag.current.startWidth + (drag.current.startX - e.clientX)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      className={cn(
        // A 6px hit area over a 1px line: the line is what is seen, the area is what is grabbed.
        'group absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize touch-none',
        'focus-visible:outline-none',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-[2px] w-px bg-border-subtle transition-colors',
          'group-hover:bg-brand group-focus-visible:w-[3px] group-focus-visible:bg-brand',
        )}
      />
    </div>
  );
}
