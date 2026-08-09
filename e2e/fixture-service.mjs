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
 *   node e2e/fixture-service.mjs [port]
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4322);
const SID = 'a'.repeat(32);
/** A session a shared link can point at, with a transcript behind it. */
const SHARED_SID = 'b'.repeat(32);
/** The content address of the stored hazard screen below — 64 hex chars, as the service mints. */
const RESULT_REF = 'c'.repeat(64);

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

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One scripted turn. Gaps are what make the incremental assertion meaningful. */
async function streamTurn(req, res) {
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

  const frames = [
    ['plan', { type: 'plan', todos: ['Check the hazard profile', 'Estimate the pKa'] }],
    ['tool_call', { type: 'tool_call', tool: 'screen_hazards', arguments: '{"smiles":"CCO"}' }],
    [
      'tool_result',
      {
        type: 'tool_result',
        tool: 'screen_hazards',
        // `preview`, not `result` — the field is named for what it is, and it is truncated. The
        // ref is how the browser reaches the rest.
        preview: JSON.stringify(HAZARD_RESULT).slice(0, 200),
        result_ref: RESULT_REF,
        note_ids: [],
        numbers: [],
      },
    ],
    ['token', { type: 'token', text: 'The pKa of acetic acid ' }],
    ['token', { type: 'token', text: 'is about 4.76 ' }],
    ['token', { type: 'token', text: 'in water at 25 °C.' }],
    [
      'answer',
      {
        type: 'answer',
        text: 'The pKa of acetic acid is about 4.76 in water at 25 °C.',
        confidence: 0.91,
        review_required: false,
        unsupported_claims: [],
        verified_by: 'citation-gate',
      },
    ],
  ];

  for (const [event, data] of frames) {
    if (aborted) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    await sleep(220);
  }
  res.end();
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz' || path === '/readyz') return json(res, 200, { ok: true });
  if (path === '/sessions' && req.method === 'POST') return json(res, 200, { session_id: SID });
  if (path === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [] });
  if (path.endsWith('/messages') && req.method === 'GET') {
    // A shared-link session has a transcript to pull back; everything else is empty. The shape
    // is the service's: an index, and the tool calls behind each message.
    if (path.includes(SHARED_SID)) {
      return json(res, 200, [
        {
          index: 0,
          role: 'user',
          text: 'What did we decide about the ligand?',
          tool_calls: [],
        },
        {
          index: 1,
          role: 'assistant',
          text: 'BrettPhos, at 1.2 equiv base.',
          tool_calls: [
            { tool: 'gather_evidence', arguments: '{"query":"ligand"}', result: '2 notes' },
          ],
        },
      ]);
    }
    return json(res, 200, []);
  }

  // The untruncated result behind the ref the turn streamed.
  if (path.includes('/tool-results/') && req.method === 'GET') {
    const ref = path.split('/tool-results/')[1];
    if (ref !== RESULT_REF) return json(res, 404, { detail: 'unknown result' });
    const text = JSON.stringify(HAZARD_RESULT);
    return json(res, 200, {
      ref,
      tool: 'screen_hazards',
      correlation_id: 'turn-e2e-1',
      byte_size: text.length,
      text,
    });
  }

  // One knowledge note, so a citation chip resolves instead of prefilling a question.
  if (path.startsWith('/notes/') && req.method === 'GET') {
    return json(res, 200, {
      note: {
        id: decodeURIComponent(path.slice('/notes/'.length)),
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
  }

  if (path.endsWith('/messages') && req.method === 'POST') {
    // Drain the request body before replying, as the real service does.
    req.resume();
    if (url.searchParams.get('fail') === 'capacity') {
      return json(res, 503, { detail: 'at capacity' });
    }
    return streamTurn(req, res);
  }

  if (path.endsWith('/events')) {
    // A long-lived, deliberately silent job stream: the UI must not treat quiet as broken.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 5000);
    req.on('close', () => clearInterval(beat));
    return;
  }

  json(res, 404, { detail: 'not found' });
}).listen(port, () => console.log(`fixture service on :${port}`));
