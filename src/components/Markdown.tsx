/**
 * Answer rendering. Plugin order matters:
 *
 * 1. `remarkStripReservedLinks` first — a security boundary: the answer is model-written, so its
 * own `#cite/` and `#figure/` links are unwrapped before the plugins that mint those hrefs.
 * Anything new that mints them goes after it. 2. `remarkCitations` before `remarkGrounding`, so
 * digits inside a note id are inside a link and not treated as figures.
 *
 * `rehype-raw` is deliberately not installed: answer text is model output, and raw HTML would be an
 * XSS hole.
 */

import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from 'react-markdown';
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

/** Unwrap links the answer wrote in a reserved scheme, keeping their text. */
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
 * Model headings are demoted two levels (h1 → h3, …) so the page outline stays valid; the `.md-h*`
 * class keeps the visual size.
 */
const HEADING_LEVELS = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' } as const;

const heading = (from: keyof typeof HEADING_LEVELS) => {
  const Tag = HEADING_LEVELS[from];
  // `node` is destructured out and never spread, or React renders it as an attribute.
  return function Heading({
    children,
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) {
    return (
      <Tag className={`md-${from}`} {...props}>
        {children}
      </Tag>
    );
  };
};

/**
 * One figure, marked against the turn's returned values: grounded gets a quiet underline; unmatched
 * gets the one tone change. The title says "not found among returned values", never "unsupported"
 * (no units on the wire).
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

  a({ href, children, node: _node, ...props }) {
    if (href?.startsWith(CITE_HREF)) {
      // `slice` already removed `#cite/`, so the first element is the kind.
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

  img({ src, alt, node: _node, ...props }) {
    // Images render only from sources the app produced (`data:image/`, a page-minted `blob:`, or a
    // same-origin path). Anything external becomes an inert placeholder, so a prompt-injected image
    // URL cannot exfiltrate data.
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

  code({ className, children, node: _node, ...props }) {
    const text = String(children ?? '');
    const isBlock = Boolean(className?.startsWith('language-'));
    // Inline code that might be a structure (molecule or reaction, `mightBeStructure`) gets a
    // render affordance; fenced blocks are left alone.
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
 * URL sanitiser: react-markdown's default for links; for image `src`, also pass `data:image/` and
 * `blob:` (the `img` component still decides what renders).
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
  /** The values this turn's tools returned; empty (the default) disables figure marking. */
  figures?: readonly number[];
}): React.JSX.Element {
  // `[plugin, options]` tuples, so unified applies the options itself. Memoised so the answer is
  // not re-parsed on every parent render.
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
