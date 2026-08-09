/**
 * Answer rendering.
 *
 * NOTE: `rehype-raw` is deliberately NOT installed. react-markdown does not render raw HTML
 * unless you add it, so the correct sanitisation answer here is "do not enable the hazard" —
 * which also saves pulling in a sanitiser. Answer text is model output; letting it emit HTML
 * would be an XSS hole for no benefit. Please do not add `rehype-raw` to this component.
 *
 * Two remark plugins rewrite the text, and their ORDER matters: `remarkCitations` runs first and
 * turns note ids into link nodes, so `remarkGrounding` — which skips anything inside a link —
 * cannot then mistake the digits inside `rxn-4821` for a measurement.
 */

import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCitations, looksLikeSmiles } from '../lib/citations.ts';
import { FIGURE_HREF, remarkGrounding } from '../chem/provenance.ts';
import { CitationChip } from './CitationChip.tsx';
import { InlineSmiles } from './Molecule.tsx';

/**
 * One figure in the answer, marked against what the turn's tools returned.
 *
 * Quiet by design. Grounded figures are the overwhelming majority of a good answer, so they get an
 * underline and nothing else — a page of highlighter is a page nobody reads. The unmatched mark is
 * the one that has to be noticed, and it carries the only tone difference.
 *
 * The wording of the unmatched title is load-bearing and deliberately not an accusation. `numbers`
 * carries no units, so a figure legitimately converted or derived from a returned value is
 * indistinguishable from an invented one; calling it "unsupported" would be the same false verdict
 * the backend's own grounding check produced nine times out of nine when it over-reached.
 */
function FigureMark({
  grounding,
  children,
}: {
  grounding: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (grounding === 'grounded') {
    return (
      <span
        className="border-b border-ok/60 bg-ok-soft/60"
        title="This figure matches a value a tool returned this turn."
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className="rounded-sm border-b border-warn/70 bg-warn-soft px-0.5 text-warn"
      title="Not among the values this turn's tools returned. It may be derived or unit-converted from one — check it against the trace."
    >
      {children}
    </span>
  );
}

const components: Components = {
  a({ href, children, ...props }) {
    if (href?.startsWith('#cite/')) {
      // No leading hole in the destructure: `slice` has already removed the `#cite/` prefix, so
      // the first element IS the kind. Skipping it put the kind in `id` and left `id` empty, and
      // every citation chip therefore rendered as an empty button — the linkified id, the whole
      // point of the plugin, was invisible on screen.
      const [kind = 'note', id = ''] = href.slice('#cite/'.length).split('/');
      return <CitationChip kind={kind} id={id} />;
    }
    if (href?.startsWith(FIGURE_HREF)) {
      return <FigureMark grounding={href.slice(FIGURE_HREF.length)}>{children}</FigureMark>;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
        {children}
      </a>
    );
  },

  code({ className, children, ...props }) {
    const text = String(children ?? '');
    const isBlock = Boolean(className?.startsWith('language-'));
    // An inline code span that looks like a molecule gets a render affordance. Block code is
    // left alone — a fenced block is a recipe or a script, not a structure.
    if (!isBlock && looksLikeSmiles(text)) {
      return <InlineSmiles smiles={text} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/** Hoisted so the default does not mint a new array identity on every render, which would defeat
 *  the memo below. */
const NO_FIGURES: readonly number[] = [];

export function Markdown({
  children,
  figures = NO_FIGURES,
}: {
  children: string;
  /** The values this turn's tools returned. Empty — the default, and the case for every caller
   *  that has nothing to check against — disables figure marking entirely rather than painting
   *  every number as unsupported. */
  figures?: readonly number[];
}): React.JSX.Element {
  // The `[plugin, options]` tuple rather than a pre-applied transformer: unified calls a plugin
  // with its options and expects the transformer back, so passing `remarkGrounding(figures)`
  // directly would have unified invoke it a second time — with `undefined` where the tree goes.
  //
  // Memoised because a new array identity on every render would re-parse the whole answer on every
  // parent update, and the parent re-renders once per streamed token of the *next* turn.
  // Taken off the component rather than imported from `unified`, which is a transitive dependency
  // this package does not declare.
  const plugins = useMemo<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>(
    () => [remarkGfm, remarkCitations, [remarkGrounding, figures]],
    [figures],
  );

  return (
    <div className="prose-answer">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        // Belt and braces alongside not enabling rehype-raw.
        disallowedElements={['script', 'iframe', 'style', 'object', 'embed', 'form']}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
