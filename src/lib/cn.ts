/**
 * Compatibility re-export.
 *
 * `cn` moved to `./utils.ts` — the path shadcn's vendored components import by (`@/lib/utils`).
 * This shim keeps the existing relative importers working during the migration; delete it once
 * they have all moved to `@/lib/utils`.
 */

export { cn } from './utils.ts';
