/**
 * A list of cited flags — the hazard screen and the genotoxicity alert screen.
 *
 * These results are advisory and they carry citations, and both properties have to survive the
 * rendering. The backend's own module docstring is unusually blunt about the direction the failure
 * runs in: "an over-trusted screen is more dangerous than no screen, because it converts an absence
 * of knowledge into apparent assurance", and a live run had a chemist told "no hazards detected"
 * six times before the disclaimer was made part of the payload. So:
 *
 *  - the verdict is rendered **verbatim and always**, including — especially — on an empty result,
 *    where it is the sentence that stops "no rule matched" reading as a clearance;
 *  - a clean screen still names what it looked at, which is what `screened` was added for;
 *  - nothing is coloured `ok`, ever. There is no clearance to render, so there is no green.
 *
 * Each flag shows its explanation *and* its citation *and* what it matched, because those three
 * are what make a flag checkable rather than an assertion.
 */

import { cn } from '../../lib/cn.ts';
import { Molecule } from '../Molecule.tsx';
import type { CitedFlag, CitedFlagList, Severity } from './shapes.ts';

/** No `ok` anywhere. `medium` and `low` differ in the word, not in a softer colour: both are
 *  matched rules from a cited table, and the table is what ranks them. */
const SEVERITY_TONE: Record<Severity, string> = {
  high: 'border-danger/40 bg-danger-soft text-danger',
  medium: 'border-warn/40 bg-warn-soft text-warn',
  low: 'border-warn/40 bg-warn-soft text-warn',
};

/**
 * The components a flag fired on. `"a + b"` is an incompatibility pair — two structures, and the
 * pairing is the finding, so both are drawn.
 *
 * Split on the separator **with its spaces**, which is how the backend writes it (`f"{a} + {b}"`).
 * Splitting on a bare `+` would cut `CCN=[N+]=[N-]` into three fragments and hand two of them to a
 * structure renderer — an azide flagged as energetic, redrawn as something else entirely.
 */
const matchedParts = (matched: string): string[] =>
  matched
    .split(' + ')
    .map((part) => part.trim())
    .filter((part) => part !== '');

function Flag({
  flag,
  showStructures,
}: {
  flag: CitedFlag;
  showStructures: boolean;
}): React.JSX.Element {
  return (
    <li className="rounded-md border border-border-subtle bg-surface-raised p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {flag.severity ? (
          <span
            className={cn(
              'inline-flex items-center rounded border px-1.5 py-px text-[0.7rem] font-medium uppercase',
              SEVERITY_TONE[flag.severity],
            )}
          >
            {flag.severity}
          </span>
        ) : (
          /* A genotoxicity alert has no severity, and inventing one would be the first half of a
             classification the published alert sets do not make. The chip says what it is. */
          <span className="inline-flex items-center rounded border border-warn/40 bg-warn-soft px-1.5 py-px text-[0.7rem] font-medium text-warn">
            alert
          </span>
        )}
        {flag.motif && <span className="text-sm font-medium">{flag.motif}</span>}
        {flag.id && <span className="font-mono text-xs text-ink-muted">{flag.id}</span>}
      </div>
      <p className="mt-1 text-sm">{flag.explanation}</p>
      <p className="mt-1 text-xs text-ink-muted">
        <span className="font-medium">Cited:</span> {flag.citation}
      </p>
      <p className="mt-0.5 break-all font-mono text-xs text-ink-muted">matched {flag.matched}</p>
      {showStructures && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {matchedParts(flag.matched).map((part, i) => (
            <Molecule
              key={`${part}-${i}`}
              smiles={part}
              width={160}
              height={110}
              // Present only if the result ever carries the rule's pattern; today it does not, and
              // an undecorated structure is the honest rendering of a motif we were not given.
              {...(flag.smarts ? { highlightSmarts: flag.smarts } : {})}
            />
          ))}
        </div>
      )}
    </li>
  );
}

export function CitedFlags({ result }: { result: CitedFlagList }): React.JSX.Element {
  const clean = result.flags.length === 0;
  const title = result.subject === 'hazard' ? 'Structural hazard screen' : 'Genotoxicity alert screen';

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>

      {/* The verdict first, and in a tone that is never `ok`: on a clean result this sentence is
          the result. Rendering it below a reassuring empty list would put the caveat where a
          reader stops before reaching it. */}
      {result.verdict && (
        <p
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            clean
              ? 'border-warn/40 bg-warn-soft text-warn'
              : 'border-danger/40 bg-danger-soft text-danger',
          )}
        >
          {result.verdict}
        </p>
      )}

      {result.screened.length > 0 && (
        <div>
          <p className="text-xs text-ink-muted">
            Screened {result.screened.length === 1 ? 'structure' : 'structures'}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {result.screened.map((smiles) => (
              <Molecule key={smiles} smiles={smiles} width={170} height={120} />
            ))}
          </div>
        </div>
      )}

      {result.flags.length > 0 && (
        <ul className="space-y-2">
          {result.flags.map((flag, i) => (
            <Flag
              key={`${flag.id}-${flag.matched}-${i}`}
              flag={flag}
              // Redrawn per flag only when the screen covered more than one structure, where
              // *which* component fired is the finding. On a single-molecule screen it is the
              // structure already drawn above, and repeating it once per flag buries the flags.
              showStructures={result.screened.length > 1}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
