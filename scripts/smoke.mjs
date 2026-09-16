/**
 * End-to-end smoke test against a REAL Chemclaw service.
 *
 * Drives the whole chain — health, session creation, one streamed turn — and, critically, asserts
 * that frames arrive INCREMENTALLY. A stream that arrives correct but all at once at the end means
 * something in the chain is buffering (a compression middleware, an ingress, a proxy default), and
 * that is invisible to any test that only checks the final answer.
 *
 *   node scripts/smoke.mjs [baseUrl] [message]
 *
 * Defaults to the BFF on http://127.0.0.1:8787. Point it at the UI container
 * (http://localhost:3000) to exercise the production path.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const message = process.argv[3] ?? 'What is the pKa of acetic acid? Answer in one sentence.';
const token = process.env.ACCESS_TOKEN;

const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

let failures = 0;
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log(`\nChemclaw3 UI smoke test against ${base}\n`);

// 1. Health.
try {
  const res = await fetch(`${base}/api/healthz`);
  if (res.ok) ok('GET /api/healthz');
  else bad('GET /api/healthz', `status ${res.status}`);
} catch (err) {
  bad('GET /api/healthz', err.message);
  console.error('\nIs the UI server running, and can it reach CHEMCLAW_API_URL?\n');
  process.exit(1);
}

// 2. Route whitelist: something the BFF must refuse without contacting the backend.
{
  const res = await fetch(`${base}/api/metrics`);
  if (res.status === 404) ok('un-whitelisted /api/metrics is blocked by the UI server');
  else bad('un-whitelisted /api/metrics', `expected 404, got ${res.status}`);
}

// 3. Runtime config.
{
  const res = await fetch(`${base}/config.js`);
  const body = await res.text();
  if (res.ok && body.includes('__CHEMCLAW_CONFIG__')) ok('GET /config.js');
  else bad('GET /config.js', `status ${res.status}`);
}

// 4. Create a session.
let sessionId;
{
  const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: authHeaders });
  if (!res.ok) {
    bad('POST /api/sessions', `status ${res.status}`);
    console.error('\nCannot continue without a session.\n');
    process.exit(1);
  }
  sessionId = (await res.json()).session_id;
  ok('POST /api/sessions', sessionId);
}

// 5. Stream one turn, recording arrival times.
{
  const started = Date.now();
  const arrivals = [];
  const seen = new Set();
  let answer = null;

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders },
    body: JSON.stringify({ message, dry_run: false }),
  });

  if (!res.ok) {
    bad('POST /api/sessions/:id/messages', `status ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) ok('response is text/event-stream');
  else bad('response content-type', contentType);

  if (res.headers.get('x-accel-buffering') === 'no') ok('x-accel-buffering: no is set');
  else bad('x-accel-buffering', 'missing — an nginx-style ingress may buffer this stream');

  // Framing is `eventsource-parser`'s, not this file's. `src/lib/sse.ts` already states why that
  // matters — multi-line `data:`, comment frames, CRLF and frames split across chunk boundaries —
  // and this script used to hand-roll an `indexOf('\n\n')` loop that handled none of them. It
  // survived only because the BFF's heartbeat (`: hb\n\n`, server/proxy.ts) happens to have no
  // `data:` line, so `.find(l => l.startsWith('data:'))` returned undefined and the frame was
  // skipped by accident rather than by design.
  //
  // It also makes the buffering assertion below honest: `arrivals` now counts one entry per real
  // SSE event, where the old loop counted one per `\n\n` — so a heartbeat used to be indistinguishable
  // from a frame, and a stream held and released in one go alongside heartbeats could pass.
  const stream = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  for await (const frame of stream) {
    if (!frame.data) continue; // an event name with no payload: a frame, but not an event
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      continue; // one malformed frame is a blip, not a reason to abandon a good stream
    }
    seen.add(event.type);
    arrivals.push(Date.now() - started);
    if (event.type === 'answer') answer = event;
    if (event.type === 'error') bad('stream error event', event.message);
  }

  ok('event types seen', [...seen].join(', ') || 'none');

  if (answer) ok('terminal answer received', `${answer.text.length} chars`);
  else bad('terminal answer', 'stream ended without an answer event');

  // The buffering check: if every event landed within a few ms of the last one, the stream was
  // held and released in one go rather than streamed. Heartbeat comments are not counted — the
  // parser does not surface them — so this measures the service producing, not the proxy padding.
  if (arrivals.length >= 3) {
    const spread = arrivals.at(-1) - arrivals[0];
    if (spread > 50)
      ok('frames arrived incrementally', `${spread}ms spread over ${arrivals.length} events`);
    else
      bad('frames arrived all at once', `${spread}ms spread — something is buffering the stream`);
  } else {
    console.log(`  · only ${arrivals.length} event(s); cannot judge buffering`);
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
