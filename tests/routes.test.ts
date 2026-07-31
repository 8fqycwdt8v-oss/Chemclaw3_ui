import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../server/routes.ts';

const SID = 'a'.repeat(32);

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
      ['GET', `/api/sessions/${SID}/plan`, `/sessions/${SID}/plan`],
      ['POST', `/api/sessions/${SID}/plan/decision`, `/sessions/${SID}/plan/decision`],
      ['GET', '/api/approvals', '/approvals'],
      ['GET', '/api/approvals/approval-q-42', '/approvals/approval-q-42'],
      ['POST', '/api/approvals/approval-q-42/decision', '/approvals/approval-q-42/decision'],
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
