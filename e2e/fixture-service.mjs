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
    ['tool_result', { type: 'tool_result', tool: 'screen_hazards', result: 'No acute hazards.' }],
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
    // A shared-link session has a transcript to pull back; everything else is empty.
    if (path.includes(SHARED_SID)) {
      return json(res, 200, [
        { role: 'user', text: 'What did we decide about the ligand?' },
        { role: 'assistant', text: 'BrettPhos, at 1.2 equiv base.' },
      ]);
    }
    return json(res, 200, []);
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
