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

/**
 * URL schemes a link or image in model output may use.
 *
 * react-markdown applies a safe default already, but a library default is not a guarantee this
 * repo makes: nothing pinned it, nothing configured it, and no test asserted it — so a single
 * `urlTransform={(u) => u}` added later, or a move off react-markdown, would silently reopen
 * `javascript:` and `data:text/html` on text the model writes. Stating it here makes it ours, and
 * `tests/markdown.test.tsx` holds it.
 *
 * `#cite/` fragments are handled before this runs (they become chips), and ordinary relative
 * links have no scheme at all, so both pass the `no scheme` branch.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('.')) return trimmed;
  // A bare `foo/bar` is relative and safe; anything with a scheme must name one we allow.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!match) return trimmed;
  return SAFE_SCHEMES.has(match[1]!.toLowerCase() + ':') ? trimmed : '';
}

/** Hoisted: a new array per render defeats react-markdown's own memoisation of the pipeline. */
const REMARK_PLUGINS = [remarkGfm, remarkCitations];

const components: Components = {
  a({ href, children, ...props }) {
    if (href?.startsWith('#cite/')) {
      const [, kind = 'note', id = ''] = href.slice('#cite/'.length).split('/');
      return <CitationChip kind={kind} id={id} />;
    }
    // `{...props}` FIRST, so target/rel cannot be overridden by anything the AST carries. It used
    // to come last, which meant an incoming `target`/`rel` would win over the hardening. That is
    // unreachable while rehype-raw stays uninstalled — but it is the exact line that would matter
    // if it ever were, and the ordering costs nothing.
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
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
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        urlTransform={safeUrl}
        // Belt and braces alongside not enabling rehype-raw.
        disallowedElements={['script', 'iframe', 'style', 'object', 'embed', 'form']}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
