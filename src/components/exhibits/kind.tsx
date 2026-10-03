/**
 * How each artefact kind is drawn in a line of chrome: an icon and a word.
 *
 * Both, never the icon alone — the same rule `Charts.tsx` states for colour: nothing that means
 * something is encoded in a shape a reader may not recognise. The word is `KIND_LABEL`'s, so the
 * card, the pane's badge and the "My artefacts" list cannot call one kind two things.
 */

import { Atom, ChartLine, FileText, Hexagon, Link2, Pin, Shapes, Table2 } from 'lucide-react';
import { KIND_LABEL } from '../../../shared/exhibitConstants.ts';

const ICONS: Record<string, typeof FileText> = {
  document: FileText,
  table: Table2,
  structures: Hexagon,
  chart: ChartLine,
  result: Pin,
  link: Link2,
  geometry: Atom,
};

/** The icon for a kind; a kind this build does not know gets the generic one rather than none. */
export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? Shapes;
  return <Icon aria-hidden className={className ?? 'size-3.5'} />;
}

/** The word for a kind. An unknown kind is named as one rather than left blank. */
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? 'Artefact';

/**
 * Who wrote the head, as the card and the picker say it — or `null` for the agent, which is the
 * ordinary case and needs no qualifier.
 *
 * "you" when the head's author is the reader, so a chemist recognises their own correction; a name
 * otherwise, because in a shared session "edited by a human" is not the fact anybody needs.
 */
export function editedBy(
  authorKind: 'agent' | 'human',
  author: string,
  viewer: string | null,
): string | null {
  if (authorKind !== 'human') return null;
  if (viewer && author === viewer) return 'edited by you';
  return author ? `edited by ${author}` : 'edited by a person';
}
