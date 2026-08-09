/**
 * A stand-in for the Chemclaw3 service, for end-to-end tests.
 *
 * Not a fake of the agent — a fake of the *wire*. It speaks the event contract in
 * `shared/backend-contract.json`, which is generated from the real service, so the shapes here
 * cannot drift from it silently.
 *
 * It exists because a real turn needs a model credential CI does not have, and because the
 * behaviours these tests are for are frontend behaviours on a stream: that a non-terminal error
 * still yields its answer, that a failed job retracts its own promise, that tokens arrive
 * incrementally through the proxy rather than in one clump at the end. None of those need a model
 * to reproduce, and all of them are invisible to a unit test that stubs `fetch`.
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8789);
const SESSION = 'a'.repeat(32);

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
};

const frame = (res, event) => {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Space the frames out, so a test can prove nothing between here and the browser buffered them. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') return json(res, 200, { status: 'ok' });
  if (path === '/readyz') return json(res, 200, { status: 'ready', connectors: '' });
  if (path === '/profiles') return json(res, 200, ['default', 'process-chemistry']);
  if (path === '/jobs') return json(res, 200, []);
  if (path === '/proposals') return json(res, 200, []);
  if (path === '/approvals') return json(res, 200, []);
  if (path === '/sessions' && req.method === 'POST') return json(res, 200, { session_id: SESSION });
  if (path === '/sessions' && req.method === 'GET') return json(res, 200, []);
  if (path.endsWith('/messages') && req.method === 'GET') return json(res, 200, []);

  // The job push-back stream: opens, says nothing, stays open. Long silence is its normal state.
  if (path.endsWith('/events')) {
    sse(res);
    const timer = setInterval(() => res.write(': hb\n\n'), 5_000);
    req.on('close', () => clearInterval(timer));
    return;
  }

  if (path.endsWith('/messages') && req.method === 'POST') {
    const body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw));
    });
    const message = (() => {
      try {
        return JSON.parse(body).message ?? '';
      } catch {
        return '';
      }
    })();

    sse(res);

    // The scenario is chosen by what the test sends, so each spec drives the exact shape it needs.
    if (message.includes('SCENARIO:loop_cap')) {
      frame(res, { type: 'token', text: 'The pKa of acetic acid is 4.76.' });
      await sleep(80);
      // Non-terminal: the answer these tokens add up to still follows.
      frame(res, {
        type: 'error',
        message: 'The turn hit its iteration limit.',
        code: 'loop_cap_reached',
        retryable: false,
        correlation_id: 'e2ecorrelation',
      });
      await sleep(30);
      frame(res, {
        type: 'answer',
        text: 'The pKa of acetic acid is 4.76.',
        confidence: null,
        unsupported_claims: [],
        review_required: false,
        verified_by: null,
      });
      return res.end();
    }

    if (message.includes('SCENARIO:degraded')) {
      frame(res, { type: 'capability_degraded', connectors: ['eln', 'durable-jobs (Temporal)'] });
      await sleep(50);
      frame(res, { type: 'token', text: 'Answered with fewer tools.' });
      frame(res, {
        type: 'answer',
        text: 'Answered with fewer tools.',
        confidence: 0.4,
        unsupported_claims: ['the yield figure'],
        review_required: true,
        verified_by: 'citation-gate',
      });
      return res.end();
    }

    if (message.includes('SCENARIO:tool')) {
      frame(res, { type: 'tool_call', tool: 'predict_pka', arguments: '{"smiles":"CC(=O)O"}' });
      await sleep(60);
      frame(res, {
        type: 'tool_result',
        tool: 'predict_pka',
        preview: 'pKa 4.76 (predicted)',
        note_ids: ['note-17'],
        numbers: [4.76],
      });
      await sleep(30);
      frame(res, { type: 'token', text: 'It is 4.76.' });
      frame(res, {
        type: 'answer',
        text: 'It is 4.76.',
        confidence: null,
        unsupported_claims: [],
        review_required: false,
        verified_by: null,
      });
      return res.end();
    }

    // Default: an ordinary turn, streamed in spaced chunks so buffering is detectable.
    const words = ['Acetic ', 'acid ', 'has ', 'a ', 'pKa ', 'of ', '4.76.'];
    for (const word of words) {
      frame(res, { type: 'token', text: word });
      await sleep(40);
    }
    frame(res, {
      type: 'answer',
      text: words.join(''),
      confidence: 0.92,
      unsupported_claims: [],
      review_required: false,
      verified_by: 'judge',
    });
    return res.end();
  }

  json(res, 404, { detail: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock chemclaw backend on http://127.0.0.1:${PORT}`);
});
