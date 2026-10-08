/**
 * The requests this client makes, read off its own source with the TypeScript compiler API.
 *
 * What `tests/pinnedContract.test.ts` compares with the pinned contract and the BFF whitelist:
 * every path this client requests must be a route the contract declares and one the whitelist
 * forwards. Bodies are not read here — each is `satisfies` its generated request model at the call
 * site, so `tsc` holds the keys and the required fields.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * A path template, in the one spelling both sides are compared in: `/sessions/{}/messages`.
 *
 * The backend names its parameters and this repo does not, so the name is exactly the part that
 * cannot be compared — `{session_id}` here and `{id}` there are the same route.
 */
export const normalizeTemplate = (path: string): string =>
  path.replace(/\{[^}]*\}/g, '{}').replace(/\?.*$/, '');

/**
 * The upstream path a whitelist entry produces, as a template.
 *
 * Derived by *calling* the entry's own `target` with placeholder groups rather than by inverting
 * its regex — which cannot be done — or by matching sample ids against it, which reports a live
 * route dead when no sample satisfies its pattern. A route builds its own upstream path; asking it
 * is exact, and an id shape it has never seen cannot make it lie.
 */
export function whitelistTemplate(target: (m: RegExpMatchArray) => string): string {
  const groups = Object.assign(
    Array.from({ length: 8 }, () => '{}'),
    {
      index: 0,
      input: '',
    },
  ) as unknown as RegExpMatchArray;
  return target(groups);
}

const parse = (relative: string, text: string): ts.SourceFile =>
  ts.createSourceFile(relative, text, ts.ScriptTarget.ES2023, true);

/**
 * Sources to read in place of the tree: `{ relative path: text }`.
 *
 * What lets the reader be driven over a file built to be wrong, which is the only way an assertion
 * over a tree that agrees today is shown to be able to disagree.
 */
export type SourceOverride = Readonly<Record<string, string>>;

export interface ClientRequest {
  method: string;
  /** The path with every interpolation collapsed to `{}` and the query dropped. */
  template: string;
  file: string;
  line: number;
}

/** The files that can build a request to the service. `src/lib/logger.ts` is deliberately out:
 *  it posts to `/api/client-events`, which is the BFF's own route and has no upstream at all. */
const REQUEST_SOURCES = [
  'src/api/client.ts',
  'src/api/streamTurn.ts',
  'src/hooks/useJobStreams.ts',
];

/**
 * A call's path argument as a template, or `null` if it is not a path this client sends.
 *
 * Three normalisations, each with a case behind it in this tree:
 *
 *  - a leading interpolation is the base URL (`fetch(`${config.apiBase}/sessions/…`)`), not a
 *    segment, so it goes;
 *  - an interpolation **not** preceded by `/` is a prebuilt query suffix (`/jobs${suffix}`,
 *    `/protocols/${id}${revision}`) rather than a segment — the same rule `pathEncoding.test.ts`
 *    uses to decide what must be encoded — so it goes too, with the query;
 *  - an interpolation preceded by `.` is a parameter *inside* a segment — the artefact export's
 *    `/export.${fmt}`, which the service registers as `export.{fmt}` — so it stays, as `.{}`. A
 *    query suffix is never written after a dot, so this cannot mistake one for the other;
 *  - a brace in the *literal* text means the string is a label rather than a path
 *    (`orEmpty('/sessions/{id}/messages', …)` names the route it degrades), because nothing here
 *    builds a path by writing a brace.
 */
function pathTemplate(node: ts.Expression): string | null {
  const HOLE = '\u0000';
  let text: string;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
  else if (ts.isTemplateExpression(node)) {
    text =
      node.head.text + node.templateSpans.map((span) => `${HOLE}${span.literal.text}`).join('');
  } else return null;
  if (text.replaceAll(HOLE, '').includes('{')) return null;
  const path = text
    .replace(/\?.*$/, '')
    .replace(new RegExp(`^${HOLE}`), '')
    .replace(new RegExp(`(.?)${HOLE}`, 'g'), (_m, before: string) =>
      before === '/' || before === '.' ? `${before}{}` : before,
    );
  return path.startsWith('/') ? path : null;
}

/**
 * Every request this client makes to the service.
 *
 * Found by shape — a call whose first argument is a path — rather than from a list of the API
 * functions that exist today, because a list is the thing that goes stale. `xhr.open(method, url)`
 * is the one call that puts its path second and its method first, and it is the attachment upload:
 * omitting it would leave the one route that carries a file outside the check.
 */
export function clientRequests(override?: SourceOverride): ClientRequest[] {
  const out: ClientRequest[] = [];
  for (const relative of override ? Object.keys(override) : REQUEST_SOURCES) {
    const file = parse(
      relative,
      override?.[relative] ?? readFileSync(resolve(process.cwd(), relative), 'utf8'),
    );
    const visit = (node: ts.Node): void => {
      // `orEmpty('/sessions', load)` names the route it degrades; the request is inside `load`.
      // Read as a call of its own, the label was a second `GET` whose declared type was whatever
      // the API function returned — the reshaped type, the one this reader no longer trusts.
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'orEmpty') {
        node.arguments.slice(1).forEach(visit);
        return;
      }
      if (ts.isCallExpression(node)) {
        const isOpen = node.expression.getText(file).endsWith('.open');
        const pathArg = isOpen ? node.arguments[1] : node.arguments[0];
        const template = pathArg ? pathTemplate(pathArg) : null;
        if (template !== null) {
          const options = node.arguments.find((arg): arg is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(arg),
          );
          const verb = node.arguments[0];
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          out.push({
            method:
              isOpen && verb && ts.isStringLiteral(verb)
                ? verb.text
                : options
                  ? requestMethod(options)
                  : 'GET',
            template,
            file: relative,
            line: line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return out;
}

/** The `method` of a request options object, `GET` when it names none. */
function requestMethod(options: ts.ObjectLiteralExpression): string {
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'method' &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return 'GET';
}
