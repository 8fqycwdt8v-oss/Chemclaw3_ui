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
  DurableJobStatus,
  JobRecordSummary,
  NoteView,
  PendingPlans,
  ProposalDetail,
  ProposalSummary,
  ProtocolView,
  RevisionWritten,
  SessionSummary,
  StoredToolResult,
  TranscriptMessage,
} from '../src/api/client.ts';
import type {
  DesignDiff,
  DesignRevision,
  DesignSummary,
  ProtocolReceipt,
} from '../shared/protocols.ts';

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
    },
    0,
  ],
];

/** One scripted turn. Gaps are what make the incremental assertion meaningful. */
async function streamTurn(res: ServerResponse): Promise<void> {
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

  for (const [event, gap] of TURN) {
    if (aborted) return;
    // The `event:` name comes off the frame's own discriminator rather than being written beside
    // it. sse-starlette sends both, and a fixture that carried two copies could disagree with
    // itself — which is a defect shape no consumer of this file could diagnose.
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (gap > 0) await sleep(gap);
  }
  res.end();
}

const SESSIONS: SessionSummary[] = [];

const SHARED_TRANSCRIPT: TranscriptMessage[] = [
  { index: 1, role: 'user', text: 'What did we decide about the ligand?', tool_calls: [] },
  {
    index: 1,
    role: 'assistant',
    text: 'BrettPhos, at 1.2 equiv base.',
    tool_calls: [{ tool: 'gather_evidence', arguments: '{"query":"ligand"}', result: '2 notes' }],
  },
];

const PROPOSAL: ProposalSummary = {
  id: 7,
  note_id: 'note-suzuki-42',
  note_type: 'reaction',
  state: 'pending',
  branch: 'agent/note-suzuki-42',
  reference: 'refs/heads/agent/note-suzuki-42',
  actor: 'chemist@example.com',
  submitted_at: '2026-08-09T10:00:00Z',
  decided_at: null,
  decided_by: '',
  reason: '',
};

const PROPOSAL_DETAIL: ProposalDetail = {
  ...PROPOSAL,
  content: '---\ntype: reaction\nconfidence: 0.8\n---\nRan in 2-MeTHF at 70 °C.',
  dependencies: [],
  session_id: SID,
  correlation_id: 'turn-e2e-2',
};

// One conversation blocked on a plan decision, so `/review` renders its inbox with a row rather
// than one of its four empty states. `unread: 0` keeps the partial-scan notice out of the way of
// the axe pass; the notice itself is covered by the component tests.
const PENDING_PLANS: PendingPlans = {
  plans: [
    {
      session_id: SID,
      title: 'Which solvent for the Suzuki step?',
      updated_at: '2026-08-09T09:00:00Z',
      plan_hash: 'e2e-plan-hash',
      plan: ['screen the hazards of 2-MeTHF', 'record the comparison as a note'],
    },
  ],
  considered: 1,
  gated: 1,
  unread: 0,
};

const JOB: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
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
  parent_revision: at - 1,
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
  // Two, so the picker has a choice to offer — with one it stays hidden.
  if (path === '/profiles') return json(res, 200, ['default', 'property-lookup']);
  if (path.endsWith('/messages') && req.method === 'GET') {
    // A shared-link session has a transcript to pull back; everything else is empty. The shape
    // is the service's: an index, and the tool calls behind each message.
    const transcript: TranscriptMessage[] = path.includes(SHARED_SID) ? SHARED_TRANSCRIPT : [];
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
    return streamTurn(res);
  }

  if (path.endsWith('/events')) {
    // A long-lived, deliberately silent job stream: the UI must not treat quiet as broken.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 5000);
    req.on('close', () => clearInterval(beat));
    return;
  }

  // The cross-session plan inbox, on the same screen as the PR gate.
  if (path === '/plans/pending' && req.method === 'GET') return json(res, 200, PENDING_PLANS);

  // The PR-gate review queue.
  if (path === '/proposals' && req.method === 'GET') return json(res, 200, [PROPOSAL]);
  if (path === '/proposals/7' && req.method === 'GET') return json(res, 200, PROPOSAL_DETAIL);
  if (path === '/proposals/7/decision' && req.method === 'POST') {
    req.resume();
    res.writeHead(204);
    return res.end();
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
      rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
    };
    return json(res, 200, status);
  }

  // Experiment protocols.
  if (path === '/protocols' && req.method === 'GET') {
    const designs: DesignSummary[] = [{ ...DESIGN_SUMMARY, head_revision: head }];
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
      summary: { ...DESIGN_SUMMARY, head_revision: head },
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
    req.resume();
    res.writeHead(204);
    return res.end();
  }

  json(res, 404, { detail: 'not found' });
  // Loopback only, matching the care `playwright.config.ts` takes to bind the BFF under test to
  // 127.0.0.1: a test fixture has no reason to be reachable from off the host, and binding
  // 0.0.0.0 would expose a stub that answers with canned data to anything on the network.
}).listen(port, '127.0.0.1', () => console.log(`fixture service on 127.0.0.1:${port}`));
