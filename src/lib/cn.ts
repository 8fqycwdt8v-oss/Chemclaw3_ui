/** Conditional class names. Six lines instead of a `clsx` dependency. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
