/**
 * A stand-in for the Chemclaw3 FastAPI service, for browser tests.
 *
 * The point of this rather than `page.route`: it emits SSE frames with real gaps between them, so
 * the test can assert that text reaches the browser *while* the turn runs. Fulfilling a request in
 * the page hands the whole body over at once and would pass even if every hop in the chain were
 * buffering — which is the failure this project cares most about, and the one `scripts/smoke.mjs`
 * exists to catch against a real service.
 *
 * Requests still travel through the real BFF, so the proxy's identity encoding, header flush and
 * disconnect propagation are all exercised.
 *
 * **TypeScript, not `.mjs`, and that is the whole reason this file was renamed.** This is the only
 * fixture the entire browser tier ever sees, and it used to sit outside the type system with
 * nothing checking it against a declaration — while `tests/eventContract.test.ts` parsed
 * `shared/events.ts` with the compiler API to police exactly this for the unit fixture. It had
 * already drifted once: its own comment records that it answered `{sessions: []}` where the
 * service returns a bare array, so every browser test quietly ran the sidebar's degraded branch.
 * Typing every frame as `ChemclawEvent` and every JSON body by its `src/api/client.ts` interface
 * makes `tsc -b` — already a CI step — the checker. It runs under Node's type stripping, the same
 * path `scripts/check-openapi.mjs` uses; every import here is `import type` and therefore erased,
 * so nothing application-side is loaded at runtime.
 *
 *   node --experimental-strip-types e2e/fixture-service.ts [port]
 */

import { createServer, type ServerResponse } from 'node:http';
import type { ChemclawEvent } from '../shared/events.ts';
import type {
  CheckIn,
  Digest,
  DurableJobStatus,
  JobRecordSummary,
  NoteView,
  PendingPlans,
  PlanStatusOut,
  ProtocolView,
  RevisionWritten,
  SessionMembersOut,
  SessionSummary,
  SharedSessionSummary,
  StoredToolResult,
  TranscriptMessage,
} from '../src/api/client.ts';
import type {
  DesignDiff,
  DesignRevision,
  DesignSummary,
  ProtocolReceipt,
} from '../shared/protocols.ts';
import type {
  ExhibitDiff,
  ExhibitHeader,
  ExhibitListOut,
  ExhibitRevision,
  ExhibitView,
  TableSpec,
} from '../shared/exhibits.ts';

const port = Number(process.argv[2] ?? 4322);
const SID = 'a'.repeat(32);
/** A session a shared link can point at, with a transcript behind it. */
const SHARED_SID = 'b'.repeat(32);
/** The content address of the stored hazard screen below — 64 hex chars, as the service mints. */
const RESULT_REF = 'c'.repeat(64);
/** A second stored result, of a different SHAPE — which is what the renderer registry dispatches
 *  on, so one payload per shape is what stops a renderer shipping green and broken. */
const VALUES_REF = 'd'.repeat(64);
/** A third, because the protocol receipt is a third shape and shape is what the registry keys on. */
const PROTOCOL_REF = 'e'.repeat(64);
/**
 * A result the model was shown only part of (`result_cut`, core #473): the ref opens the FULL
 * text. Plain prose over the page's drawing bound, with markup in it, because that is the case
 * the full-text panel exists for — long, untrusted, and not JSON.
 */
const CUT_REF = 'f'.repeat(64);
const CUT_TEXT = [
  'Safety data sheet, section 10: stability and reactivity.',
  '<b>Not bold</b> <script>window.__fixturePwned = true</script>',
  ...Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}: incompatible with strong oxidisers.`),
  'END OF DOCUMENT',
].join('\n');
/** A cut result whose full text retention has since swept — the ref 404s. */
const SWEPT_REF = '0'.repeat(64);

/** What `screen_hazards` actually returns, of which the streamed preview is the first 200 chars. */
const HAZARD_RESULT = {
  verdict: '1 hazard rule(s) matched (most serious: high). A clean screen is not a clearance.',
  screened: ['CCN=[N+]=[N-]'],
  flags: [
    {
      rule_id: 'organic-azide',
      severity: 'high',
      explanation: 'Low carbon-to-nitrogen ratio; shock and friction sensitive.',
      citation: 'Bretherick’s Handbook, 7th ed.',
      matched: 'CCN=[N+]=[N-]',
    },
  ],
};

/** What a property calculator returns: named scalars, no units on the wire, no record list. */
const PKA_RESULT = { verdict: 'Most acidic site: the carboxylic acid.', pka: 4.76, sd: 1.6 };

/** The design every protocol route below answers about. */
const DESIGN_ID = 'design-0123456789ab';

/**
 * What a protocol tool returns into the conversation — a THIRD result shape in the turn.
 *
 * The registry dispatches on shape, so one payload per shape is what stops a renderer shipping
 * green and broken. This one also carries a non-zero `arms_omitted`, which is the sentence that
 * keeps the card honest: two of four arms with nothing saying so is a run sheet a chemist would
 * work from as though it were the whole design.
 */
const PROTOCOL_RECEIPT: ProtocolReceipt = {
  design_id: DESIGN_ID,
  revision: 2,
  title: 'Amination solvent screen',
  mode: 'screen',
  status: 'draft',
  has_protocol: true,
  summary: '4 arms across 2 factors; 1 check did not pass.',
  checks: [
    {
      check_id: 'plate-fits',
      severity: 'blocker',
      passed: false,
      detail: '4 arms were laid out on a plate with 2 free wells.',
    },
    {
      check_id: 'charge-complete',
      severity: 'note',
      passed: true,
      detail: 'Every species charged.',
    },
  ],
  blocking: ['plate-fits'],
  factors: { solvent: ['2-MeTHF', 'CPME'], base: ['K3PO4', 'Cs2CO3'] },
  arm_count: 4,
  arms: [
    {
      arm_id: 'arm-1',
      well: 'A1',
      run_order: 1,
      levels: { solvent: '2-MeTHF', base: 'K3PO4' },
      temperature_c: 80,
      time_h: 16,
      solvent: '2-MeTHF',
      control: '',
      replicate_of: '',
      note: '',
    },
    {
      arm_id: 'arm-2',
      well: 'A2',
      run_order: 2,
      levels: { solvent: 'CPME', base: 'K3PO4' },
      temperature_c: 80,
      time_h: 16,
      solvent: 'CPME',
      control: '',
      replicate_of: '',
      note: '',
    },
  ],
  arms_omitted: 2,
  plate_format: 24,
  evidence_count: 1,
  changed_paths: ['base.setpoints', 'arms'],
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One frame of the scripted turn, and how long to wait after writing it.
 *
 * The gap is per frame rather than a constant, and the two values mean different things. 220 ms
 * after a `token` is what `e2e/chat.spec.ts` measures — it is the evidence that text reaches the
 * browser mid-turn rather than in one block at the end, so it must stay generous. 40 ms after a
 * structural frame is just ordering: those frames were added to reach renderers no browser test
 * had ever exercised, and paying a token-sized gap for each would push the first token most of a
 * second later and make the incremental assertion race its own fixture.
 */
type Frame = readonly [event: ChemclawEvent, gapMs: number];

/**
 * The turn, in the order the backend produces it.
 *
 * Sixteen frames covering ten of the seventeen event types, where this used to carry five — and
 * three stored results of DIFFERENT SHAPES, because the renderer registry dispatches on shape and
 * a fixture carrying one payload proves one renderer. Three is also `MAX_RESULT_BLOCKS`, so this
 * turn sits exactly on the cap the answer renders. The
 * three that were *declared and missing* are the ones that cost most: `plan.plan_hash` is what the
 * approval gate posts back, so without it the browser-level approval path was never exercised in
 * its real shape, and `agent` on `tool_call`/`tool_result` is the specialist attribution the trace
 * panel renders — never once seen in a browser.
 *
 * `capability_degraded`, `tool_failed`, `evidence_source`, `job_started` and `job_completed` are
 * here because a crash in any of those renderers shipped green through the whole browser tier. The
 * five that remain absent (`queued`, `question`, `note_proposed`, `approval_request`, `error`) are
 * each a *different turn* rather than a different frame — they change what the turn is, so they
 * belong in scenarios of their own rather than bolted onto the one every other spec asserts on.
 */
const TURN: readonly Frame[] = [
  [
    {
      type: 'plan',
      todos: ['Check the hazard profile', 'Estimate the pKa'],
      // Declared, and previously missing. `POST /sessions/{id}/plan/decision` requires it: a plan
      // frame without one cannot be approved without a second fetch that races the revision the
      // hash exists to catch.
      plan_hash: 'e2e-plan-hash-1',
      // The tools approving this plan authorizes, which the card must display and not merely
      // collect a yes to. Named here so the e2e fixture exercises the field a current service
      // sends rather than the empty fallback an older one degrades to.
      scope: ['record_knowledge_note'],
    },
    40,
  ],
  // A turn that lost a connector still answers; it answers with less. Emitted before the first
  // token, so the answer can be marked partial while it streams rather than retroactively.
  [{ type: 'capability_degraded', connectors: ['eln'] }, 40],
  // A retrieval source that RAISED, as opposed to one that was asked and had nothing — the
  // distinction the event exists for, and one nothing had rendered in a browser.
  [{ type: 'evidence_source', source: 'lexical', chunks: 0, failed: true }, 40],
  [
    {
      type: 'tool_call',
      tool: 'screen_hazards',
      arguments: '{"smiles":"CCO"}',
      // Empty is the main agent, which is what every event meant before teams existed.
      agent: '',
    },
    40,
  ],
  [
    {
      type: 'tool_result',
      tool: 'screen_hazards',
      // `preview`, not `result` — the field is named for what it is, and it is truncated. The
      // ref is how the browser reaches the rest.
      preview: JSON.stringify(HAZARD_RESULT).slice(0, 200),
      result_ref: RESULT_REF,
      note_ids: [],
      numbers: [],
      agent: '',
    },
    40,
  ],
  // A gate refusal, which is the control working rather than a fault — and which the trace panel
  // deliberately renders in a different colour and different words from a fault. Nothing had ever
  // proved that branch renders at all.
  [
    {
      type: 'tool_failed',
      tool: 'submit_qm_job',
      message: 'The plan has not been approved, so state-changing tools are held.',
      reason: 'plan_gate',
      agent: '',
    },
    40,
  ],
  [{ type: 'tool_call', tool: 'predict_pka', arguments: '{"smiles":"CC(=O)O"}', agent: '' }, 40],
  [
    {
      type: 'tool_result',
      tool: 'predict_pka',
      preview: JSON.stringify(PKA_RESULT).slice(0, 200),
      result_ref: VALUES_REF,
      // Small enough to ride along, which is the ordinary case for a property lookup — so the
      // browser tier exercises the path where a block renders with NO fetch at all.
      result_inline: JSON.stringify(PKA_RESULT),
      note_ids: [],
      // Untruncated beside a truncated preview, and what the answer's figure marks are checked
      // against.
      numbers: [4.76, 1.6],
      // The same figures under the tool's own keys. `sd` is not an uncertainty on `pka` as far as
      // anything here knows, and the surfaces print them as the two values they are.
      values: [
        { label: 'pka', value: 4.76, unit: '' },
        { label: 'sd', value: 1.6, unit: '' },
      ],
      agent: '',
    },
    40,
  ],
  [
    {
      type: 'tool_call',
      tool: 'draft_experiment_protocol',
      arguments: '{"goal":"screen the amination solvent"}',
      agent: '',
    },
    40,
  ],
  [
    {
      type: 'tool_result',
      tool: 'draft_experiment_protocol',
      preview: JSON.stringify(PROTOCOL_RECEIPT).slice(0, 200),
      result_ref: PROTOCOL_REF,
      // Inline, so the browser tier exercises the protocol block with no fetch at all — and the
      // ref is still there, so "Open full result" reaches the panel behind it.
      result_inline: JSON.stringify(PROTOCOL_RECEIPT),
      note_ids: [],
      numbers: [],
      values: [],
      agent: '',
    },
    40,
  ],
  [{ type: 'tool_call', tool: 'read_document', arguments: '{"id":"sds-2-methf"}', agent: '' }, 40],
  [
    {
      type: 'tool_result',
      tool: 'read_document',
      // What the model read began like this; it was cut to fit, and the ref opens all of it.
      preview: CUT_TEXT.slice(0, 200),
      result_ref: CUT_REF,
      result_cut: true,
      note_ids: [],
      numbers: [],
      agent: '',
    },
    40,
  ],
  [{ type: 'job_started', job_id: 'calc-9f2c', kind: 'calc' }, 40],
  // `agent: ''` on every token, deliberately. The field means "which agent produced this chunk",
  // and the backend's own contract is that a consumer concatenates only the *unattributed* ones —
  // an attributed chunk is a subagent's working notes rather than part of the answer. Populating
  // it with a name here would correctly make the answer render empty, which is a scenario of its
  // own rather than the shape every other spec asserts against.
  [{ type: 'token', text: 'The pKa of acetic acid ', agent: '' }, 220],
  [{ type: 'token', text: 'is about 4.76 ', agent: '' }, 220],
  [{ type: 'token', text: 'in water at 25 °C.', agent: '' }, 220],
  [
    {
      type: 'job_completed',
      job_id: 'calc-9f2c',
      summary: { converged: true, total_energy_hartree: -154.7593, molecule_smiles: 'CCO' },
    },
    40,
  ],
  [
    {
      type: 'answer',
      text: 'The pKa of acetic acid is about 4.76 in water at 25 °C.',
      confidence: 0.91,
      review_required: false,
      unsupported_claims: [],
      verified_by: 'citation-gate',
      // Not empty here, and that is the point of the fixture: this stands in for a turn where the
      // verifier *did* run and cleared the answer. An empty array beside `confidence: 0.91` would
      // be the one state the core layer cannot produce.
      checks_run: ['verifier'],
      challenged: false,
      review_hold_id: null,
    },
    0,
  ],
];

/** One scripted turn. Gaps are what make the incremental assertion meaningful. */
async function streamTurn(res: ServerResponse, frames: readonly Frame[] = TURN): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let aborted = false;
  // The UI's Stop works by closing the socket; the BFF turns that into a destroyed upstream
  // request, which lands here. Honouring it is what lets the "Stop" test mean anything.
  //
  // On the RESPONSE, not the request: `req`'s close fires once the request body has been fully
  // read, which for a POST is immediately — so watching `req` aborts every turn after one frame.
  // This is the same event the real BFF listens on (server/proxy.ts).
  res.on('close', () => {
    aborted = true;
  });

  for (const [event, gap] of frames) {
    if (aborted) return;
    // The `event:` name comes off the frame's own discriminator rather than being written beside
    // it. sse-starlette sends both, and a fixture that carried two copies could disagree with
    // itself — which is a defect shape no consumer of this file could diagnose.
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (gap > 0) await sleep(gap);
  }
  res.end();
}

/* ── Artefacts (exhibits) ─────────────────────────────────────────────────────
 *
 * Scenario-scoped rather than added to `TURN`, for the reason the paragraph above `TURN` gives
 * about turns that change what the turn *is*: an artefact opens the pane beside the transcript, so
 * putting one in the turn every other spec asserts on would move every other spec's layout. A
 * session in `EXHIBIT_SESSIONS` streams `EXHIBIT_TURN` instead, and holds its own artefact state.
 *
 * Two sessions, one per Playwright project, because both projects run at once against this one
 * process and an edit is a *write*: a shared artefact would have the desktop run's r2 appear under
 * the mobile run's first look. `e2e/exhibits.spec.ts` and the a11y spec pick theirs by project.
 *
 * The state is the service's contract in miniature, enforced rather than echoed: a revision posted
 * against anything but the head is a 409 `stale_revision` naming the head, exactly as the service
 * answers it — a fixture that accepted any parent would let a client that never sent one pass.
 */
const EXHIBIT_SESSIONS = new Set(['7'.repeat(32), '6'.repeat(32), '5'.repeat(32)]);
const EXHIBIT_ID = 'xb-00e2e00e2e00e2e0';

const EXHIBIT_TABLE: TableSpec = {
  kind: 'table',
  columns: [
    { key: 'solvent', label: 'Solvent', unit: '' },
    { key: 'yield', label: 'Yield', unit: '%' },
    { key: 'bp', label: 'Boiling point', unit: '°C' },
  ],
  rows: [
    { solvent: '2-MeTHF', yield: 82, bp: 80 },
    { solvent: 'CPME', yield: 64, bp: 106 },
    { solvent: 'Toluene', yield: null, bp: 111 },
  ],
};

interface StoredRevision {
  record: ExhibitRevision;
  spec: TableSpec;
}

/** Each exhibit session's one artefact, as its revisions, oldest first. */
const exhibitState = new Map<string, StoredRevision[]>();

function resetExhibit(sessionId: string): void {
  exhibitState.set(sessionId, [
    {
      record: {
        revision: 1,
        parent_revision: 0,
        author_kind: 'agent',
        author: 'chemclaw',
        change_note: 'Ranked by isolated yield',
        created_at: '2026-10-02T14:02:00Z',
        byte_size: JSON.stringify(EXHIBIT_TABLE).length,
      },
      spec: EXHIBIT_TABLE,
    },
  ]);
}

function exhibitHeader(sessionId: string, revisions: StoredRevision[]): ExhibitHeader {
  const head = revisions[revisions.length - 1]!;
  return {
    exhibit_id: EXHIBIT_ID,
    session_id: sessionId,
    kind: 'table',
    title: 'Solvent ranking for the amination',
    head_revision: head.record.revision,
    head_author_kind: head.record.author_kind,
    head_author: head.record.author,
    created_by: 'chemclaw',
    created_at: '2026-10-02T14:02:00Z',
    updated_at: head.record.created_at,
  };
}

function exhibitView(sessionId: string, revisions: StoredRevision[], asked: number): ExhibitView {
  const at = revisions.find((r) => r.record.revision === asked) ?? revisions[revisions.length - 1]!;
  return {
    ...exhibitHeader(sessionId, revisions),
    revision: at.record.revision,
    parent_revision: at.record.parent_revision,
    author_kind: at.record.author_kind,
    author: at.record.author,
    change_note: at.record.change_note,
    revision_created_at: at.record.created_at,
    spec: at.spec,
    // Phase 2's grounding check, on the agent's revision only: 111 was never returned by a tool.
    unverified_figures: at.record.author_kind === 'agent' ? ['111'] : [],
  };
}

/** A per-cell diff in `DesignDiff`'s shape, as the service's `exhibits/diff.py` writes one. */
function exhibitDiff(from: StoredRevision, to: StoredRevision): ExhibitDiff {
  const changes: ExhibitDiff['changes'] = [];
  to.spec.rows.forEach((row, i) => {
    for (const column of to.spec.columns) {
      const before = from.spec.rows[i]?.[column.key] ?? null;
      const after = row[column.key] ?? null;
      if (before !== after) {
        changes.push({
          path: `rows[${i}].${column.key}`,
          kind: 'changed',
          before: before === null ? '' : String(before),
          after: after === null ? '' : String(after),
        });
      }
    }
  });
  return { from_revision: from.record.revision, to_revision: to.record.revision, changes };
}

/** The agent writes a table as part of its answer: call, result, then the header-only frame. */
const EXHIBIT_TURN: readonly Frame[] = [
  [
    {
      type: 'tool_call',
      tool: 'create_exhibit',
      arguments: '{"title":"Solvent ranking for the amination","spec":{"kind":"table"}}',
      agent: '',
    },
    40,
  ],
  [
    {
      type: 'tool_result',
      tool: 'create_exhibit',
      preview: `{"exhibit_id": "${EXHIBIT_ID}", "revision": 1}`,
      result_ref: '',
      note_ids: [],
      numbers: [1],
      agent: '',
    },
    40,
  ],
  [
    {
      type: 'exhibit',
      exhibit_id: EXHIBIT_ID,
      revision: 1,
      kind: 'table',
      title: 'Solvent ranking for the amination',
      op: 'created',
      author_kind: 'agent',
      author: 'chemclaw',
    },
    40,
  ],
  [
    {
      type: 'token',
      text: 'I ranked the three solvents in the artefact beside this answer.',
      agent: '',
    },
    80,
  ],
  [
    {
      type: 'answer',
      text: 'I ranked the three solvents in the artefact beside this answer.',
      confidence: null,
      review_required: false,
      unsupported_claims: [],
      verified_by: null,
      checks_run: [],
      challenged: false,
      review_hold_id: null,
    },
    0,
  ],
];

/** Read a JSON request body. */
function readBody<T>(req: import('node:http').IncomingMessage): Promise<T> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(JSON.parse(body || '{}') as T));
  });
}

/** Every artefact route, for an exhibit session. `null` when the path is not one of them. */
async function exhibits(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (path === '/exhibits' && req.method === 'GET') {
    const all = [...exhibitState].map(([sid, revisions]) => exhibitHeader(sid, revisions));
    json(res, 200, { exhibits: all });
    return true;
  }
  const match =
    /^\/sessions\/([0-9a-f]{32})\/exhibits(?:\/(xb-[0-9a-f]{16})(\/revisions|\/diff|\/export\.(md|csv|smi))?)?$/.exec(
      path,
    );
  if (!match) return false;
  const [, sid = '', xid, tail] = match;
  const revisions = exhibitState.get(sid);
  if (!xid) {
    if (req.method === 'GET') {
      const listed: ExhibitListOut = {
        enabled: true,
        exhibits: revisions ? [exhibitHeader(sid, revisions)] : [],
      };
      json(res, 200, listed);
      return true;
    }
    req.resume();
    json(res, 422, { detail: 'this fixture only pins in the a11y and exhibit specs' });
    return true;
  }
  if (!revisions || xid !== EXHIBIT_ID) {
    req.resume();
    json(res, 404, { detail: 'unknown artefact' });
    return true;
  }
  const head = revisions[revisions.length - 1]!;
  if (!tail && req.method === 'GET') {
    json(res, 200, exhibitView(sid, revisions, Number(url.searchParams.get('revision') ?? 0)));
    return true;
  }
  if (tail === '/revisions' && req.method === 'GET') {
    json(res, 200, { revisions: revisions.map((r) => r.record) });
    return true;
  }
  if (tail === '/revisions' && req.method === 'POST') {
    const posted = await readBody<{
      parent_revision?: number;
      spec?: TableSpec;
      change_note?: string;
    }>(req);
    if (posted.parent_revision !== head.record.revision) {
      json(res, 409, {
        detail: {
          code: 'stale_revision',
          head_revision: head.record.revision,
          message: `revision ${String(posted.parent_revision)} is not the head (${head.record.revision})`,
        },
      });
      return true;
    }
    const spec = posted.spec ?? head.spec;
    revisions.push({
      record: {
        revision: head.record.revision + 1,
        parent_revision: head.record.revision,
        author_kind: 'human',
        author: 'dev-user',
        change_note: posted.change_note ?? '',
        created_at: '2026-10-02T14:20:00Z',
        byte_size: JSON.stringify(spec).length,
      },
      spec,
    });
    json(res, 201, exhibitView(sid, revisions, 0));
    return true;
  }
  if (tail === '/diff' && req.method === 'GET') {
    const at = (n: number): StoredRevision =>
      revisions.find((r) => r.record.revision === n) ?? head;
    json(
      res,
      200,
      exhibitDiff(at(Number(url.searchParams.get('from'))), at(Number(url.searchParams.get('to')))),
    );
    return true;
  }
  if (tail?.startsWith('/export.') && req.method === 'GET') {
    const rows = head.spec.rows.map((row) =>
      head.spec.columns.map((c) => String(row[c.key] ?? '')).join(','),
    );
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="solvent-ranking.csv"',
    });
    res.end([head.spec.columns.map((c) => c.label).join(','), ...rows].join('\r\n'));
    return true;
  }
  req.resume();
  json(res, 405, { detail: 'method not allowed' });
  return true;
}

const SESSIONS: SessionSummary[] = [];

const SHARED_TRANSCRIPT: TranscriptMessage[] = [
  // 0-based, and it is `_transcript`'s `enumerate(stored)` that says so — the assistant reply
  // below is index 1. Bumping this to 1 gave two messages one index, which is a key a client
  // renders duplicates under; `ProtocolStep.index` next door is `ge=1` and that is a different
  // field with a different contract.
  { index: 0, role: 'user', text: 'What did we decide about the ligand?', tool_calls: [] },
  {
    index: 1,
    role: 'assistant',
    text: 'BrettPhos, at 1.2 equiv base.',
    tool_calls: [
      { tool: 'gather_evidence', arguments: '{"query":"ligand"}', result: '2 notes' },
      // Cut for the model, and its full text since swept by retention: the ref 404s.
      {
        tool: 'read_document',
        arguments: '{"id":"ligand-review"}',
        result: 'BrettPhos review, first part…',
        result_ref: SWEPT_REF,
        result_cut: true,
      },
    ],
  },
];

/**
 * Shared sessions (Chemclaw3 #483), from both sides of one — driven by `e2e/shared.spec.ts`.
 *
 * The browser is always `dev-user` here (`AUTH_MODE=dev`), so "member" and "owner" are two
 * sessions rather than two people:
 *
 *  - `MEMBER_SID` is somebody else's (`OWNER_OID`) that `dev-user` was let into. It is listed by
 *    `GET /sessions/shared`, its transcript has both people's questions, its plan is the owner's —
 *    so the card must show the author and refuse the controls — and the owner's acts (delete,
 *    fork, admitting anybody) answer 403 exactly as the service does.
 *  - `OWNED_SID` is `dev-user`'s own, with a roster the spec edits. It is **not** listed by
 *    `GET /sessions` — every other spec's sidebar would grow a row — so the spec seeds the local
 *    conversation that points at it.
 *
 * The roster is the one piece of mutable state, and the spec runs in two projects in parallel, so
 * each run adds and removes an actor id of its own; nothing asserts the roster as a whole.
 */
const MEMBER_SID = '9'.repeat(32);
const OWNED_SID = '8'.repeat(32);
const OWNER_OID = 'owner-oid-5b1f';
const DEV_OID = 'dev-user';
const SHARED_WITH_ME: SharedSessionSummary[] = [
  {
    session_id: MEMBER_SID,
    owner: OWNER_OID,
    title: 'Shared amination screen',
    added_at: '2026-09-27T09:00:00Z',
  },
];
const MEMBER_TRANSCRIPT: TranscriptMessage[] = [
  {
    index: 0,
    role: 'user',
    text: 'Which base for the amination?',
    tool_calls: [],
    author: { actor: OWNER_OID, agent: null },
  },
  {
    index: 1,
    role: 'assistant',
    text: 'Cs2CO3 in 2-MeTHF; I have drafted a screen for approval.',
    tool_calls: [],
    author: { actor: OWNER_OID, agent: 'chemclaw' },
  },
  {
    index: 2,
    role: 'user',
    text: 'Can we add K3PO4 as a second arm?',
    tool_calls: [],
    author: { actor: DEV_OID, agent: null },
  },
  {
    index: 3,
    role: 'assistant',
    text: 'Added. The owner’s plan still needs their decision.',
    tool_calls: [],
    author: { actor: DEV_OID, agent: 'chemclaw' },
  },
];
/** The member session's plan — its owner's, so `dev-user` may read it and not decide it. */
const MEMBER_PLAN: PlanStatusOut = {
  session_id: MEMBER_SID,
  plan_hash: 'e2e-shared-plan',
  plan: ['[ ] Screen Cs2CO3 and K3PO4 in 2-MeTHF'],
  scope: ['draft_experiment_protocol'],
  mode: 'plan_only',
  approved: false,
  decided_by: null,
  author: OWNER_OID,
};
/** `OWNED_SID`'s members, by actor id → when they were added. */
const ownedMembers = new Map<string, string>();

function roster(sessionId: string): SessionMembersOut {
  if (sessionId === MEMBER_SID) {
    return {
      owner: OWNER_OID,
      members: [
        { actor: DEV_OID, added_at: '2026-09-27T09:00:00Z' },
        { actor: 'colleague-oid-77a2', added_at: '2026-09-27T09:30:00Z' },
      ],
    };
  }
  // Every other session here is `dev-user`'s own; only `OWNED_SID` has anybody else in it.
  return {
    owner: DEV_OID,
    members:
      sessionId === OWNED_SID
        ? [...ownedMembers].map(([actor, added_at]) => ({ actor, added_at }))
        : [],
  };
}

/** The member routes, answered the way `routes/members.py` answers them. */
function members(
  res: ServerResponse,
  method: string,
  sessionId: string,
  actor: string | null,
): void {
  if (actor === null) {
    if (method === 'GET') return json(res, 200, roster(sessionId));
    return json(res, 405, { detail: 'Method Not Allowed' });
  }
  if (sessionId === MEMBER_SID) {
    // A member may take only themself out; everything else is the owner's.
    if (method === 'DELETE' && actor === DEV_OID) return noContent(res);
    return json(res, 403, {
      detail:
        method === 'PUT'
          ? 'only the session’s owner may admit somebody'
          : 'only the session’s owner may remove somebody else',
    });
  }
  // The roster the spec edits is `OWNED_SID`'s alone, so no other spec's session grows members.
  if (sessionId !== OWNED_SID) return json(res, 404, { detail: 'unknown session' });
  if (method === 'PUT') {
    if (actor === DEV_OID) {
      return json(res, 409, { detail: 'the owner is not a member of their session' });
    }
    if (!ownedMembers.has(actor)) ownedMembers.set(actor, new Date().toISOString());
    return noContent(res);
  }
  if (method === 'DELETE') {
    if (!ownedMembers.delete(actor))
      return json(res, 404, { detail: 'not a member of this session' });
    return noContent(res);
  }
  return json(res, 405, { detail: 'Method Not Allowed' });
}

function noContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

// One conversation blocked on a plan decision, so `/review` renders its inbox with a row rather
// than one of its empty states. `unread: 0` and `truncated: false` keep the partial-scan notice
// out of the way of the axe pass; the notice itself is covered by the component tests. Both are
// stated rather than left off: the service sends every field of this model on every answer, and a
// fixture that omits one is describing a response nobody receives.
const PENDING_PLANS: PendingPlans = {
  plans: [
    {
      session_id: SID,
      title: 'Which solvent for the Suzuki step?',
      updated_at: '2026-08-09T09:00:00Z',
      plan_hash: 'e2e-plan-hash',
      plan: ['screen the hazards of 2-MeTHF', 'record the comparison as a note'],
      scope: ['screen_hazards', 'record_knowledge_note'],
    },
  ],
  considered: 1,
  gated: 1,
  unread: 0,
  truncated: false,
};

/**
 * One question of the caller's own that is still open, so `/review` renders a check-in row.
 *
 * Non-empty rather than `[]` for the reason `PENDING_PLANS` is: the axe pass over that page should
 * see the markup a chemist sees, and an empty state is a different piece of markup. Every field is
 * stated — the service defaults them all, so it sends them all, and a fixture that omitted one
 * would be describing a response nobody receives. `truncated: false` so the axe pass sees the
 * ordinary row rather than the short-list notice, which is the state a chemist is almost always in.
 *
 * `GET /check-ins` is a **destructive claim** upstream. This fixture answers the same rows every
 * time, which is a deliberate difference and a harmless one: no browser test reloads and then
 * asserts the notice is gone, and a fixture that consumed would make every spec order-dependent.
 */
const CHECK_INS: CheckIn[] = [
  {
    request_id: 'await-e2e-1',
    kind: 'measurement',
    subject: 'Measured yield for the 2-MeTHF arm',
    rationale: 'The campaign cannot pick round 4 conditions until round 3 is measured.',
    asked_of: 'process-chemistry',
    open_days: 9,
    days_left: 5,
    session_id: 'sess-e2e-1',
    truncated: false,
  },
];

/**
 * One standing query's finding, so `/review` renders a digest card.
 *
 * A row rather than `[]` for `CHECK_INS`'s reason, and because a spec now asserts on the card:
 * `e2e/routing.spec.ts` reads a headline and the disputed count off it, and the a11y pass waits for
 * it before scanning. Every field is stated — the service defaults them all, so it sends them all.
 * Two notes, one disputed, so the page shows both marks the card can draw (the count in the
 * summary line and the badge on the note) and axe sees the badge in both themes.
 *
 * `GET /digests` is a destructive claim upstream; this answers the same row every time for the
 * reason given above `CHECK_INS`. The store dedups a re-claimed digest by content, so a reload
 * inside one spec does not draw it twice.
 */
const DIGESTS: Digest[] = [
  {
    query: 'Suzuki couplings in 2-MeTHF',
    note_ids: ['note-7f3a', 'note-7f3b'],
    disputed: ['note-7f3b'],
    headlines: {
      'note-7f3a': 'Pd(dppf)Cl2 in 2-MeTHF gave 84% at 60 °C on the bromide.',
      'note-7f3b': 'CPME outperformed 2-MeTHF for the chloride at the same loading.',
    },
  },
];

const JOB: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
  plan_step: 'Compare the two solvents at GFN2 level',
  state: 'completed',
  completed_at: '2026-08-01T09:00:00Z',
};

/* ── The experiment design ────────────────────────────────────────────────────
 *
 * Mutable across the process's life on purpose: the browser spec edits the protocol and then reads
 * it back, and a fixture that answered with the same revision either way would let a save that
 * wrote nothing pass. `HEAD` moves when a revision is posted.
 */

const DESIGN_SUMMARY: DesignSummary = {
  design_id: DESIGN_ID,
  title: 'Amination solvent screen',
  mode: 'screen',
  status: 'draft',
  project: 'PRJ-4',
  opened_by: 'chemist@example.com',
  head_revision: 2,
  arms: 2,
  blockers: 1,
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
};

/** The revision the browser edits, built at whatever number the fixture is currently on. */
const DESIGN_REVISION = (at: number, temperature: number): DesignRevision => ({
  design_id: DESIGN_ID,
  revision: at,
  kind: 'protocol',
  author_kind: at > 2 ? 'human' : 'agent',
  author: at > 2 ? 'chemist@example.com' : 'chemclaw',
  change_note: at > 2 ? 'Raised the temperature.' : 'Drafted from the structured request.',
  checks: PROTOCOL_RECEIPT.checks,
  created_at: '2026-08-21T09:00:00Z',
  design: {
    request: {
      title: 'Amination solvent screen',
      goal: 'Find a solvent that keeps selectivity above 9:1.',
      mode: 'screen',
      reaction_smiles: '',
      components: [
        {
          name_as_written: 'the aryl bromide',
          smiles: 'Brc1ccccc1',
          role: 'starting-material',
          resolution: 'resolved from the corpus',
        },
      ],
      objectives: ['yield', 'selectivity'],
      // One of each basis: the three render very differently and the difference is the whole
      // honesty story of this screen.
      scale: { value: '250 mg', basis: 'stated', quote: 'run it on 250 mg of the bromide' },
      plate_format: { value: '24', basis: 'inferred', quote: '' },
      max_runs: { value: '', basis: 'absent', quote: '' },
      deadline: { value: '', basis: 'absent', quote: '' },
      forbidden: ['DMF'],
      prior_work: '',
      project: 'PRJ-4',
      notes: '',
    },
    base: {
      setpoints: {
        temperature_c: temperature,
        time_h: 16,
        pressure_bar: null,
        atmosphere: 'N2',
        concentration_molar: 0.2,
        solvent: '2-MeTHF',
        ph: null,
      },
      charge: [
        {
          component: 'aryl bromide',
          smiles: 'Brc1ccccc1',
          role: 'starting-material',
          equivalents: 1,
          amount_mmol: 1.59,
          mass_mg: 250,
          volume_ml: null,
          limiting: true,
          note: '',
        },
      ],
      steps: [
        {
          index: 1,
          kind: 'charge',
          text: 'Charge the vessel with the aryl bromide and the base.',
          components: ['aryl bromide'],
          temperature_c: null,
          duration_h: null,
        },
      ],
      analytics: [
        { name: 'HPLC', timing: 'at 16 h', method: 'UV 254 nm', measures: ['conversion'] },
      ],
      in_process_controls: ['Take a sample at 4 h.'],
      hazards: ['Aryl bromide is a lachrymator.'],
      waste: 'Halogenated aqueous.',
      expected: { yield_percent: 72, selectivity: '9:1', basis: 'precedent', detail: '' },
    },
    factors: [
      {
        name: 'solvent',
        kind: 'categorical',
        role: 'solvent',
        unit: '',
        levels: [
          { label: '2-MeTHF', smiles: '', value: null, unit: '', rationale: 'green' },
          { label: 'CPME', smiles: '', value: null, unit: '', rationale: 'higher boiling' },
        ],
      },
    ],
    arms: [
      {
        arm_id: 'arm-1',
        levels: { solvent: '2-MeTHF' },
        setpoints: null,
        control: '',
        replicate_of: '',
        note: '',
      },
      {
        arm_id: 'arm-ctl',
        levels: { solvent: 'CPME' },
        setpoints: null,
        control: 'positive',
        replicate_of: '',
        note: 'Known-good conditions.',
      },
    ],
    // The plate the producer would actually emit: `PLATE_SHAPES[24]` is 4x6, and `place()` writes
    // 0-based `row`/`column` with `label = row_label(row) + str(column + 1)`. This declared a 2x2
    // 24-well plate with 1-based wells — a shape the service cannot produce and `layout_fits` now
    // refuses — which is what let the map's 0-based column headers look right in every test.
    layout: {
      plate_format: 24,
      rows: 4,
      columns: 6,
      randomized: true,
      seed: 7,
      wells: [
        { label: 'A1', row: 0, column: 0, arm_id: 'arm-1', run_order: 2 },
        { label: 'B2', row: 1, column: 1, arm_id: 'arm-ctl', run_order: 1 },
      ],
    },
    evidence: [
      {
        kind: 'precedent',
        ref: 'note-suzuki-42',
        tool: 'similar_reactions',
        summary: 'A close analogue ran at 80 °C in 2-MeTHF.',
        supports: ['base.setpoints.temperature_c'],
      },
    ],
  },
});

const DESIGN_DIFF: DesignDiff = {
  from_revision: 2,
  to_revision: 3,
  changes: [
    { path: 'base.setpoints.temperature_c', kind: 'changed', before: '80', after: '100' },
    { path: 'arms[0].note', kind: 'added', before: '', after: 'repeat if conversion stalls' },
  ],
};

/** The head, which the browser spec moves by saving a revision. */
let head = 2;
/**
 * The design's current status, which the browser spec moves by marking it.
 *
 * Mutable for `expected_revision`'s reason one field along: the status route enforces **two**
 * compare-and-sets, and a fixture that held the status constant could not tell a correct
 * `expected_status` from a stale one — so the app could ship sending the badge it happened to
 * render, or nothing at all, and pass.
 */
let designStatus: DesignSummary['status'] = 'draft';
/** The base temperature, so a save is visible when the document is read back. */
let temperature = 80;

const NOTE = (id: string): NoteView => ({
  note: {
    id,
    type: 'reaction',
    compound_smiles: '',
    tags: ['suzuki'],
    created_by: 'agent',
    source: 'eln-ord',
    confidence: 0.82,
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
  },
  body: 'Ran in 2-MeTHF at 70 °C; 92% isolated after aqueous workup.',
  neighbors: [],
});

/** One skill of the chemist's own, verbatim — frontmatter included, because that is what acts. */
const MY_SKILL = {
  name: 'my-workup',
  body: '---\nname: my-workup\ndescription: how I work up a Suzuki\n---\n\nQuench cold, then filter.\n',
};
/** The organisation's one active skill, and the history a revert chooses from. */
const ORG_SKILL = {
  name: 'house-workup',
  body: '---\nname: house-workup\ndescription: the house workup\n---\n\nQuench cold.\n',
};
const ORG_VERSIONS = [
  {
    content_hash: '1'.repeat(64),
    body: ORG_SKILL.body,
    activated_by: 'admin@example.com',
    activated_at: '2026-09-20T10:00:00Z',
  },
];
/** A name this fixture treats as shipped with the deployment, so a save under it is refused. */
const SHIPPED_SKILL = 'suzuki-coupling';
const PROPOSAL = {
  kind: 'skill',
  name: 'pd-removal',
  content_hash: '2'.repeat(64),
  content: '---\nname: pd-removal\ndescription: filter cold\n---\n\nFilter the palladium cold.\n',
  rationale: 'The third time this quarter the Pd removal failed the same way.',
  state: 'open',
  session_id: '',
};
const ROW_CAP_DETAIL =
  'you keep 8 personal skills, the most this deployment allows: every one is in the prompt of every turn you take. Remove one first.';

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz' || path === '/readyz') return json(res, 200, { ok: true });
  if (path === '/sessions' && req.method === 'POST') return json(res, 200, { session_id: SID });
  // A bare array, which is what `list_sessions` returns. This answered `{sessions: []}`, so
  // `remote.length` was undefined, `remote.filter` threw, and every browser test quietly ran the
  // sidebar's degraded branch — the fixture was exercising the error path by accident. Typing it
  // as `SessionSummary[]` is what stops that recurring silently.
  if (path === '/sessions' && req.method === 'GET') return json(res, 200, SESSIONS);
  // Before any `/sessions/{id}/…` match: `shared` is not a session id, and the service registers
  // this route without one.
  if (path === '/sessions/shared' && req.method === 'GET') return json(res, 200, SHARED_WITH_ME);
  const memberRoute = /^\/sessions\/([0-9a-f]{32})\/members(?:\/([^/]+))?$/.exec(path);
  if (memberRoute) {
    const actor = memberRoute[2] === undefined ? null : decodeURIComponent(memberRoute[2]);
    return members(res, req.method ?? 'GET', memberRoute[1] ?? '', actor);
  }
  if (path === `/sessions/${MEMBER_SID}/plan` && req.method === 'GET') {
    return json(res, 200, MEMBER_PLAN);
  }
  if (path === `/sessions/${MEMBER_SID}/plan/decision` && req.method === 'POST') {
    req.resume();
    return json(res, 403, {
      detail: 'only the person whose message produced this plan may decide on it',
    });
  }
  // The owner's acts, refused to a member with the service's 403 rather than its 404: the member
  // already knows the session exists.
  if (
    (path === `/sessions/${MEMBER_SID}` && req.method === 'DELETE') ||
    (path === `/sessions/${MEMBER_SID}/fork` && req.method === 'POST')
  ) {
    return json(res, 403, { detail: 'only the session’s owner may do this' });
  }
  // Two, so the picker has a choice to offer — with one it stays hidden.
  if (path === '/profiles') return json(res, 200, ['default', 'property-lookup']);
  if (path.endsWith('/messages') && req.method === 'GET') {
    // A shared-link session has a transcript to pull back; everything else is empty. The shape
    // is the service's: an index, and the tool calls behind each message.
    const transcript: TranscriptMessage[] = path.includes(SHARED_SID)
      ? SHARED_TRANSCRIPT
      : path.includes(MEMBER_SID)
        ? MEMBER_TRANSCRIPT
        : [];
    return json(res, 200, transcript);
  }

  // The untruncated result behind the ref the turn streamed.
  if (path.includes('/tool-results/') && req.method === 'GET') {
    const ref = path.split('/tool-results/')[1] ?? '';
    const stored: Record<string, { tool: string; payload: unknown }> = {
      [RESULT_REF]: { tool: 'screen_hazards', payload: HAZARD_RESULT },
      [VALUES_REF]: { tool: 'predict_pka', payload: PKA_RESULT },
      [PROTOCOL_REF]: { tool: 'draft_experiment_protocol', payload: PROTOCOL_RECEIPT },
    };
    // Stored as text, not JSON — a cut result is usually prose.
    if (ref === CUT_REF) {
      const cut: StoredToolResult = {
        ref,
        tool: 'read_document',
        correlation_id: 'turn-e2e-1',
        byte_size: Buffer.byteLength(CUT_TEXT, 'utf8'),
        text: CUT_TEXT,
      };
      return json(res, 200, cut);
    }
    const found = stored[ref];
    if (!found) return json(res, 404, { detail: 'unknown result' });
    const text = JSON.stringify(found.payload);
    const result: StoredToolResult = {
      ref,
      tool: found.tool,
      correlation_id: 'turn-e2e-1',
      byte_size: text.length,
      text,
    };
    return json(res, 200, result);
  }

  // One knowledge note, so a citation chip resolves instead of prefilling a question.
  if (path.startsWith('/notes/') && req.method === 'GET') {
    return json(res, 200, NOTE(decodeURIComponent(path.slice('/notes/'.length))));
  }

  if (path.endsWith('/messages') && req.method === 'POST') {
    // Drain the request body before replying, as the real service does.
    req.resume();
    if (url.searchParams.get('fail') === 'capacity') {
      return json(res, 503, { detail: 'at capacity' });
    }
    // An exhibit session's turn writes its artefact afresh, so a spec re-run starts from r1.
    const session = /^\/sessions\/([0-9a-f]{32})\//.exec(path)?.[1] ?? '';
    if (EXHIBIT_SESSIONS.has(session)) {
      resetExhibit(session);
      return streamTurn(res, EXHIBIT_TURN);
    }
    return streamTurn(res);
  }

  // The artefact routes. Every other session lists none, with the deployment's switch on — the
  // shape every spec's shell now reads once per conversation.
  if (await exhibits(req, res, url)) return;

  if (path.endsWith('/events')) {
    // A long-lived, deliberately silent job stream: the UI must not treat quiet as broken.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 5000);
    req.on('close', () => clearInterval(beat));
    return;
  }

  // The cross-session plan inbox — what `/review` is for now that the PR gate is gone.
  if (path === '/plans/pending' && req.method === 'GET') return json(res, 200, PENDING_PLANS);

  // Questions held open for a person. Empty rather than absent: the shell reads this once per page
  // for the sidebar badge (`useAwaitingBadge`), so leaving it unimplemented put a
  // `pending.read_failed` warning in the log of every single browser test — a real request path
  // going unexercised, reported as noise.
  if (path === '/pending' && req.method === 'GET')
    return json(res, 200, { requests: [], count: 0 });

  // The caller's own blocked work. Served rather than left to 404 for the reason `/pending` is:
  // the shell claims this once per page, so an unimplemented route puts an `api.list_route_missing`
  // warning in the log of every browser test — a real request path going unexercised, reported as
  // noise.
  if (path === '/check-ins' && req.method === 'GET') return json(res, 200, CHECK_INS);

  // Knowledge the watch found since last time. Served for the third time for the same reason:
  // `App.tsx` claims it once per page, so an unimplemented route put an `api.list_route_missing`
  // warning in the log of every browser test — and `listDigests` swallows a 404 into `[]`, so the
  // lane could not tell "the service has no digests" from "the fixture never had the route".
  //
  // A row, like `/check-ins` above, now that a spec asserts on the card it draws (`DIGESTS`).
  if (path === '/digests' && req.method === 'GET') return json(res, 200, DIGESTS);

  // The two stored skills tiers and the behaviour-proposal queue — the surfaces the stored tiers
  // hold their exemption from review under, so a page that renders blank is a control that stops
  // existing. **Stateless**: a delete or a save answers without changing what the next read
  // returns, because specs run in parallel against this one process and a mutation would make one
  // spec's assertion depend on another's timing. The specs assert on the request instead.
  if (path === '/skills/mine' && req.method === 'GET') {
    return json(res, 200, { skills: [MY_SKILL.name] });
  }
  if (path === '/skills/mine' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const posted = JSON.parse(body) as { body: string };
      const name = /^name:\s*(\S+)/m.exec(posted.body)?.[1] ?? '';
      // A name a skill this deployment ships already uses: the refusal the save route owes a
      // chemist in its own words, because what to rename is the one fact they need.
      if (name === SHIPPED_SKILL) {
        return json(res, 409, {
          detail: `a skill this deployment ships is already called ${name}; choose another name`,
        });
      }
      json(res, 200, { name, body: posted.body });
    });
    return;
  }
  if (path.startsWith('/skills/mine/')) {
    if (req.method === 'DELETE') return json(res, 200, { skills: [] });
    return json(res, 200, MY_SKILL);
  }
  if (path === '/skills/org' && req.method === 'GET') {
    return json(res, 200, { skills: [ORG_SKILL.name] });
  }
  if (path.endsWith('/versions') && path.startsWith('/skills/org/')) {
    return json(res, 200, { versions: ORG_VERSIONS });
  }
  if (path.startsWith('/skills/org/') && req.method === 'GET') return json(res, 200, ORG_SKILL);
  if (path === '/proposals' && req.method === 'GET') {
    return json(res, 200, { proposals: [PROPOSAL] });
  }
  // Accepting answers with the row cap — one of the four 409s this route has, and the one a fixed
  // "already decided" sentence used to misname.
  if (path.startsWith('/proposals/') && req.method === 'POST') {
    req.resume();
    return json(res, 409, { detail: ROW_CAP_DETAIL });
  }

  // The durable-run registry.
  if (path === '/jobs' && req.method === 'GET') {
    const text = url.searchParams.get('text') ?? '';
    const jobs: JobRecordSummary[] = text && !'nitration selectivity'.includes(text) ? [] : [JOB];
    return json(res, 200, jobs);
  }
  if (path.startsWith('/jobs/') && req.method === 'GET') {
    const status: DurableJobStatus = {
      job_id: path.slice('/jobs/'.length),
      status: 'completed',
      summary: '4 solvents ranked by ΔG.',
      result: { best: '2-MeTHF' },
      calc_refs: ['xtb:9ac1f0'],
      rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
    };
    return json(res, 200, status);
  }

  // Experiment protocols.
  if (path === '/protocols' && req.method === 'GET') {
    const designs: DesignSummary[] = [
      { ...DESIGN_SUMMARY, head_revision: head, status: designStatus },
    ];
    return json(res, 200, { designs });
  }
  if (path === `/protocols/${DESIGN_ID}` && req.method === 'GET') {
    const asked = Number(url.searchParams.get('revision') ?? head);
    // Spread FLAT, because that is the wire shape. This fixture emitted a nested
    // `{ revision: {...} }` that the service has never returned, so the end-to-end run — the one
    // test in this repository whose whole justification is "renders against a real proxied
    // response rather than a stubbed one" — was proving the app against an invention.
    const view: ProtocolView = {
      ...DESIGN_REVISION(asked, asked >= 3 ? temperature : 80),
      summary: { ...DESIGN_SUMMARY, head_revision: head, status: designStatus },
      status_history: [
        {
          status: 'approved' as const,
          revision: 2,
          actor: 'chemist@example.com',
          reason: 'The precedent runs at 80 °C.',
          created_at: '2026-08-21T10:00:00Z',
        },
      ],
      history: Array.from({ length: head - 1 }, (_, i) => head - i).map((at) => ({
        revision: at,
        kind: 'protocol' as const,
        author_kind: at > 2 ? ('human' as const) : ('agent' as const),
        author: at > 2 ? 'chemist@example.com' : 'chemclaw',
        change_note: at > 2 ? 'Raised the temperature.' : 'Drafted from the structured request.',
        created_at: '2026-08-21T09:00:00Z',
        blockers: 1,
      })),
    };
    return json(res, 200, view);
  }
  if (path === `/protocols/${DESIGN_ID}/revisions` && req.method === 'POST') {
    // Read the body: the spec asserts the edited value comes back on the next read, and a fixture
    // that ignored what was posted would let a save that wrote nothing pass.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const posted = JSON.parse(body) as {
        document: { base: { setpoints: { temperature_c: number | null } } };
      };
      temperature = posted.document.base.setpoints.temperature_c ?? temperature;
      head += 1;
      const written: RevisionWritten = {
        design_id: DESIGN_ID,
        revision: head,
        checks: PROTOCOL_RECEIPT.checks,
        changed_paths: ['base.setpoints.temperature_c'],
      };
      json(res, 200, written);
    });
    return;
  }
  if (path === `/protocols/${DESIGN_ID}/diff` && req.method === 'GET') {
    return json(res, 200, DESIGN_DIFF);
  }
  if (path === `/protocols/${DESIGN_ID}/status` && req.method === 'POST') {
    // Read the body and enforce the compare-and-set, the way the service does. A fixture that
    // answered 204 to anything would let the app ship without sending `expected_revision` at all —
    // which is exactly how the nested-`revision` invention above survived an end-to-end run.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const posted = JSON.parse(body) as {
        status?: DesignSummary['status'];
        expected_revision?: number;
        expected_status?: string;
      };
      if (posted.expected_revision !== head) {
        json(res, 409, {
          detail: {
            code: 'revision_conflict',
            message: `revision ${String(posted.expected_revision)} is not the head (${head})`,
          },
        });
        return;
      }
      // The second compare-and-set, and the reason it is here: the document did not move, so a
      // fixture enforcing only the first would answer 204 to a sign-off made from a status a
      // colleague had already changed — which is the defect the field exists to close.
      if (posted.expected_status !== designStatus) {
        json(res, 409, {
          detail: {
            code: 'status_conflict',
            message: `this design is '${designStatus}', not '${String(posted.expected_status)}' as you saw it`,
          },
        });
        return;
      }
      if (posted.status) designStatus = posted.status;
      res.writeHead(204);
      res.end();
    });
    return;
  }

  json(res, 404, { detail: 'not found' });
  // Loopback only, matching the care `playwright.config.ts` takes to bind the BFF under test to
  // 127.0.0.1: a test fixture has no reason to be reachable from off the host, and binding
  // 0.0.0.0 would expose a stub that answers with canned data to anything on the network.
}).listen(port, '127.0.0.1', () => console.log(`fixture service on 127.0.0.1:${port}`));
