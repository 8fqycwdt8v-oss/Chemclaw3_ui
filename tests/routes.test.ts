import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../server/routes.ts';

const SID = 'a'.repeat(32);
/** The shape `job_workflow_id` mints: `{connector}-{job}-{16 hex}`. */
const JOB = 'qm-compute_dft_energy-0123456789abcdef';
/** A tool-result ref is a SHA-256 hex digest of the result's own text: 64 lowercase hex. */
const REF = '3b'.repeat(32);

describe('proxy route whitelist', () => {
  it('resolves every route the UI actually calls', () => {
    const cases: [string, string, string][] = [
      ['GET', '/api/healthz', '/healthz'],
      ['GET', '/api/readyz', '/readyz'],
      ['POST', '/api/sessions', '/sessions'],
      ['GET', '/api/sessions', '/sessions'],
      ['GET', `/api/sessions/${SID}/messages`, `/sessions/${SID}/messages`],
      ['POST', `/api/sessions/${SID}/messages`, `/sessions/${SID}/messages`],
      ['GET', `/api/sessions/${SID}/events`, `/sessions/${SID}/events`],
      ['POST', `/api/sessions/${SID}/attachments`, `/sessions/${SID}/attachments`],
      ['GET', `/api/sessions/${SID}/tool-results/${REF}`, `/sessions/${SID}/tool-results/${REF}`],
      ['GET', `/api/sessions/${SID}/plan`, `/sessions/${SID}/plan`],
      ['POST', `/api/sessions/${SID}/plan/decision`, `/sessions/${SID}/plan/decision`],
      ['GET', '/api/approvals', '/approvals'],
      ['GET', '/api/approvals/approval-q-42', '/approvals/approval-q-42'],
      ['POST', '/api/approvals/approval-q-42/decision', '/approvals/approval-q-42/decision'],
      ['GET', '/api/jobs', '/jobs'],
      ['GET', `/api/jobs/${JOB}`, `/jobs/${JOB}`],
      ['DELETE', `/api/jobs/${JOB}`, `/jobs/${JOB}`],
      ['GET', '/api/proposals', '/proposals'],
      ['GET', '/api/proposals/41', '/proposals/41'],
      ['POST', '/api/proposals/41/decision', '/proposals/41/decision'],
      ['GET', '/api/profiles', '/profiles'],
    ];
    for (const [method, path, upstream] of cases) {
      expect(resolveRoute(method, path), `${method} ${path}`).toMatchObject({ path: upstream });
    }
  });

  it('marks exactly the two streaming routes as SSE', () => {
    expect(resolveRoute('POST', `/api/sessions/${SID}/messages`)?.sse).toBe(true);
    expect(resolveRoute('GET', `/api/sessions/${SID}/events`)?.sse).toBe(true);
    // A non-streaming route must not get the SSE header handling, or its content-length is
    // stripped for no reason.
    expect(resolveRoute('GET', `/api/sessions/${SID}/messages`)?.sse).toBe(false);
    expect(resolveRoute('POST', '/api/sessions')?.sse).toBe(false);
    // The workbench routes are all plain JSON. If one of them ever gained the SSE flag, the proxy
    // would strip its content-length for nothing — and this spec's title would be wrong.
    expect(resolveRoute('GET', '/api/jobs')?.sse).toBe(false);
    expect(resolveRoute('GET', '/api/proposals')?.sse).toBe(false);
    expect(resolveRoute('GET', '/api/profiles')?.sse).toBe(false);
    // A tool result is a single JSON document read on demand, not a stream — it is fetched from
    // the same session as the turn stream, which is the only reason it could be mistaken for one.
    expect(resolveRoute('GET', `/api/sessions/${SID}/tool-results/${REF}`)?.sse).toBe(false);
  });

  it('refuses service routes the UI has no business reaching', () => {
    // The service exposes these; an open wildcard proxy to an internal host is the real risk a
    // whitelist exists to prevent.
    for (const path of ['/api/metrics', '/api/schedules', '/api/events/knowledge-merged']) {
      expect(resolveRoute('GET', path), path).toBeNull();
      expect(resolveRoute('POST', path), path).toBeNull();
    }
  });

  it('refuses a malformed session id, which also blocks traversal', () => {
    for (const bad of [
      '/api/sessions/../../etc/passwd/messages',
      '/api/sessions/NOTHEX00000000000000000000000000/messages',
      `/api/sessions/${'a'.repeat(31)}/messages`,
      `/api/sessions/${'A'.repeat(32)}/messages`, // uppercase: uuid4().hex is lowercase
    ]) {
      expect(resolveRoute('GET', bad), bad).toBeNull();
    }
  });

  it('matches on method, so a route is not reachable by the wrong verb', () => {
    expect(resolveRoute('DELETE', `/api/sessions/${SID}/messages`)).toBeNull();
    expect(resolveRoute('POST', `/api/sessions/${SID}/events`)).toBeNull();
    // Reading the plan and deciding on it are separate routes, not one path with two verbs.
    expect(resolveRoute('POST', `/api/sessions/${SID}/plan`)).toBeNull();
    expect(resolveRoute('GET', `/api/sessions/${SID}/plan/decision`)).toBeNull();
    // A job is readable and cancellable; it is not writable, and the collection is not deletable.
    expect(resolveRoute('POST', `/api/jobs/${JOB}`)).toBeNull();
    expect(resolveRoute('DELETE', '/api/jobs')).toBeNull();
    // A proposal is decided by POSTing to its decision route, never by deleting the row: a
    // rejection IS the record, so there is nothing here that removes one.
    expect(resolveRoute('DELETE', '/api/proposals/41')).toBeNull();
    expect(resolveRoute('POST', '/api/proposals/41')).toBeNull();
    expect(resolveRoute('GET', '/api/proposals/41/decision')).toBeNull();
  });

  describe('job ids', () => {
    // Unlike an approval id, a job id is never model-written: `job_workflow_id` builds it from a
    // connector name, a job name and a hex hash, and the orchestrator's children suffix that. So
    // the pattern can stay narrow, and narrow is what makes traversal unreachable by shape.
    it.each([
      'qm-compute_dft_energy-0123456789abcdef',
      'bo-start_optimization_campaign-fedcba9876543210',
      'qm-compute_dft_energy-0123456789abcdef-round-3',
    ])('passes through an id the workflow can mint: %s', (id) => {
      expect(resolveRoute('GET', `/api/jobs/${id}`)).toMatchObject({ path: `/jobs/${id}` });
      expect(resolveRoute('DELETE', `/api/jobs/${id}`)).toMatchObject({ path: `/jobs/${id}` });
    });

    it('refuses anything outside that alphabet, so no decode step is needed', () => {
      for (const bad of [
        '/api/jobs/../../etc/passwd',
        '/api/jobs/qm..dft', // no `.` in the set at all, so `..` cannot be spelled
        '/api/jobs/qm%2Fdft', // no `%` either: an encoded separator never matches
        '/api/jobs/qm/dft',
        `/api/jobs/${'a'.repeat(129)}`,
      ]) {
        expect(resolveRoute('GET', bad), bad).toBeNull();
        expect(resolveRoute('DELETE', bad), bad).toBeNull();
      }
    });
  });

  describe('proposal ids', () => {
    it.each(['1', '41', '9223372036854775807'])('passes through a row id: %s', (id) => {
      expect(resolveRoute('GET', `/api/proposals/${id}`)).toMatchObject({
        path: `/proposals/${id}`,
      });
    });

    it('refuses a non-integer, which the route could only 422 on anyway', () => {
      for (const bad of ['/api/proposals/abc', '/api/proposals/4.1', '/api/proposals/-1']) {
        expect(resolveRoute('GET', bad), bad).toBeNull();
      }
      // Past a signed 64-bit row id — not a row any deployment holds, and the cap is what bounds
      // the match.
      expect(resolveRoute('GET', `/api/proposals/${'9'.repeat(20)}`)).toBeNull();
    });

    it('keeps the merge webhook unreachable even though it lives in the same backend module', () => {
      // `POST /events/knowledge-merged` closes proposal rows on a signed git-host webhook. A
      // browser is precisely the caller that must never reach it, so adding the proposal routes
      // must not have dragged it along.
      expect(resolveRoute('POST', '/api/events/knowledge-merged')).toBeNull();
    });
  });

  describe('tool-result refs', () => {
    // The ref is a SHA-256 hex digest and nothing else — never model-written, never user-written —
    // so the pattern is pinned to the digest's exact shape rather than to a permissive class. That
    // is `SID`'s situation, and it buys the same thing: traversal is refused by the shape of the
    // id, with no decode step in this proxy.
    it('passes through a digest', () => {
      expect(resolveRoute('GET', `/api/sessions/${SID}/tool-results/${REF}`)).toMatchObject({
        path: `/sessions/${SID}/tool-results/${REF}`,
      });
    });

    it('refuses anything that is not one', () => {
      for (const bad of [
        `/api/sessions/${SID}/tool-results/${'a'.repeat(63)}`, // one short
        `/api/sessions/${SID}/tool-results/${'a'.repeat(65)}`, // one long
        `/api/sessions/${SID}/tool-results/${'A'.repeat(64)}`, // hashlib.hexdigest() is lowercase
        `/api/sessions/${SID}/tool-results/${'g'.repeat(64)}`, // outside the hex alphabet
        `/api/sessions/${SID}/tool-results/../../../etc/passwd`,
        `/api/sessions/${SID}/tool-results/`,
        // The ref is session-scoped upstream precisely so it is not a bearer token; a bare
        // collection route would be the shape that made it one.
        `/api/tool-results/${REF}`,
      ]) {
        expect(resolveRoute('GET', bad), bad).toBeNull();
      }
    });

    it('is readable and nothing else — a stored result is not writable or deletable', () => {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        expect(resolveRoute(method, `/api/sessions/${SID}/tool-results/${REF}`), method).toBeNull();
      }
    });
  });

  describe('approval ids', () => {
    // A hold's id is `approval-{interaction_id}`, and interaction_id is supplied by the MODEL —
    // so its characters are not guaranteed the way a uuid4-hex session id's are. Each of these
    // previously 404'd at the proxy, which showed up as an Approve button that silently did
    // nothing while the approval rendered fine in the trace panel.
    const reachable = [
      'approval-q-42',
      'approval-9f2c1a',
      'approval-interaction_7',
      'approval-ns:batch.7',
    ];
    it.each(reachable)('passes through a plain id: %s', (id) => {
      const encoded = encodeURIComponent(id);
      expect(resolveRoute('POST', `/api/approvals/${encoded}/decision`)).toMatchObject({
        path: `/approvals/${encoded}/decision`,
      });
    });

    // Ids the client's encodeURIComponent genuinely rewrites, so the segment reaching the proxy
    // contains `%` escapes.
    it.each(['approval-q 42', 'approval-batch/7', 'approval-a+b', 'approval-#7'])(
      'passes through a percent-escaped id: %s',
      (id) => {
        const encoded = encodeURIComponent(id);
        expect(encoded).toContain('%'); // the case only has teeth if escaping happened
        expect(resolveRoute('POST', `/api/approvals/${encoded}/decision`)).toMatchObject({
          path: `/approvals/${encoded}/decision`,
        });
        expect(resolveRoute('GET', `/api/approvals/${encoded}`)).toMatchObject({
          path: `/approvals/${encoded}`,
        });
      },
    );

    // encodeURIComponent leaves !~*'() alone, so these arrive literally. Adding only `%` to the
    // pattern would still have refused them — which is exactly the bug this test exists for.
    it.each(["approval-Suzuki(A)", "approval-run*2", "approval-o'brien", 'approval-x!y~z'])(
      'passes through an id encodeURIComponent does not escape: %s',
      (id) => {
        expect(encodeURIComponent(id)).toBe(id); // unchanged, so the raw characters must match
        expect(resolveRoute('POST', `/api/approvals/${id}/decision`)).toMatchObject({
          path: `/approvals/${id}/decision`,
        });
      },
    );

    it('still refuses an id with a raw path separator or over the length cap', () => {
      // A raw (unencoded) slash would change the route's shape, not just its parameter.
      expect(resolveRoute('GET', '/api/approvals/approval-a/b')).toBeNull();
      expect(resolveRoute('GET', `/api/approvals/${'a'.repeat(129)}`)).toBeNull();
    });
  });
});
