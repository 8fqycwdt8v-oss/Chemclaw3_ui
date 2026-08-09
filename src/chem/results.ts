/**
 * Reaching one tool result whole — the seam over a backend contract that is not merged yet.
 *
 * **This module tracks an unmerged PR**: 8fqycwdt8v-oss/Chemclaw3 #157, branch
 * `claude/tool-result-surface`. Review can still rename `ToolResultEvent.result_ref`, move
 * `GET /sessions/{id}/tool-results/{ref}`, or reshape what it answers with. So the three things
 * that could move are named exactly once — here — and every card downstream renders from a
 * *parsed value* rather than from the transport that carried it. If the contract changes, this
 * file changes and the renderers do not.
 *
 * The one place the field name is unavoidably written twice is `shared/events.ts`, which is
 * imported by the esbuild-bundled mock backend and therefore kept dependency-free; its declaration
 * points back here.
 *
 * Two properties of the payload drive everything below.
 *
 * **`text` is text, not JSON.** The store's own docstring is explicit that it holds whatever the
 * framework handed back — "a store that promised JSON would have to fail or lie about the ones
 * that are not". A durable job that outlived its inline wait returns a bare workflow id; a
 * provider that stringified a model returns a Python repr. Both must reach the `<pre>` fallback
 * rather than throw, which is why parsing is a guarded function with a `null` return and not a
 * `JSON.parse` at a call site.
 *
 * **What a tool returns is often wrapped.** FastMCP wraps a non-model return in `{"result": …}`,
 * a durable job answering inside its turn returns the connector envelope `{summary, data}`, and
 * `data` for a calc job is an `XtbJobResult` carrying its one populated member beside a `kind` and
 * a `summary`. Rather than teach each renderer about three envelopes, `resultCandidates` hands
 * detection the chain of nodes from the outside in, and detection takes the first it recognises.
 */

/** The ref is a SHA-256 hex digest of the result's own text: 64 lowercase hex, nothing else. */
export const RESULT_REF_RE = /^[0-9a-f]{64}$/;

/**
 * Whether `ref` is worth spending a request on.
 *
 * Empty is the documented "not stored" — the store is off, the result was over the byte cap, or
 * the write failed — and a backend that predates the field sends nothing at all, which normalises
 * to the same empty string. Anything else that fails the digest shape is a frame we do not
 * understand, and guessing at it would spend a round trip to reach the fallback we can reach for
 * free.
 */
export const isFetchableRef = (ref: string | undefined): ref is string =>
  typeof ref === 'string' && RESULT_REF_RE.test(ref);

/** Where the BFF forwards a tool-result read. Mirrored by `RESULT_REF` in `server/routes.ts`. */
export const toolResultPath = (sessionId: string, ref: string): string =>
  `/sessions/${sessionId}/tool-results/${ref}`;

/**
 * What the fetch route answers with (`api.tool_results.StoredToolResult`).
 *
 * `correlation_id` is the join to the audit trail of the turn that produced the result — the one
 * thing a ref alone cannot give a GxP reviewer. `byte_size` is the stored length, which is not the
 * same as `text.length` once multi-byte characters are involved, and is the field that says how
 * much was kept.
 */
export interface StoredToolResult {
  ref: string;
  tool: string;
  correlation_id: string;
  byte_size: number;
  text: string;
}

/** The result text off a fetched payload, or `null` if the response was not the shape above. */
export function storedText(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const text = (raw as Record<string, unknown>).text;
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * The result text decoded, or `null` when it is not a JSON document.
 *
 * `null` is a real answer and not an error: plenty of tools return prose, and a caller's correct
 * response is the same either way — show what came back rather than invent a structure for it.
 */
export function parseResultText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** How many envelopes deep we are willing to look. Three are known; the fourth is a stop. */
const MAX_UNWRAP = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One envelope peeled off `node`, or `null` when it is not one we know.
 *
 * Each case is a shape a real producer emits, and each is recognised by structure rather than by
 * the tool that produced it:
 *
 *  - `{result: …}` — FastMCP wraps any return that is not itself a model (`func_metadata`'s
 *    `wrap_output`), so `resolve_compound`'s `ResolvedCompound | None` arrives this way and
 *    `screen_hazards`' `ScreenResult` does not.
 *  - `{summary, data}` — `ConnectorJobResult`, what a durable job returns when it finishes inside
 *    its inline wait. `data` is the job's own structured result, opaque to the core that carried
 *    it.
 *  - `{kind, summary, <one member>}` — `XtbJobResult`, which is optional fields rather than a
 *    union because its members share no discriminating field, and is dumped with `exclude_none`
 *    so exactly one survives.
 */
function unwrapOnce(node: unknown): unknown {
  if (!isRecord(node)) return null;
  const keys = Object.keys(node);

  if (keys.length === 1 && keys[0] === 'result') return node.result;

  if (typeof node.summary === 'string' && isRecord(node.data)) return node.data;

  if (typeof node.kind === 'string' && typeof node.summary === 'string') {
    const members = keys.filter((key) => key !== 'kind' && key !== 'summary');
    const only = members.length === 1 ? members[0] : undefined;
    if (only !== undefined && isRecord(node[only])) return node[only];
  }

  return null;
}

/**
 * `value` and everything inside its envelopes, outermost first.
 *
 * Outermost first because the envelope is sometimes the interesting thing: a shape detector that
 * recognises the outer node should win over one that recognises a member of it, and the ordering
 * is what says so without either detector having to know the other exists.
 */
export function resultCandidates(value: unknown): unknown[] {
  const chain: unknown[] = [value];
  let node = value;
  for (let depth = 0; depth < MAX_UNWRAP; depth += 1) {
    const inner = unwrapOnce(node);
    if (inner === null || inner === undefined) break;
    chain.push(inner);
    node = inner;
  }
  return chain;
}
