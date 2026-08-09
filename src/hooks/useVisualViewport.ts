/**
 * Keep the composer above the software keyboard on iOS.
 *
 * `100dvh` handles the collapsing URL bar but not the keyboard: iOS does not resize the layout
 * viewport when it opens, so a bottom-anchored composer ends up underneath it. The visual viewport
 * is the only thing that knows, so we publish the difference as a custom property and let the
 * composer pad itself by it.
 *
 * rAF-throttled because the resize fires continuously through the keyboard animation, and this
 * writes to the document element.
 */

import { useEffect } from 'react';

export function useVisualViewport(): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return;

    let frame = 0;
    const update = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // How much of the layout viewport the keyboard (or any other overlay) is covering.
        const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
        document.documentElement.style.setProperty('--viewport-offset', `${Math.round(covered)}px`);
      });
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--viewport-offset');
    };
  }, []);
}
