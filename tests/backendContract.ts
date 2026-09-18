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
 * What a relative checkout path is relative to: the directory the suite was started in.
 *
 * One base, for the same reason there is one order below. The two cross-repository readers used
 * two — this one resolved against `process.cwd()` and the other against its own file's repository
 * root — and under every composer in `package.json` those are the same directory, which is exactly
 * why a disagreement between them would never have surfaced in a lane.
 *
 * `import.meta.url` is deliberately not used for it, and the mechanism is worse than the one this
 * paragraph used to state. Measured under the suite's default `happy-dom`: `import.meta.url` *is*
 * a `file:` URL — the thing that moves is the **derived** root, because Vite rewrites a static
 * `new URL(…, import.meta.url)` at transform time and hands back
 * `http://localhost:3000/@fs/…`. Nothing throws: `existsSync` is given an `http:` URL and returns
 * `false`, so a checkout that is there resolves as absent and the contract check skips itself with
 * a message naming a path nobody typed. A silent `false` is the harm, not a throw — and the rewrite
 * is per-environment, so an identical probe under `// @vitest-environment node` resolves correctly,
 * which is how this was believed to be fine.
 */
const relativeBase = (): string => process.cwd();

/**
 * The marker that proves a directory is a Chemclaw3 checkout *for this reader*.
 *
 * A directory that exists but holds no `src/chemclaw/api/events.py` is treated as absent rather
 * than as an empty contract — that is a wrong path, not a backend with no events. Every reader
 * passes the file it actually opens, because the Jenkins lane fetches a **sparse** checkout and a
 * marker one reader needs may legitimately not be the one another does.
 */
export const EVENTS_MARKER = join('src', 'chemclaw', 'api', 'events.py');

/**
 * The environment variables that say where the Chemclaw3 checkout is, in the order they win.
 *
 * `CHEMCLAW3_DIR` first, because that is what a lane sets — the Jenkins `Gate` stage exports it at
 * the `.jenkins-lib` clone `Preflight` makes. `CHEMCLAW_REPO` second, because that is what
 * `README.md` tells a developer to override with and what `docker-compose.yml` reads, and a
 * developer who takes the documented route was getting this check silently switched off: driven on
 * `0fca446`, with `CHEMCLAW_REPO` naming a real checkout and no sibling at the default path,
 * `tests/protocolStatusTransitions.test.ts` ran its 8 tests against the service while this reader
 * printed “backend contract NOT CHECKED” — one question, two answers, in one run.
 *
 * Exported because it is read back: `tests/delivery.test.ts` holds the documents that describe the
 * resolution to the names actually resolved, so adding a third variable here fails there until the
 * record says so.
 */
export const CHECKOUT_VARS = ['CHEMCLAW3_DIR', 'CHEMCLAW_REPO'] as const;

/**
 * Where this reader looks when nothing names a checkout, relative to `relativeBase()`.
 *
 * A constant rather than a literal inside `checkoutRoots` because it is read back: where the
 * resolution lands with nothing set is as much a part of "where is the checkout" as the two
 * variables are, and `tests/delivery.test.ts` holds the three documents that describe that
 * resolution to these names, their order, and this default — rather than to the variable names
 * occurring somewhere in a file.
 *
 * A default, and not a third candidate: `checkoutRoots` takes it *instead of* the configured
 * roots rather than after them, so a stale export naming a directory that has moved switches the
 * check off rather than quietly reading the sibling. Three documents described it as a
 * fall-through until 2026-09-18 and this check pinned them to saying so.
 */
export const DEFAULT_CHECKOUT = '../Chemclaw3';

/**
 * Every directory this suite will look in for a Chemclaw3 checkout, in order.
 *
 * Takes its environment as an argument so the resolution can be driven over environments built to
 * be wrong, rather than only over the one the run happens to have — the same reason every other
 * predicate in this suite takes its inputs.
 */
export function checkoutRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = relativeBase();
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
  const configured = CHECKOUT_VARS.map((name) => env[name]).filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return configured.length > 0 ? configured.map(absolute) : [resolve(base, DEFAULT_CHECKOUT)];
}

/**
 * The Chemclaw3 checkout holding `marker`, or `null`.
 *
 * One resolution for the whole suite. It used to be two — this function and a `??` chain in
 * `tests/protocolStatusTransitions.test.ts` reading a variable this one did not — which is the
 * defect a check of this shape dies of: not a wrong answer, a second answer, in the lane nobody
 * watches. `tests/delivery.test.ts` is what keeps it one, by refusing any other file in this suite
 * that reads a checkout-location variable of its own.
 *
 * "One" is per *marker*, though, and two variables can still split the suite between two
 * checkouts. The fallback is deliberate and is what makes the sparse Jenkins checkout usable — a
 * reader asking for the file it opens is what keeps "the checkout is there" from meaning "every
 * reader's file is there", asserted below in `backendContract.test.ts`. The cost of it, said here
 * because nothing else does: with both variables set, a marker the first checkout lacks resolves
 * to the second, so a stale `CHEMCLAW_REPO` export beside a sparse `CHEMCLAW3_DIR` reads one file
 * out of each — driven, the events marker answers the first and the protocols marker the second,
 * in one run. No lane sets both today; a developer with an old export in a shell is the case.
 */
export function backendCheckout(
  marker: string = EVENTS_MARKER,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const path of checkoutRoots(env)) {
    if (existsSync(join(path, marker))) return path;
  }
  return null;
}

/** Where this reader looked, for a skip message that can be acted on. */
export function backendSearchPath(
  marker: string = EVENTS_MARKER,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const named = CHECKOUT_VARS.filter((name) => (env[name] ?? '').trim() !== '');
  const where = checkoutRoots(env)
    .map((path) => join(path, marker))
    .join(', ');
  return named.length > 0
    ? `${named.map((name) => `${name}=${env[name] ?? ''}`).join(', ')} → ${where}`
    : `${where} (set ${CHECKOUT_VARS.join(' or ')} to point elsewhere)`;
}

/**
 * Whether a lane has declared that a missing checkout is a failure rather than a skip.
 *
 * Here for the same reason the resolution is: both cross-repository readers answer it, the Jenkins
 * `Gate` stage sets it once for both, and two copies of “is a skip allowed” is how one of them
 * ends up not asking.
 */
export function checkoutRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHEMCLAW3_REQUIRED === '1';
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
 * A route handler's parameter list and the text that follows it, or `null` when the handler is not
 * in the module the route names.
 *
 * `^\s*`, not `^`: `api/app.py` declares its one decorated handler inside `register()`, so an
 * anchored search misses the route that describes all the others.
 *
 * One definition of that, because there were two and they drifted. `returnAnnotationOf` was fixed
 * and `requestModelOf` was left with `^`, where the same bug is *invisible*: a handler this reader
 * cannot find and a handler that takes no body both answer `null`. Measured on the nested
 * `GET /openapi.json` handler, `returnAnnotationOf` gave `dict[str, Any]` while `requestModelOf`
 * gave `null` — handler not found, reading as "no body", which that route happens to be and would
 * have gone on reading as the day it grew one. Sharing the search is what makes the two answers
 * about the same handler: the all-routes assertion in `backendContract.test.ts` that every
 * registered route annotates its return now reds if this anchor loosens for either caller.
 */
function handlerSignature(
  root: string,
  route: BackendRoute,
): { params: string; after: string } | null {
  if (!route.handler) return null;
  const text = readPy(root, route.module);
  const at = text.search(new RegExp(`^\\s*(?:async )?def ${route.handler}\\(`, 'm'));
  if (at < 0) return null;
  const { text: params, end } = balanced(text, text.indexOf('(', at));
  return { params, after: text.slice(end + 1) };
}

/**
 * The request-body model of a route, or `null` when it takes no body.
 *
 * FastAPI decides that by annotation: a parameter typed as a `BaseModel` subclass is the JSON
 * body, and every handler in this service spells it `body: SomeIn`. Read from the handler rather
 * than from a hand-kept table, so a route that grows a body is covered the day it does.
 */
export function requestModelOf(root: string, route: BackendRoute): string | null {
  const signature = handlerSignature(root, route);
  if (signature === null) return null;
  return /\bbody\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(signature.params)?.[1] ?? null;
}

/**
 * The return annotation of a route's handler, verbatim, or `null` when there is none.
 *
 * Every route this service registers annotates its return, which is the half of the response
 * question `ISSUES.md` Issue 14 recorded as blocked on the backend owing a shape it does not —
 * measured against the checkout on 2026-09-18 and false, so an assertion holds it rather than a
 * sentence. `list[X]` unwraps to `X` because a page of a model is that model on the wire.
 *
 * `null` here means the handler could not be found or annotates nothing at all;
 * `responseModelOf` below is the narrower question, and returns `null` for `Response`, a
 * `dict[...]` and a union like `NoteView | Response` — a route whose body this reader cannot name,
 * where naming one anyway is how a check invents the pairing it then reports findings about.
 */
export function returnAnnotationOf(root: string, route: BackendRoute): string | null {
  const signature = handlerSignature(root, route);
  if (signature === null) return null;
  return /^\s*->\s*([^:\n]+):/.exec(signature.after)?.[1]?.trim() ?? null;
}

/** The one model a route returns, or `null` — see `returnAnnotationOf` for what is read. */
export function responseModelOf(root: string, route: BackendRoute): string | null {
  const annotation = returnAnnotationOf(root, route);
  if (annotation === null) return null;
  const single = /^list\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(annotation)?.[1] ?? annotation;
  return /^[A-Z][A-Za-z0-9_]*$/.test(single) ? single : null;
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
  /**
   * The type the enclosing API function declares it resolves to, with `Promise<>` and `[]`
   * stripped — or `null` when that is not one interface by name.
   *
   * `null` for `void`, for `{ session_id: string }` written inline, for a narrowed union like
   * `CheckIn[] | 'absent'`, and for a call inside a helper that declares nothing. Those are the
   * responses this client does **not** declare the wire shape of, and a checker that paired them
   * with the model anyway would be inventing the relationship it then reports on.
   */
  responseType: string | null;
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
            responseType: declaredResponseType(node, file),
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

/**
 * The response type the function around a call declares, as one interface name.
 *
 * Walks out to the nearest declaration with a return annotation, because the call is inside
 * `request<T>(...)`'s caller rather than in the API function's signature line. Everything that is
 * not a bare identifier after unwrapping `Promise<>` and `[]` is `null` rather than a guess —
 * see `ClientRequest.responseType` for which shapes those are and why it matters.
 */
function declaredResponseType(node: ts.Node, file: ts.SourceFile): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current)
    ) {
      const annotation = current.type?.getText(file);
      if (annotation === undefined) return null;
      const resolved = /^Promise<([\s\S]*)>$/.exec(annotation.trim())?.[1] ?? annotation;
      const single = resolved.trim().replace(/\[\]$/, '').trim();
      return /^[A-Z][A-Za-z0-9_]*$/.test(single) ? single : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * The property names of an interface this client declares, or `null` if it declares no such one.
 *
 * Only the files that build requests are searched, which is where every response interface in this
 * client is written today. A type imported from elsewhere reads as `null` — not compared rather
 * than compared against nothing, which is the same refusal `responseModelOf` makes upstream.
 */
export function clientInterfaceFields(name: string): string[] | null {
  for (const relative of REQUEST_SOURCES) {
    const file = parse(relative);
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
        found = node.members.flatMap((member) =>
          member.name && ts.isIdentifier(member.name) ? [member.name.text] : [],
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (found !== null) return found;
  }
  return null;
}
