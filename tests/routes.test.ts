import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../server/routes.ts';

const SID = 'a'.repeat(32);
/** A stored result's ref is the SHA-256 hex digest of the result text: 64 lowercase hex chars. */
const REF = 'b'.repeat(64);

describe('proxy route whitelist', () => {
  it('resolves every route the UI actually calls', () => {
    const cases: [string, string, string][] = [
      ['GET', '/api/healthz', '/healthz'],
      ['GET', '/api/readyz', '/readyz'],
      ['POST', '/api/sessions', '/sessions'],
      ['GET', '/api/sessions', '/sessions'],
      ['GET', `/api/sessions/${SID}/messages`, `/sessions/${SID}/messages`],
      ['POST', `/api/sessions/${SID}/messages`, `/sessions/${SID}/messages`],
      ['POST', `/api/sessions/${SID}/turn/stop`, `/sessions/${SID}/turn/stop`],
      ['GET', `/api/sessions/${SID}/events`, `/sessions/${SID}/events`],
      ['POST', `/api/sessions/${SID}/attachments`, `/sessions/${SID}/attachments`],
      ['GET', `/api/sessions/${SID}/plan`, `/sessions/${SID}/plan`],
      ['POST', `/api/sessions/${SID}/plan/decision`, `/sessions/${SID}/plan/decision`],
      ['GET', '/api/approvals', '/approvals'],
      ['GET', '/api/approvals/approval-q-42', '/approvals/approval-q-42'],
      ['POST', '/api/approvals/approval-q-42/decision', '/approvals/approval-q-42/decision'],
      ['GET', `/api/sessions/${SID}/tool-results/${REF}`, `/sessions/${SID}/tool-results/${REF}`],
      ['GET', '/api/notes/note-suzuki-42', '/notes/note-suzuki-42'],
      ['GET', '/api/profiles', '/profiles'],
      ['GET', '/api/proposals', '/proposals'],
      ['GET', '/api/proposals/42', '/proposals/42'],
      ['POST', '/api/proposals/42/decision', '/proposals/42/decision'],
      ['GET', '/api/jobs', '/jobs'],
      ['GET', '/api/jobs/qm-7', '/jobs/qm-7'],
      ['DELETE', '/api/jobs/qm-7', '/jobs/qm-7'],
    ];
    for (const [method, path, upstream] of cases) {
      expect(resolveRoute(method, path), `${method} ${path}`).toMatchObject({ path: upstream });
    }
  });

  it('leaves no document claiming the stop route does not exist', () => {
    // `D-2026-08-27-a-disconnect-is-a-detach-not-a-stop` replaced the mechanism, and the code
    // followed it the same day — but `README.md` and the comment on `res.on('close')` in
    // `server/proxy.ts` went on describing the old one for a release: "the service has no cancel
    // endpoint, so propagating the disconnect is the only way it releases the session's turn
    // lock". Both are the places a reader goes to learn how Stop works, so both were teaching the
    // superseded contract while the route sat in the whitelist above.
    //
    // This catches that sentence, not every way of writing it. It is worth having anyway: the
    // claim is load-bearing and its exact phrasing is what survived a rewrite of the code beneath
    // it.
    expect(resolveRoute('POST', `/api/sessions/${SID}/turn/stop`)).not.toBeNull();
    for (const file of ['README.md', 'server/proxy.ts']) {
      // Whitespace-collapsed, because both places wrap prose: in `README.md` the claim ran
      // across a line break as "has\n  no cancel endpoint", which a literal-space pattern reads
      // as absent.
      const prose = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      expect(prose, file).not.toMatch(/(is|has) no cancel endpoint/);
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
    it.each(['approval-Suzuki(A)', 'approval-run*2', "approval-o'brien", 'approval-x!y~z'])(
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

  describe('tool-result refs', () => {
    // Narrower than every other id here, and it can be: the ref is defined upstream as the
    // SHA-256 of the result text, so the set is exactly 64 lowercase hex characters. That
    // narrowness is the same structural traversal protection the session id gets.
    it('refuses anything that is not a 64-char lowercase hex digest', () => {
      for (const bad of [
        'b'.repeat(63),
        'b'.repeat(65),
        'B'.repeat(64),
        `${'b'.repeat(60)}../x`,
        'not-a-digest',
      ]) {
        expect(resolveRoute('GET', `/api/sessions/${SID}/tool-results/${bad}`), bad).toBeNull();
      }
    });

    it('is scoped to a session, so a bare ref is not a route at all', () => {
      // Upstream, the session is the authorization: a ref names bytes, the link names whose
      // conversation produced them. A `/tool-results/{ref}` with no session would have to invent
      // an auth story, and does not exist on either side.
      expect(resolveRoute('GET', `/api/tool-results/${REF}`)).toBeNull();
    });
  });

  describe('note ids', () => {
    // Same argument as approval ids, same cause: a note id is `note-{slug}` and the slug comes
    // from whatever the note is about, which for a compound note is a name the model wrote.
    it.each(['note-suzuki-42', 'note-2-MeTHF', "note-o'brien", 'note-Pd(OAc)2'])(
      'passes through %s',
      (id) => {
        const encoded = encodeURIComponent(id);
        expect(resolveRoute('GET', `/api/notes/${encoded}`)).toMatchObject({
          path: `/notes/${encoded}`,
        });
      },
    );

    it('refuses a raw separator, an over-long id, and the wrong verb', () => {
      expect(resolveRoute('GET', '/api/notes/note-a/b')).toBeNull();
      expect(resolveRoute('GET', `/api/notes/${'n'.repeat(129)}`)).toBeNull();
      // The graph is written through the PR gate, never by a client PUT.
      expect(resolveRoute('POST', '/api/notes/note-1')).toBeNull();
      expect(resolveRoute('DELETE', '/api/notes/note-1')).toBeNull();
    });
  });

  describe('proposals and jobs', () => {
    it('takes a proposal id as a number and nothing else', () => {
      // Upstream it is a bigserial. Anything else is a client bug, and a pattern that accepted
      // a slug would forward a path segment the service cannot look up.
      for (const bad of ['note-1', '4.2', '-1', '', '1'.repeat(20)]) {
        expect(resolveRoute('GET', `/api/proposals/${bad}`), bad).toBeNull();
      }
    });

    it('does not offer a verb the gate does not have', () => {
      // Decisions go through POST /decision. A PUT or DELETE on a proposal would be a way to
      // close the gate without recording who closed it.
      expect(resolveRoute('DELETE', '/api/proposals/42')).toBeNull();
      expect(resolveRoute('POST', '/api/proposals/42')).toBeNull();
      expect(resolveRoute('POST', '/api/proposals')).toBeNull();
    });

    it('reaches a job by both of its verbs, and refuses a raw separator', () => {
      // GET reads it, DELETE asks for cancellation. The role gate is upstream: refusing to proxy
      // DELETE would break the caller who *is* entitled to use it.
      expect(resolveRoute('GET', '/api/jobs/calc-Suzuki(A)')).toMatchObject({
        path: '/jobs/calc-Suzuki(A)',
      });
      expect(resolveRoute('DELETE', '/api/jobs/a/b')).toBeNull();
      expect(resolveRoute('DELETE', `/api/jobs/${'j'.repeat(129)}`)).toBeNull();
    });
  });
});
