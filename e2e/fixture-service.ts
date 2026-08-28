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
  ProposalDetail,
  ProposalSummary,
  SessionSummary,
  StoredToolResult,
  TranscriptMessage,
} from '../src/api/client.ts';

const port = Number(process.argv[2] ?? 4322);
const SID = 'a'.repeat(32);
/** A session a shared link can point at, with a transcript behind it. */
const SHARED_SID = 'b'.repeat(32);
/** The content address of the stored hazard screen below — 64 hex chars, as the service mints. */
const RESULT_REF = 'c'.repeat(64);
/** A second stored result, of a different SHAPE — which is what the renderer registry dispatches
 *  on, so one payload per shape is what stops a renderer shipping green and broken. */
const VALUES_REF = 'd'.repeat(64);

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
 * Fourteen frames covering ten of the seventeen event types, where this used to carry five — and
 * two stored results of DIFFERENT SHAPES, because the renderer registry dispatches on shape and a
 * fixture carrying one payload proves one renderer. The
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
  { index: 0, role: 'user', text: 'What did we decide about the ligand?', tool_calls: [] },
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

const JOB: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
  completed_at: '2026-08-01T09:00:00Z',
};

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
    if (ref !== RESULT_REF && ref !== VALUES_REF) {
      return json(res, 404, { detail: 'unknown result' });
    }
    const hazard = ref === RESULT_REF;
    const text = JSON.stringify(hazard ? HAZARD_RESULT : PKA_RESULT);
    const stored: StoredToolResult = {
      ref,
      tool: hazard ? 'screen_hazards' : 'predict_pka',
      correlation_id: 'turn-e2e-1',
      byte_size: text.length,
      text,
    };
    return json(res, 200, stored);
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

  json(res, 404, { detail: 'not found' });
  // Loopback only, matching the care `playwright.config.ts` takes to bind the BFF under test to
  // 127.0.0.1: a test fixture has no reason to be reachable from off the host, and binding
  // 0.0.0.0 would expose a stub that answers with canned data to anything on the network.
}).listen(port, '127.0.0.1', () => console.log(`fixture service on 127.0.0.1:${port}`));
