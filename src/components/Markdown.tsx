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
import { remarkCitations, looksLikeSmiles } from '../lib/citations.ts';
import { CitationChip } from './CitationChip.tsx';
import { InlineSmiles } from './Molecule.tsx';

const components: Components = {
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
