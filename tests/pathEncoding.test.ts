/**
 * Every path segment this app interpolates into a service URL is encoded.
 *
 * As an invariant over the tree, not as a list of the call sites that happen to exist today. The
 * defect that prompted it was one `xhr.open('POST', `${config.apiBase}/sessions/${sessionId}/…`)`
 * with no `encodeURIComponent` — and the reason a pin on that line would have been the wrong fix
 * is what the first run of this test found: there were **seven** such segments across six call
 * sites, not one. An invariant with six exceptions is not an invariant, and nobody reading the
 * eleven encoded sites could have told which rule was in force.
 *
 * ## Why it matters even though the ids are server-minted
 *
 * `server/routes.ts` matches a session id as exactly 32 lowercase hex and a result ref as 64, so
 * `encodeURIComponent` is the identity on every legitimate value and this changes no request the
 * app makes today. What it changes is the failure mode of an illegitimate one: an id carrying a
 * `/` or a `?` — from a corrupted persisted store, a hand-edited deep link, a future id shape the
 * service mints differently — currently *reshapes the path* and is forwarded as some other route
 * or dropped, and encoded it is simply refused by the whitelist. The value of the rule is that it
 * holds without anyone having to know which ids are safe.
 *
 * ## What counts as a path segment
 *
 * An interpolation whose immediately preceding literal text ends with `/`, with no `?` anywhere
 * before it in the template. That admits `/sessions/${id}/messages` and excludes the three shapes
 * this codebase legitimately uses raw: a prebuilt query suffix (`/jobs${suffix}`), a query value
 * (`?hops=${…}` — encoded anyway, but for a different reason), and a prebuilt path
 * (`${config.apiBase}${path}`, whose own callers are scanned).
 *
 * ## A named constant is followed to its value
 *
 * `const PROBE_BASE = '/api/jobs/'; fetch(PROBE_BASE + jobId)` is the same URL as
 * ``fetch(`/api/jobs/${jobId}`)`` and used to pass while the other failed (`ISSUES.md` Issue 15,
 * driven on 2026-09-14). The scan now resolves an identifier to the string it is bound to — a
 * `const` in the same file, or one imported by a relative path from another file under `src/` —
 * wherever it previously read only a literal: the left side of a `+`, a template span, and the
 * URL's head. What it still cannot follow is a value that is not a compile-time string (a `let`,
 * a parameter, a property such as `config.apiBase`), and it does not need to: those are exactly the
 * prefixes whose *own* literal tail (`/sessions/`) it already reads.
 *
 * ## Scope
 *
 * Files under `src/api/`, plus any file under `src/` that mentions `apiBase` — so a twelfth call
 * site added in a hook or a component is in scope the moment it names the service's base URL,
 * which it must in order to reach the service at all. `src/hooks/useJobStreams.ts` is in this set
 * for exactly that reason, and was one of the six.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../src/api/client.ts';
import { stubFetch } from './helpers.ts';

// A filesystem path rather than a `new URL(…, import.meta.url)`, which is what every other
// file-reading test here uses: those all declare `@vitest-environment node`, and this one cannot,
// because the two behavioural tests at the bottom need a DOM. Under happy-dom `import.meta.url` is
// an `http:` URL and `readdirSync` refuses it.
const SRC = resolve(process.cwd(), 'src');

function sources(dir = '', out: string[] = []): string[] {
  for (const entry of readdirSync(join(SRC, dir))) {
    const path = `${dir}${entry}`;
    if (statSync(join(SRC, path)).isDirectory()) sources(`${path}/`, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

/**
 * Files that can build a URL against the service **by naming its base**.
 *
 * Necessary and not sufficient, which is the escape this predicate had on its own: `src/env.ts`
 * makes `/api` the *default* value of `apiBase`, so a same-origin absolute literal reaches the BFF
 * without the file ever mentioning `apiBase`. Measured — a new
 * `fetch(\`/api/jobs/${jobId}/artifacts\`)` in a hook passed. So the file-level scope below is
 * joined by a *segment*-level one: a template or concatenation whose leading literal begins with
 * `/api/` is a service URL wherever it is written.
 */
const inScope = sources().filter(
  (path) => path.startsWith('api/') || read(path).includes('apiBase'),
);
const inScopeFiles = new Set(inScope);

/** The prefix that makes a URL this app's service URL regardless of which file wrote it. */
const SAME_ORIGIN_SERVICE = '/api/';

interface Segment {
  file: string;
  line: number;
  text: string;
  encoded: boolean;
  /** True when this segment is a service URL's — either by its file or by its own `/api/` head. */
  service: boolean;
}

/**
 * Every path-segment interpolation in one file.
 *
 * The TypeScript parser rather than a regex: `encodeURIComponent(a ? b : c)` and a nested template
 * both defeat text matching, and the point of the rule is that it cannot be satisfied by looking
 * right.
 *
 * **Two shapes, because a rule about template literals is a rule about template literals.**
 * `segments()` visited only `ts.isTemplateExpression`, so — measured, and ESLint-clean, since
 * neither `prefer-template` nor `restrict-plus-operands` is configured here —
 * `request('/jobs/' + jobId + '/artifacts', …)` passed the whole rule. A `+` chain whose left side
 * is a string literal ending in `/` is the same construct written the other way, and is scanned
 * the same way.
 */
function segments(file: string): Segment[] {
  return segmentsOf(file, read(file), readIfPresent);
}

const readIfPresent = (path: string): string | null => {
  try {
    return read(path);
  } catch {
    return null;
  }
};

/**
 * `segments`, over text rather than a file on disk, so the rule's own boundary can be driven with
 * fixtures — the named-constant escape was found by editing a real hook and reverting it, which is
 * a measurement nobody can repeat. `readOther` is how an imported constant's module is reached.
 */
function segmentsOf(
  file: string,
  text: string,
  readOther: (path: string) => string | null,
): Segment[] {
  const source = parse(file, text);
  const found: Segment[] = [];
  const { valueOf } = constantResolver(file, source, readOther);

  /**
   * Names bound to an `encodeURIComponent(…)` call in this file.
   *
   * Hoisting the encode one line — `const segment = encodeURIComponent(jobId)` — is correct code,
   * and the scan used to flag it with a message naming `encodeURIComponent`, so the shortest route
   * to green was to wrap it a second time. Double-encoding is silent and wrong: `a%2Fb` becomes
   * `a%252Fb`, which reaches the service as a different id. A rule whose cheapest fix is a defect
   * is a rule that manufactures defects.
   */
  const encodedNames = new Set<string>();
  const collectEncodedNames = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isEncodeCall(node.initializer)
    ) {
      encodedNames.add(node.name.text);
    }
    ts.forEachChild(node, collectEncodedNames);
  };
  collectEncodedNames(source);

  const isEncoded = (expression: ts.Expression): boolean =>
    isEncodeCall(expression) || (ts.isIdentifier(expression) && encodedNames.has(expression.text));

  const record = (
    expression: ts.Expression,
    before: string,
    service: boolean,
    text: string,
  ): void => {
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1,
      text,
      encoded: isEncoded(expression),
      service: service || before.startsWith(SAME_ORIGIN_SERVICE),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      // The text since the last value the scan could not resolve. A span bound to a constant —
      // `${PROBE_BASE}${jobId}` — is text like any literal, so it extends `before` rather than
      // resetting it; anything else (`config.apiBase`, an id) resets it to the literal after it.
      let before = node.head.text;
      // The URL's head: the leading text, extended through leading spans that resolve.
      let head: string | null = before;
      let seenQuery = before.includes('?');
      for (const span of node.templateSpans) {
        const isSegment = !seenQuery && /^[^\s?]*\/$/.test(before);
        if (isSegment) {
          record(
            span.expression,
            before,
            head !== null && head.startsWith(SAME_ORIGIN_SERVICE),
            `${before}\${${span.expression.getText(source)}}`,
          );
        }
        const value = valueOf(span.expression);
        before = value === null ? span.literal.text : `${before}${value}${span.literal.text}`;
        if (head !== null) head = value === null ? null : `${head}${value}${span.literal.text}`;
        seenQuery ||= before.includes('?');
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const before = literalEnding(node.left, valueOf);
      if (before !== null && /^[^\s?]*\/$/.test(before)) {
        const head = chainHead(node, valueOf);
        record(
          node.right,
          before,
          head !== null && head.startsWith(SAME_ORIGIN_SERVICE),
          `${before}' + ${node.right.getText(source)}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** `encodeURIComponent(x)`, the only call this rule accepts. */
function isEncodeCall(expression: ts.Expression): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'encodeURIComponent'
  );
}

/** What a compile-time string expression evaluates to, or `null` if it is not one. */
type Resolve = (expression: ts.Expression) => string | null;

/** The string a `+` chain's left side ends with — a literal, or a constant bound to one. */
function literalEnding(expression: ts.Expression, valueOf: Resolve): string | null {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return literalEnding(expression.right, valueOf);
  }
  return valueOf(expression);
}

/** The leftmost string of a `+` chain — the URL's head, when there is one. */
function chainHead(expression: ts.Expression, valueOf: Resolve): string | null {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return chainHead(expression.left, valueOf);
  }
  return valueOf(expression);
}

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

/**
 * A resolver for the compile-time strings one file can name: literals, `const` bindings to them
 * in the file, concatenations and substitution-free templates of those, and constants imported by
 * a relative path from another file under `src/` (followed through that file's own bindings).
 *
 * **Why follow the binding rather than inline the one constant that escaped.** Inlining fixes the
 * call site that was measured and leaves the shape open — the next hook that hoists its base into
 * a constant, which is ordinary tidy code, walks past the rule the same way. Resolving a `const`
 * to its value is not the dataflow analysis the escape was once declined for: a `const` bound to a
 * string has exactly one value, visible at its declaration, so there is nothing to flow. Scoping is
 * ignored (a name is looked up file-wide); a shadowed name can only make the scan see a segment
 * that is not there, which fails toward catching.
 */
function constantResolver(
  file: string,
  source: ts.SourceFile,
  readOther: (path: string) => string | null,
  depth = 0,
): { valueOf: Resolve; valueOfName: (name: string) => string | null } {
  const bindings = new Map<string, ts.Expression>();
  const imports = new Map<string, { from: string; name: string }>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('.') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        imports.set(element.name.text, {
          from: node.moduleSpecifier.text,
          name: (element.propertyName ?? element.name).text,
        });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const others = new Map<string, ((name: string) => string | null) | null>();
  const resolving = new Set<string>();

  const valueOf: Resolve = (expression) => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return valueOf(expression.expression);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = valueOf(expression.left);
      const right = left === null ? null : valueOf(expression.right);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isTemplateExpression(expression)) {
      let text = expression.head.text;
      for (const span of expression.templateSpans) {
        const value = valueOf(span.expression);
        if (value === null) return null;
        text += value + span.literal.text;
      }
      return text;
    }
    return ts.isIdentifier(expression) ? valueOfName(expression.text) : null;
  };

  const valueOfName = (name: string): string | null => {
    // A cycle is not a string; a guard rather than a stack overflow.
    if (resolving.has(name)) return null;
    const bound = bindings.get(name);
    if (bound) {
      resolving.add(name);
      try {
        return valueOf(bound);
      } finally {
        resolving.delete(name);
      }
    }
    const imported = imports.get(name);
    if (imported && depth < 4) return importedValue(imported.from, imported.name);
    return null;
  };

  const importedValue = (specifier: string, name: string): string | null => {
    if (!others.has(specifier)) {
      let found: ((name: string) => string | null) | null = null;
      for (const target of moduleCandidates(file, specifier)) {
        const text = readOther(target);
        if (text === null) continue;
        found = constantResolver(target, parse(target, text), readOther, depth + 1).valueOfName;
        break;
      }
      others.set(specifier, found);
    }
    return others.get(specifier)?.(name) ?? null;
  };

  return { valueOf, valueOfName };
}

/**
 * The `src/`-relative files a relative import may name, in the order to try them: the spelling as
 * written, then the two extensions this tree uses, because both `./x.ts` and `./x` are in use.
 */
function moduleCandidates(from: string, specifier: string): string[] {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (parts.length === 0) return [];
      parts.pop();
    } else parts.push(part);
  }
  const base = parts.join('/');
  return /\.tsx?$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`];
}

/**
 * Every path segment this rule covers.
 *
 * Scanned over **all** of `src/`, then narrowed: in a file that names the service's base, every
 * path segment counts; in any other file, only one whose URL starts with `/api/`. The second half
 * is what makes the rule hold for a call site written without `apiBase` at all.
 */
const all = sources()
  .flatMap(segments)
  .filter((segment) => inScopeFiles.has(segment.file) || segment.service);

describe('service URL path segments', () => {
  it('finds path segments to check at all', () => {
    // A scanner that silently matches nothing passes for ever. These are the numbers the rule is
    // about, so they are asserted as lower bounds rather than written into prose.
    expect(inScope.length).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  it('encodes every one of them', () => {
    const raw = all.filter((segment) => !segment.encoded);
    expect(
      raw.map((segment) => `src/${segment.file}:${segment.line}  ${segment.text}`),
      'an interpolated path segment must reach the service encoded: wrap it in encodeURIComponent, ' +
        'or bind it to a name that already is (`const id = encodeURIComponent(raw)`). Do not wrap ' +
        'a value that is already encoded — see this file’s docstring',
    ).toEqual([]);
  });
});

/**
 * The rule's boundary, driven with fixtures rather than described in prose.
 *
 * Each case is a hook that reaches the service; the scan is run over its text exactly as it is run
 * over `src/`. The first is the escape `ISSUES.md` Issue 15 recorded — `PROBE_BASE` in
 * `src/hooks/useOffline.ts`, driven on 2026-09-14 by editing the real file — which passed the whole
 * rule while the same URL written as a template failed it.
 */
describe('a path assembled off a named constant', () => {
  const raw = (text: string, others: Record<string, string> = {}): string[] =>
    segmentsOf('hooks/useFixture.ts', text, (path) => others[path] ?? null)
      .filter((segment) => segment.service && !segment.encoded)
      .map((segment) => segment.text);

  it('is seen through a `+`, as the literal it is bound to', () => {
    const text = `const PROBE_BASE = '/api/jobs/';
      export const probe = (jobId: string) => fetch(PROBE_BASE + jobId);`;
    expect(raw(text)).toEqual(["/api/jobs/' + jobId"]);
  });

  it('is seen through a template span', () => {
    const text = `const PROBE_BASE = '/api/jobs/';
      export const probe = (jobId: string) => fetch(\`\${PROBE_BASE}\${jobId}/artifacts\`);`;
    expect(raw(text)).toEqual(['/api/jobs/${jobId}']);
  });

  it('is seen through a constant built from constants, and through `as const`', () => {
    const text = `const API = '/api' as const;
      const JOBS = API + '/jobs/';
      export const probe = (jobId: string) => fetch(JOBS + jobId);`;
    expect(raw(text)).toEqual(["/api/jobs/' + jobId"]);
  });

  it('is seen through a relative import from another module', () => {
    const text = `import { JOBS_BASE as BASE } from '../api/paths';
      export const probe = (jobId: string) => fetch(BASE + jobId);`;
    expect(raw(text, { 'api/paths.ts': "export const JOBS_BASE = '/api/jobs/';" })).toEqual([
      "/api/jobs/' + jobId",
    ]);
  });

  it('passes once the segment is encoded, and does not ask for a second encode', () => {
    const text = `const PROBE_BASE = '/api/jobs/';
      export const a = (jobId: string) => fetch(PROBE_BASE + encodeURIComponent(jobId));
      export const b = (jobId: string) => {
        const id = encodeURIComponent(jobId);
        return fetch(\`\${PROBE_BASE}\${id}\`);
      };`;
    expect(raw(text)).toEqual([]);
  });

  it('still does not treat a prebuilt query suffix as a path segment', () => {
    // The shapes the docstring says are legitimately raw must stay raw through a constant too.
    const text = `const JOBS = '/api/jobs';
      export const list = (suffix: string) => fetch(JOBS + suffix);
      const Q = '/api/search?q=';
      export const search = (term: string) => fetch(Q + term);`;
    expect(raw(text)).toEqual([]);
  });
});

/**
 * The rule, driven rather than read.
 *
 * The scan above is a fact about the source; these two are facts about the request that leaves.
 * They exist because the two seams differ in a way source text hides: everything else in this
 * client goes through `fetch`, and `uploadAttachment` goes through `XMLHttpRequest` — which is
 * exactly why the upload site was the one that got missed. A `/` in the id is the interesting
 * input: raw, it silently *reshapes* the path into some other route; encoded, `server/routes.ts`
 * refuses it.
 */
describe('the two seams, driven', () => {
  /** A session id nothing would mint, carrying the two characters that change a path's shape. */
  const HOSTILE = 'a/b?c';

  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('encodes the session id on the fetch seam', async () => {
    const stub = stubFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    restore = stub.restore;

    await api.getMessages(HOSTILE, async () => null);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/sessions/a%2Fb%3Fc/messages');
  });

  it('encodes the session id on the XHR upload seam', async () => {
    const opened: { method: string; url: string }[] = [];

    class FakeXhr {
      upload = { onprogress: null as unknown };
      status = 200;
      response = { attachment_id: 'att-1' };
      responseType = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(method: string, url: string): void {
        opened.push({ method, url });
      }
      setRequestHeader(): void {}
      getResponseHeader(): string | null {
        return null;
      }
      send(): void {
        queueMicrotask(() => this.onload?.());
      }
      abort(): void {}
    }

    const original = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    restore = () => {
      globalThis.XMLHttpRequest = original;
    };

    await api.uploadAttachment(HOSTILE, new File(['x'], 'x.txt'), async () => null);

    expect(opened).toEqual([{ method: 'POST', url: '/api/sessions/a%2Fb%3Fc/attachments' }]);
  });
});
