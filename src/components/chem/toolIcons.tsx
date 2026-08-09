/**
 * Icons for the agent's tools.
 *
 * These were emoji. Emoji render in the platform's colour font — different glyphs on macOS,
 * Windows and Linux — cannot be recoloured to match a theme, and do not scale predictably next to
 * text. For a panel whose whole job is to let a chemist scan what the agent did, a consistent
 * monochrome set that inherits `currentColor` reads considerably faster.
 */

import {
  Atom,
  CircleCheck,
  Cpu,
  Dna,
  Droplet,
  FileText,
  FlaskConical,
  FolderSearch,
  Link2,
  NotebookPen,
  ScanSearch,
  Search,
  Timer,
  TrendingUp,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const TOOL_ICON: Record<string, LucideIcon> = {
  gather_evidence: Search,
  expand_note: FileText,
  find_notes: FolderSearch,
  compute_xtb_energy: Atom,
  predict_pka: TrendingUp,
  predict_solubility: Droplet,
  submit_qm_job: Cpu,
  get_qm_job_status: Timer,
  suggest_next_experiment: FlaskConical,
  screen_hazards: TriangleAlert,
  propose_knowledge_note: NotebookPen,
  record_confirmed_answer: CircleCheck,
  similar_reactions: Link2,
  similar_molecules: Dna,
  substructure_matches: ScanSearch,
};

/**
 * A component rather than a `toolIcon()` that hands back one to render.
 *
 * Returning a component from a call made during render is indistinguishable, to React and to the
 * linter, from *defining* one there — which would remount and lose state on every render. The
 * lookup here is a constant map so the identity is stable either way, but the shape that says so
 * is a component with a prop.
 *
 * Unknown tools get a generic icon rather than nothing: the row still needs its left rail.
 */
export function ToolIcon({
  tool,
  className,
}: {
  tool: string | undefined;
  className?: string;
}): React.JSX.Element {
  const Icon: LucideIcon = (tool && TOOL_ICON[tool]) || Wrench;
  return <Icon aria-hidden className={className} />;
}
