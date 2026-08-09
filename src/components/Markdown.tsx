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
 * react-markdown ships a safe default, but a library default is not a guarantee this repo makes:
 * nothing pinned it, nothing configured it, and no test asserted it — so a `urlTransform={u => u}`
 * added later, or a move off react-markdown, would silently reopen `javascript:`.
 *
 * The first attempt at stating it here was **weaker than the default it replaced**, which is worth
 * recording. It matched the scheme with `/^([a-zA-Z][a-zA-Z0-9+.-]*):/`, requiring the characters
 * to be contiguous — so `java\tscript:alert(1)` matched nothing and was returned untouched. The URL
 * parser strips ASCII tab, LF and CR *before* reading the scheme, so that string is
 * `javascript:alert(1)` by the time it reaches the browser, and CommonMark decodes `&#9;` inside a
 * link destination, making it reachable from model output. The library's own check —
 * `indexOf(':')` with a prefix test — was never fooled by it.
 *
 * So: strip what the parser strips, then test the whole prefix before the first colon. A scheme
 * cannot contain `/`, `?` or `#`, so a colon appearing after one of those is part of a path, not a
 * scheme.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** Characters the URL parser removes anywhere in the input before parsing it. */
const URL_STRIPPED = /[\t\n\r]/g;

export function safeUrl(url: string): string | undefined {
  const cleaned = url.replace(URL_STRIPPED, '').trim();
  if (cleaned === '') return undefined;

  const colon = cleaned.indexOf(':');
  const slash = cleaned.indexOf('/');
  const question = cleaned.indexOf('?');
  const hash = cleaned.indexOf('#');

  // No colon, or a colon that falls inside the path/query/fragment: relative, and safe.
  const relative =
    colon === -1 ||
    (slash !== -1 && slash < colon) ||
    (question !== -1 && question < colon) ||
    (hash !== -1 && hash < colon);
  if (relative) return cleaned;

  return SAFE_SCHEMES.has(cleaned.slice(0, colon).toLowerCase()) ? cleaned : undefined;
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
