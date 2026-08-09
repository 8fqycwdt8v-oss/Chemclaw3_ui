/**
 * Class-name composition.
 *
 * `twMerge` on top of `clsx` because the primitives layer passes `className` down as an override:
 * without conflict resolution, `cn('px-3', 'px-1')` emits both and the winner is whichever
 * Tailwind happens to order later in the stylesheet, not the caller's intent. The previous
 * `filter(Boolean).join(' ')` could not express an override at all.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
