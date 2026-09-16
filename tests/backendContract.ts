/**
 * The backend contract, read off the backend — not off a mirror of it, and not off a live service.
 *
 * This file is the reader; `backendContract.test.ts` is what asserts with it. Everything here is a
 * parser over two trees: the Python in the `Chemclaw3` checkout, and the TypeScript in this one.
 *
 * ## Why parse rather than call
 *
 * `scripts/check-openapi.mjs` compares this repo's BFF whitelist to a *running* service, and it is
 * the right check with the wrong prerequisite: no pipeline here has a Chemclaw3 to point it at, so
 * in practice it has never run. Its own docstring records the cost — three events reached
 * production absent from `shared/events.ts`, each dropped in silence by `normalizeEvent`. A fourth
 * and fifth followed. Nothing mechanical connected the two repositories, and prose did not do it.
 *
 * The source is on disk in every environment that matters (a developer's machine, this agent's
 * sandbox, the full-stack compose lane), it needs no port, no database and no credential, and it
 * is the *declaration* rather than one deployment's rendering of it. So: read it.
 *
 * ## What it is allowed to conclude
 *
 * Only what it read. Where the sibling checkout is absent the test says so and checks nothing —
 * `CHEMCLAW3_REQUIRED=1` turns that into a failure for an environment that should have one. A
 * check that reports a pass it did not perform is the failure mode the whole exercise exists to
 * refuse.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import { EVENT_FIELDS, EVENT_TYPES, normalizeEvent } from '../shared/events.ts';

/* ------------------------------------------------------------------ the checkout */

/**
 * The Chemclaw3 checkout, or `null`.
 *
 * `CHEMCLAW3_DIR` first so a CI runner that checks the backend out somewhere else can say where;
 * `../Chemclaw3` otherwise, which is the layout `docker-compose.yml` already assumes for
 * `CHEMCLAW_REPO`. A directory that exists but holds no `src/chemclaw/api/events.py` is treated as
 * absent rather than as an empty contract — that is a wrong path, not a backend with no events.
 */
export function backendCheckout(): string | null {
  const configured = process.env.CHEMCLAW3_DIR;
  const candidates = configured
    ? [isAbsolute(configured) ? configured : resolve(process.cwd(), configured)]
    : [resolve(process.cwd(), '..', 'Chemclaw3')];
  for (const path of candidates) {
    if (existsSync(join(path, 'src', 'chemclaw', 'api', 'events.py'))) return path;
  }
  return null;
}

/** Where this reader looked, for a skip message that can be acted on. */
export function backendSearchPath(): string {
  const configured = process.env.CHEMCLAW3_DIR;
  return configured
    ? `CHEMCLAW3_DIR=${configured}`
    : `${resolve(process.cwd(), '..', 'Chemclaw3')} (set CHEMCLAW3_DIR to point elsewhere)`;
}

const readPy = (root: string, relative: string): string =>
  readFileSync(join(root, 'src', 'chemclaw', relative), 'utf8');

/** Every `.py` under `src/chemclaw/api/`, which is where every model this client touches lives. */
function apiSources(root: string): { path: string; text: string }[] {
  const base = join(root, 'src', 'chemclaw', 'api');
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__pycache__') walk(full);
      } else if (entry.endsWith('.py')) out.push({ path: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(base);
  return out;
}

/* ------------------------------------------------------------------ Python, read */

/**
 * The text inside the parentheses opening at `open`, and the index of the closing one.
 *
 * Quote-aware, because every argument list here contains a path string and several contain a
 * `Field(description="…(…)")`. Nesting-aware, because `dependencies=[Depends(resolve_session)]` is
 * how half the registrations are written and a naive `indexOf(')')` stops in the middle of one.
 */
function balanced(source: string, open: number): { text: string; end: number } {
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    // A `#` comment runs to the end of the line, and the comments inside these argument lists are
    // full of apostrophes (``loop_cap_reached``'s sibling) and of quoted prose. Skipping them is
    // not tidiness: one apostrophe read as an opening quote swallows the rest of the file, which
    // is exactly how this reader first failed on `ErrorCode`.
    if (ch === '#') {
      const newline = source.indexOf('\n', i);
      if (newline < 0) break;
      i = newline;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open + 1, i), end: i };
    }
  }
  throw new Error(`unbalanced parentheses at offset ${open}`);
}

/**
 * The lines of a class body, with docstrings and comments removed.
 *
 * Both removals are load-bearing rather than tidy: a field is recognised as `name: annotation` at
 * one indent level, and a docstring sentence ending in a colon ("Four refusals, each with its own
 * status:") or a commented-out field would otherwise be read as one. The parse is line-based
 * because a Pydantic model is, and because the alternative is an indentation-sensitive expression
 * parser for a shape that has never needed one.
 */
function classBody(source: string, className: string): string[] | null {
  const start = source.search(new RegExp(`^class ${className}\\(`, 'm'));
  if (start < 0) return null;
  const lines = source.slice(start).split('\n').slice(1);
  const body: string[] = [];
  let docquote = '';
  for (const line of lines) {
    if (/^\S/.test(line)) break; // dedent to column 0 ends the class
    const trimmed = line.trim();
    if (docquote) {
      if (trimmed.includes(docquote)) docquote = '';
      continue;
    }
    const opener = /^("""|''')/.exec(trimmed);
    if (opener) {
      const mark = opener[1] as string;
      // A one-line docstring opens and closes on the same line.
      if (trimmed.length < mark.length * 2 || !trimmed.slice(mark.length).includes(mark)) {
        docquote = mark;
      }
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    body.push(line);
  }
  return body;
}

export interface PydanticField {
  name: string;
  /**
   * Whether a caller must send it.
   *
   * No `=` at all is required; `= Field(...)` is required *unless* the call carries a `default=`
   * or a `default_factory=`, which is the distinction that decides whether a POST without the key
   * is a 422 or a fine. `parent_revision: int = Field(ge=1)` is required despite the `=`, and
   * reading it as optional would be this check passing over the exact shape it exists to catch.
   */
  required: boolean;
}

/**
 * The fields a Pydantic model declares, in order.
 *
 * Exactly four spaces of indent, so a continuation line inside a multi-line `Field(...)` is not
 * read as a second field; lowercase, so a stray capitalised word in prose the docstring stripper
 * missed cannot become one.
 */
export function pydanticFields(source: string, className: string): PydanticField[] | null {
  const body = classBody(source, className);
  if (body === null) return null;
  // Logical lines: a `Field(` argument list that wraps carries the `default=` that decides whether
  // the field is required, so reading only the first physical line would call an optional field
  // required — in the direction that invents a failure.
  const logical: string[] = [];
  for (const line of body) {
    if (/^ {5,}\S/.test(line) && logical.length > 0) {
      logical[logical.length - 1] = `${logical[logical.length - 1] as string} ${line.trim()}`;
    } else if (line.trim()) logical.push(line);
  }
  const fields: PydanticField[] = [];
  for (const line of logical) {
    const match = /^ {4}([a-z_][a-z0-9_]*)\s*:\s*(\S.*)$/.exec(line);
    if (!match || match[1] === 'model_config') continue;
    const rest = match[2] as string;
    const assigned = /=\s*(.*)$/.exec(rest)?.[1];
    const required =
      assigned === undefined ||
      (assigned.startsWith('Field(') && !/\bdefault(_factory)?\s*=/.test(assigned));
    fields.push({ name: match[1] as string, required });
  }
  return fields;
}

/** A model by name, searched across `api/` — the six request models live in two different files. */
export function modelFields(root: string, className: string): PydanticField[] | null {
  for (const { text } of apiSources(root)) {
    const fields = pydanticFields(text, className);
    if (fields !== null) return fields;
  }
  return null;
}

/** The members of a `Name = Literal["a", "b"]`, wherever it is declared. */
export function literalMembers(source: string, name: string): string[] | null {
  const at = source.search(new RegExp(`^${name}\\s*=\\s*Literal\\[`, 'm'));
  if (at < 0) return null;
  const open = source.indexOf('[', at);
  const { text } = balanced(source, open);
  // Comments first, and for a second reason: the prose in `ErrorCode`'s comments quotes what a
  // surface should say ("we are busy, retry in a moment"), which a bare scan for quoted strings
  // would enrol as members of the closed set.
  const members = text.replace(/#[^\n]*/g, '');
  return [...members.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
}

/* ------------------------------------------------------------------- the routes */

export interface BackendRoute {
  method: string;
  /** As the backend declares it: `/sessions/{session_id}/messages`. */
  template: string;
  /** The handler function, which is where the request body's model is declared. */
  handler: string;
  /** The module it was registered in, so a failure names a file somebody can open. */
  module: string;
}

/**
 * Every route the service registers, read off the registrations themselves.
 *
 * Two spellings, because the app uses both: `app.get("/jobs")(list_jobs)` in every `routes/`
 * module — deliberately, since `include_router` breaks the route-type walk its own tests do — and
 * `@app.get("/openapi.json")` as a decorator in `api/app.py`. Missing the second would be the
 * check quietly not covering the one route that describes all the others.
 */
export function backendRoutes(root: string): BackendRoute[] {
  const out: BackendRoute[] = [];
  const files = [
    ...readdirSync(join(root, 'src', 'chemclaw', 'api', 'routes'))
      .filter((f) => f.endsWith('.py'))
      .map((f) => `api/routes/${f}`),
    'api/app.py',
  ];
  for (const relative of files) {
    const text = readPy(root, relative);
    const pattern = /(@?)app\.(get|post|put|patch|delete)\(/g;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const open = m.index + m[0].length - 1;
      const { text: args, end } = balanced(text, open);
      const path = /^\s*["']([^"']+)["']/.exec(args)?.[1];
      if (path === undefined) continue;
      let handler: string | undefined;
      if (m[1] === '@') {
        handler = /(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text.slice(end))?.[1];
      } else {
        handler = /^\s*\(\s*\n?\s*([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*\n?\s*\)/.exec(
          text.slice(end + 1),
        )?.[1];
      }
      out.push({
        method: (m[2] as string).toUpperCase(),
        template: path,
        handler: handler ?? '',
        module: relative,
      });
    }
  }
  return out;
}

/**
 * The request-body model of a route, or `null` when it takes no body.
 *
 * FastAPI decides that by annotation: a parameter typed as a `BaseModel` subclass is the JSON
 * body, and every handler in this service spells it `body: SomeIn`. Read from the handler rather
 * than from a hand-kept table, so a route that grows a body is covered the day it does.
 */
export function requestModelOf(root: string, route: BackendRoute): string | null {
  if (!route.handler) return null;
  const text = readPy(root, route.module);
  const at = text.search(new RegExp(`^(?:async )?def ${route.handler}\\(`, 'm'));
  if (at < 0) return null;
  const { text: params } = balanced(text, text.indexOf('(', at));
  return /\bbody\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(params)?.[1] ?? null;
}

/* ------------------------------------------------------------------- the events */

export interface BackendEvent {
  /** The wire discriminator: what arrives as the SSE `event:` name and the JSON `type`. */
  wire: string;
  className: string;
  /** Every field on the model except `type`. */
  fields: string[];
}

/**
 * The turn-event union, read off `api/events.py`.
 *
 * Membership is the union expression rather than "every class in the file with a `type` literal":
 * `sse_frame` takes an `Event`, so a model that is not in the union is not on this wire, and a
 * check that diffed against every class would demand this client handle something nothing sends.
 */
export function backendEvents(root: string): BackendEvent[] {
  const text = readPy(root, 'api/events.py');
  const union = /^Event\s*=\s*\(([\s\S]*?)\)\s*$/m.exec(text);
  if (!union) throw new Error('api/events.py no longer declares `Event = (...)`');
  const members = [...(union[1] as string).matchAll(/([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (m) => m[1] as string,
  );
  return members.map((className) => {
    const fields = pydanticFields(text, className);
    if (fields === null) throw new Error(`${className} is in the union but not declared`);
    const body = (classBody(text, className) ?? []).join('\n');
    const wire = /^ {4}type\s*:\s*Literal\["([^"]+)"\]/m.exec(body)?.[1];
    if (wire === undefined) throw new Error(`${className} declares no \`type\` literal`);
    return { wire, className, fields: fields.map((f) => f.name).filter((f) => f !== 'type') };
  });
}

/* ---------------------------------------------------------------- one comparison */

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
 * its regex — which cannot be done — or by matching sample ids against it, which is what
 * `scripts/check-openapi.mjs` has to do against a live service and is where its one recorded false
 * finding came from (four live `/protocols/{design_id}` routes reported dead because no sample
 * satisfied the pattern). A route builds its own upstream path; asking it is exact, and an id
 * shape it has never seen cannot make it lie.
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

/* --------------------------------------------------------- this repo, read as well */

const readLocal = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), 'utf8');

const parse = (relative: string): ts.SourceFile =>
  ts.createSourceFile(relative, readLocal(relative), ts.ScriptTarget.ES2023, true);

/**
 * The wire names `normalizeEvent` admits, imported rather than scraped.
 *
 * Probing answers "does this name survive", which is the other direction and is what the test
 * does. This direction needs the *list*, and `shared/events.ts` derives `EVENT_TYPES` from the
 * schemas it decodes with — so the list is now the same object as the decoder and there is nothing
 * left to diff it against inside this repository.
 *
 * It used to be a regex over a `new Set<string>([…])` literal, with a comment-stripping pass in
 * front of it because one apostrophe in a `//` line inside that literal ("the emitter's switch")
 * opened a quote and enrolled four words of prose as members of the wire contract. Measured — that
 * is exactly what the first run of the tolerant-reader change reported. A parser for a list the
 * module can simply export was always the wrong shape; it existed because the list was written by
 * hand.
 */
export function clientEventTypes(): string[] {
  return [...EVENT_TYPES];
}

/**
 * Which fields `normalizeEvent` reads off the raw frame, per event type.
 *
 * A field read here and absent upstream is the renamed-field drift — the client goes on reading a
 * name nobody sends, the fallback fills in `''`, and the surface renders a confident blank. That
 * question is unchanged; what answers it is not.
 *
 * It used to be a compiler-API walk collecting every `o.<name>` inside each `case '<type>':`
 * clause of a 130-line switch, with a whole paragraph about fall-through — because the one place
 * that switch fell through was the two wire names of the note event, and reading an empty clause
 * as "reads nothing" had already reported both of that event's fields as ignored. There is no
 * switch. Each member is a `valibot` schema, the fields it reads are its own keys, and
 * `EVENT_FIELDS` is that list — so the walk is `EVENT_FIELDS`, the fall-through case is a one-line
 * alias map, and both of the ways this function could be subtly wrong are gone with the thing it
 * was reading.
 *
 * The alias is folded in here rather than exported separately: from the *backend's* point of view
 * `note_recorded` is a name this client admits and carries two fields under, which is what the
 * caller is diffing, and which is exactly what the fall-through paragraph above was reconstructing.
 */
export function normalizeEventReads(): Map<string, string[]> {
  const reads = new Map<string, string[]>([...EVENT_FIELDS].map(([type, f]) => [type, [...f]]));
  for (const name of EVENT_TYPES) {
    if (reads.has(name)) continue;
    // An alias: a second wire spelling of a member already listed. Probed rather than read off the
    // map in `shared/events.ts`, because what the caller needs is what a frame under this name
    // *becomes*, which is the same question the gate test asks.
    const parsed = normalizeEvent({ type: name });
    const fields = parsed && reads.get(parsed.type);
    if (fields) reads.set(name, fields);
  }
  return reads;
}

export interface ClientRequest {
  method: string;
  /** The path with every interpolation collapsed to `{}` and the query dropped. */
  template: string;
  /**
   * The keys of the JSON object this call sends, or `null` when there is no readable one — no
   * body at all, a `FormData`, a spread, a variable. `null` is deliberately not `[]`: reporting
   * "sends nothing" about a payload this reader could not see would be the check asserting
   * something it did not read.
   */
  bodyKeys: string[] | null;
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
      before === '/' ? '/{}' : before,
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
export function clientRequests(): ClientRequest[] {
  const out: ClientRequest[] = [];
  for (const relative of REQUEST_SOURCES) {
    const file = parse(relative);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const isOpen = node.expression.getText(file).endsWith('.open');
        const pathArg = isOpen ? node.arguments[1] : node.arguments[0];
        const template = pathArg ? pathTemplate(pathArg) : null;
        if (template !== null) {
          const options = node.arguments.find((arg): arg is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(arg),
          );
          const shape = options ? requestShape(options) : null;
          const verb = node.arguments[0];
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          out.push({
            method:
              isOpen && verb && ts.isStringLiteral(verb) ? verb.text : (shape?.method ?? 'GET'),
            template,
            bodyKeys: shape?.bodyKeys ?? null,
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

/** The `method` and the body keys of a request options object, including through a spread. */
function requestShape(
  options: ts.ObjectLiteralExpression,
): { method: string; bodyKeys: string[] | null } | null {
  let method = 'GET';
  let bodyKeys: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'method' && ts.isStringLiteral(node.initializer)) {
        method = node.initializer.text;
      }
      if (node.name.text === 'body') {
        const call = node.initializer;
        if (
          ts.isCallExpression(call) &&
          call.expression.getText() === 'JSON.stringify' &&
          call.arguments[0] &&
          ts.isObjectLiteralExpression(call.arguments[0]) &&
          // A spread inside the body means the keys are not all here to read. Treated as unknown
          // rather than as the ones that happen to be spelled out, which would be a check
          // reporting a pass over half a payload.
          call.arguments[0].properties.every((property) => !ts.isSpreadAssignment(property))
        ) {
          bodyKeys = call.arguments[0].properties.flatMap((property) =>
            property.name && ts.isIdentifier(property.name) ? [property.name.text] : [],
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(options);
  return { method, bodyKeys };
}
