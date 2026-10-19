/**
 * What the pinned core contract (`contracts/core-openapi.json`) says, held against this UI.
 *
 * The wire types are generated from that document, so most of what a hand-mirror's test used to
 * check is true by construction. What is left is what generation cannot see:
 *
 *  1. **The BFF whitelist and the requests this client makes against the routes the document
 *     declares.** A whitelist entry with no route is a dead button; a request the whitelist
 *     refuses is a 404 from this app's own proxy. A route the whitelist omits is usually a
 *     decision, so it is listed, except the three this UI must never forward.
 *  2. **Every event kind the document declares has a case in the reducer.** Enforced twice: the
 *     table below is `satisfies Record<TurnEventKind, …>`, so `tsc` fails when a kind is added; and
 *     a probe compiles `shared/events.ts` against a document that has gained a kind and requires the
 *     compile to fail, which proves the pattern still bites.
 *  3. **The closed sets this UI keeps a list of** (`EXHIBIT_KINDS`, `DESIGN_STATUSES`) against the
 *     document's enums, and the hand-validated artefact decoders against the document's fields.
 *  4. **The generated files are what the document produces now.**
 *
 * It does not check semantics (that `plan_hash` is the hash of the plan shown, that a 409 means
 * what this client says it means). It does not check that the document is core's: that is
 * `npm run contract:check`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTES } from '../server/routes.ts';
import { generate, loadPinned } from '../scripts/generate-api.mjs';
import { useChatStore } from '../src/state/chatStore.ts';
import type { AssistantMessage } from '../src/state/types.ts';
import { EVENT_TYPES, STATED_READINGS, normalizeEvent } from '../shared/events.ts';
import {
  decodeExhibitDiff,
  decodeExhibitList,
  decodeExhibitRevisions,
  decodeExhibitView,
  decodeMyExhibits,
  EXHIBIT_KINDS,
} from '../shared/exhibits.ts';
import { DESIGN_STATUSES } from '../shared/protocols.ts';
import { EVENT_MODELS, EVENT_SCHEMAS, GUESSED_FALLBACKS } from '../shared/generated/events.ts';
import type { TurnEventKind } from '../shared/generated/events.ts';
import { clientRequests, normalizeTemplate, whitelistTemplate } from './clientRequests.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- the document is data, read by shape */
type Schema = Record<string, any>;
const { document: doc } = loadPinned() as { document: Schema };
const schemas: Record<string, Schema> = doc.components.schemas;

/* ── 1. routes ───────────────────────────────────────────────────────────── */

const registered = new Set<string>(
  Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((verb) => ['get', 'put', 'post', 'delete', 'patch'].includes(verb))
      .map((verb) => `${verb.toUpperCase()} ${normalizeTemplate(path)}`),
  ),
);
const whitelist = ROUTES.map((route) => ({
  method: route.method,
  template: normalizeTemplate(whitelistTemplate(route.target)),
}));
const forwarded = (method: string, template: string): boolean =>
  whitelist.some((entry) => entry.method === method && entry.template === template);

describe('the routes the BFF forwards', () => {
  it('are all routes the document declares', () => {
    const dead = whitelist.filter((route) => !registered.has(`${route.method} ${route.template}`));
    expect(
      dead.map((r) => `${r.method} ${r.template}`),
      'whitelisted in server/routes.ts, declared nowhere in the pinned contract — each forwards to a 404',
    ).toEqual([]);
  });

  it('are a deliberate subset, and the rest are listed rather than assumed', () => {
    const unforwarded = [...registered].filter((route) => {
      const [method, template] = route.split(' ') as [string, string];
      return !forwarded(method, template);
    });
    console.log(
      `\n  ${unforwarded.length} contract route(s) the BFF does not forward:\n` +
        unforwarded.map((route) => `      ${route}`).join('\n'),
    );
    expect(unforwarded.length).toBeGreaterThan(0);
  });

  it('do not include the three this UI has no business reaching', () => {
    // Both directions: if one stops being a route, the comment in `server/routes.ts` naming it is
    // stale, which a one-directional assertion would let rot.
    for (const excluded of ['GET /metrics', 'GET /schedules', 'GET /openapi.json']) {
      expect(registered.has(excluded), `${excluded} is no longer in the contract`).toBe(true);
      const [method, template] = excluded.split(' ') as [string, string];
      expect(forwarded(method, template), `${excluded} is forwarded by the BFF`).toBe(false);
    }
  });
});

describe('the requests this client makes', () => {
  const requests = clientRequests();

  it('are found at all, which is the premise of the rest', () => {
    // The reader finds calls by shape; a refactor that spells them differently would empty it.
    expect(requests.length).toBeGreaterThan(40);
  });

  it('go to routes the document declares', () => {
    const unknown = requests
      .filter((request) => !registered.has(`${request.method} ${request.template}`))
      .map((request) => `${request.method} ${request.template} (${request.file}:${request.line})`);
    expect(unknown, 'requested here and declared nowhere in the pinned contract').toEqual([]);
  });

  it('go through routes the BFF forwards', () => {
    const blocked = requests
      .filter((request) => !forwarded(request.method, request.template))
      .map((request) => `${request.method} ${request.template} (${request.file}:${request.line})`);
    expect(
      blocked,
      'requested here and refused by the BFF whitelist — a 404 from its own proxy',
    ).toEqual([]);
  });

  it('are read from source the way a wrong one would be', () => {
    // The assertions above pass over a tree that agrees today; this shows the reader can see a
    // request that does not.
    const found = clientRequests({
      'src/api/client.ts':
        "request('/nope', t);\nrequest(`/sessions/${id}/members/${a}`, t, { method: 'PUT' });",
    });
    expect(found.map((r) => `${r.method} ${r.template}`)).toEqual([
      'GET /nope',
      'PUT /sessions/{}/members/{}',
    ]);
    expect(registered.has('GET /nope')).toBe(false);
  });
});

/* ── 2. events ───────────────────────────────────────────────────────────── */

const documentKinds = (): string[] =>
  (schemas.TurnEvent!.oneOf as { $ref: string }[]).map(
    (member) => schemas[member.$ref.split('/').pop()!]!.properties.type.const as string,
  );

/** A frame carrying only what the document requires, with a value of each field's type. */
function minimalFrame(model: string): Record<string, unknown> {
  const schema = schemas[model]!;
  const frame: Record<string, unknown> = { type: schema.properties.type.const };
  for (const name of (schema.required ?? []) as string[]) {
    const property = schema.properties[name] as Schema;
    frame[name] =
      property.enum?.[0] ??
      (property.type === 'integer' || property.type === 'number'
        ? 1
        : property.type === 'array'
          ? property.items?.type === 'string' && !property.items.enum
            ? ['x']
            : []
          : property.type === 'boolean'
            ? true
            : 'x');
  }
  return frame;
}

type Disposition = 'row' | 'message' | 'annotation' | 'other-consumer';

/**
 * How the turn reducer (`chatStore.applyEvent`) takes each kind. A `Record` over the generated kinds
 * with `satisfies`, so a kind the document gains is a type error here until it is decided.
 */
const DISPOSITION = {
  queued: 'message',
  plan: 'row',
  tool_call: 'row',
  token: 'message',
  job_started: 'row',
  tool_queued: 'annotation',
  job_completed: 'row',
  job_failed: 'row',
  awaiting_answer: 'other-consumer',
  capability_degraded: 'message',
  note_recorded: 'row',
  approval_request: 'row',
  question: 'row',
  answer: 'message',
  tool_failed: 'row',
  tool_result: 'annotation',
  evidence_source: 'row',
  handoff: 'row',
  exhibit: 'row',
  exhibit_draft: 'other-consumer',
  error: 'message',
} as const satisfies Record<TurnEventKind, Disposition>;

const assistant = (conversationId: string, messageId: string): AssistantMessage => {
  const message = useChatStore
    .getState()
    .conversations[conversationId]?.messages.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') throw new Error('no assistant message');
  return message;
};

describe('every event kind the pinned document declares', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, order: [], activeId: null, jobFeed: [] });
  });

  it('is the set the generated schemas and the reducer table cover', () => {
    expect(documentKinds().sort()).toEqual(Object.keys(EVENT_SCHEMAS).sort());
    expect(documentKinds().sort()).toEqual(Object.keys(DISPOSITION).sort());
    expect(Object.keys(EVENT_MODELS).sort()).toEqual(documentKinds().sort());
  });

  it('is admitted by the gate, and the only extra name is the pinned alias', () => {
    expect([...EVENT_TYPES].filter((name) => !documentKinds().includes(name))).toEqual([
      'note_proposed',
    ]);
  });

  it.each(documentKinds())(
    'survives normalizeEvent on a frame carrying only what is required: %s',
    (kind) => {
      const model = EVENT_MODELS[kind as TurnEventKind];
      const event = normalizeEvent(minimalFrame(model));
      expect(event, `${kind} is in the document and dropped by the UI`).not.toBeNull();
      expect(event?.type).toBe(kind);
    },
  );

  it.each(documentKinds())('has a case in the reducer: %s', (kind) => {
    const model = EVENT_MODELS[kind as TurnEventKind];
    const event = normalizeEvent(minimalFrame(model))!;
    const cid = useChatStore.getState().createConversation();
    const mid = useChatStore.getState().startAssistantMessage(cid);
    const store = () => useChatStore.getState();
    // An open call for the annotations to land on.
    if (DISPOSITION[kind as TurnEventKind] === 'annotation') {
      store().applyEvent(cid, mid, { type: 'tool_call', tool: 'x', arguments: '{}' });
    }
    const before = assistant(cid, mid);
    store().applyEvent(cid, mid, event);
    const after = assistant(cid, mid);

    switch (DISPOSITION[kind as TurnEventKind]) {
      case 'row':
        expect(after.trace.length, `${kind} adds no trace row`).toBe(before.trace.length + 1);
        break;
      case 'message':
        expect(after.trace.length, `${kind} is not a trace row`).toBe(before.trace.length);
        expect(after, `${kind} changed nothing`).not.toEqual(before);
        break;
      case 'annotation':
        expect(after.trace.length).toBe(before.trace.length);
        expect(after.trace, `${kind} annotated nothing`).not.toEqual(before.trace);
        break;
      case 'other-consumer':
        // Taken by `sendMessage` (drafts) or the job stream (`awaiting_answer`), never the
        // reducer: it must leave the message alone rather than throw or draw a row.
        expect(after).toEqual(before);
        break;
    }
  });

  it('includes capability_degraded, tool_failed and job_failed, which once reached production unread', () => {
    // ISSUES.md Issue 14, closed by construction: they are members of the generated union.
    for (const kind of ['capability_degraded', 'tool_failed', 'job_failed']) {
      expect(documentKinds()).toContain(kind);
      expect(DISPOSITION[kind as TurnEventKind]).not.toBe('other-consumer');
    }
  });
});

describe('a closed set the document leaves open is read by a stated fallback', () => {
  it('states a reading for every closed-set field whose fallback the document does not give', () => {
    const unstated = GUESSED_FALLBACKS.filter((field) => !STATED_READINGS.includes(field));
    expect(
      unstated,
      'the generator took the first member as the fallback for these; state one with `refine` in shared/events.ts',
    ).toEqual([]);
  });
});

describe('a contract that gains an event kind fails the typecheck until the UI has a case for it', () => {
  it('compiles with the pinned document and fails with one more kind', async () => {
    const pinned = loadPinned();
    const probed = structuredClone(pinned.document) as Schema;
    probed.components.schemas.ProbeEvent = {
      title: 'ProbeEvent',
      type: 'object',
      properties: {
        text: { type: 'string', title: 'Text' },
        type: { const: 'probe', default: 'probe', title: 'Type', type: 'string' },
      },
      required: ['text'],
    };
    probed.components.schemas.TurnEvent.oneOf.push({ $ref: '#/components/schemas/ProbeEvent' });
    probed.components.schemas.TurnEvent.discriminator.mapping.probe =
      '#/components/schemas/ProbeEvent';

    const scratch = mkdtempSync(join(process.cwd(), 'node_modules', '.pinned-probe-'));
    try {
      const diagnose = async (document: Schema): Promise<string[]> => {
        const out = await generate({ lock: pinned.lock, document });
        mkdirSync(join(scratch, 'shared', 'generated'), { recursive: true });
        for (const file of ['events.ts', 'eventCoercion.ts', 'wire.ts']) {
          writeFileSync(join(scratch, 'shared', file), readFileSync(join('shared', file)));
        }
        writeFileSync(
          join(scratch, 'shared', 'generated', 'events.ts'),
          out['shared/generated/events.ts']!,
        );
        writeFileSync(
          join(scratch, 'shared', 'generated', 'api.ts'),
          out['shared/generated/api.ts']!,
        );
        const program = ts.createProgram([join(scratch, 'shared', 'events.ts')], {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noUncheckedIndexedAccess: true,
          types: [],
        });
        return ts
          .getPreEmitDiagnostics(program)
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      };

      // The control: the harness compiles the real document cleanly, so a failure below is the
      // missing case and not an unrelated error.
      expect(await diagnose(pinned.document as Schema)).toEqual([]);
      const failures = await diagnose(probed);
      expect(failures.join('\n'), 'a new kind compiled without the UI deciding what it is').toMatch(
        /probe/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

/* ── 3. closed sets and decoders ─────────────────────────────────────────── */

describe('the lists this UI keeps match the document', () => {
  it('names the artefact kinds the document declares, in its order', () => {
    expect([...EXHIBIT_KINDS]).toEqual(schemas.ExhibitHeader!.properties.kind.enum);
  });

  it('names the design statuses the document declares', () => {
    expect([...DESIGN_STATUSES].sort()).toEqual(
      [...schemas.StatusIn!.properties.status.enum].sort(),
    );
  });
});

describe('the artefact decoders read every field the document declares, and no other', () => {
  const sample = (model: string): Record<string, unknown> => {
    const frame: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(
      schemas[model]!.properties as Record<string, Schema>,
    )) {
      frame[name] =
        name === 'spec' || name === 'raw_spec'
          ? { kind: 'document', markdown: '# x' }
          : (property.enum?.[0] ??
            (property.type === 'integer' || property.type === 'number'
              ? 1
              : property.type === 'array'
                ? []
                : property.type === 'boolean'
                  ? true
                  : 'x'));
    }
    return frame;
  };
  const fields = (model: string): string[] => Object.keys(schemas[model]!.properties).sort();

  it('ExhibitHeader', () => {
    const [header] = decodeMyExhibits({ exhibits: [sample('ExhibitHeader')] }).exhibits;
    expect(Object.keys(header!).sort()).toEqual(fields('ExhibitHeader'));
  });

  it('ExhibitView', () => {
    expect(Object.keys(decodeExhibitView(sample('ExhibitView'))).sort()).toEqual(
      fields('ExhibitView'),
    );
  });

  it('ExhibitRevision', () => {
    const [revision] = decodeExhibitRevisions({ revisions: [sample('ExhibitRevision')] }).revisions;
    expect(Object.keys(revision!).sort()).toEqual(fields('ExhibitRevision'));
  });

  it('ExhibitDiff', () => {
    const diff = decodeExhibitDiff({ ...sample('ExhibitDiff'), changes: [sample('FieldChange')] });
    expect(Object.keys(diff).sort()).toEqual(fields('ExhibitDiff'));
    expect(Object.keys(diff.changes[0]!).sort()).toEqual(fields('FieldChange'));
  });

  it('ExhibitListOut', () => {
    expect(Object.keys(decodeExhibitList(sample('ExhibitListOut'))).sort()).toEqual(
      fields('ExhibitListOut'),
    );
  });
});

/* ── 4. generated files ──────────────────────────────────────────────────── */

describe('the generated files are what the pinned document produces', () => {
  it('match byte for byte, so a stale file fails here and not only in the gate', async () => {
    const out = await generate();
    for (const [relative, text] of Object.entries(out)) {
      expect(
        readFileSync(relative, 'utf8') === text,
        `${relative} is stale: run npm run generate:api`,
      ).toBe(true);
    }
  }, 60_000);
});
