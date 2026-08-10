/**
 * Answer rendering.
 *
 * NOTE: `rehype-raw` is deliberately NOT installed. react-markdown does not render raw HTML
 * unless you add it, so the correct sanitisation answer here is "do not enable the hazard" —
 * which also saves pulling in a sanitiser. Answer text is model output; letting it emit HTML
 * would be an XSS hole for no benefit. Please do not add `rehype-raw` to this component.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCitations } from '../lib/citations.ts';
import { looksLikeSmiles } from '../chem/recognise.ts';
import { CitationChip } from './CitationChip.tsx';
import { InlineSmiles } from './Molecule.tsx';

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

const components: Components = {
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),

  a({ href, children, ...props }) {
    if (href?.startsWith('#cite/')) {
      const [, kind = 'note', id = ''] = href.slice('#cite/'.length).split('/');
      return <CitationChip kind={kind} id={id} />;
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

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="prose-answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCitations]}
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
