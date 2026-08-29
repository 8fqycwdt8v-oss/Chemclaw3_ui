import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../server/routes.ts';

const SID = 'a'.repeat(32);
/** A stored result's ref is the SHA-256 hex digest of the result text: 64 lowercase hex chars. */
const REF = 'b'.repeat(64);
/** A design id is `design-` plus twelve lowercase hex characters, and nothing else. */
const DESIGN = 'design-0123456789ab';

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
      ['GET', '/api/plans/pending', '/plans/pending'],
      ['GET', `/api/sessions/${SID}/tool-results/${REF}`, `/sessions/${SID}/tool-results/${REF}`],
      ['GET', '/api/notes/note-suzuki-42', '/notes/note-suzuki-42'],
      ['GET', '/api/profiles', '/profiles'],
      ['GET', '/api/proposals', '/proposals'],
      ['GET', '/api/proposals/42', '/proposals/42'],
      ['POST', '/api/proposals/42/decision', '/proposals/42/decision'],
      ['GET', '/api/jobs', '/jobs'],
      ['GET', '/api/jobs/qm-7', '/jobs/qm-7'],
      ['DELETE', '/api/jobs/qm-7', '/jobs/qm-7'],
      ['GET', '/api/protocols', '/protocols'],
      ['GET', `/api/protocols/${DESIGN}`, `/protocols/${DESIGN}`],
      ['POST', `/api/protocols/${DESIGN}/revisions`, `/protocols/${DESIGN}/revisions`],
      ['GET', `/api/protocols/${DESIGN}/diff`, `/protocols/${DESIGN}/diff`],
      ['POST', `/api/protocols/${DESIGN}/status`, `/protocols/${DESIGN}/status`],
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

  it('does not proxy the deleted approval-hold routes', () => {
    // `D-2026-08-27-a-hold-nothing-can-open-is-not-a-hold` deleted `GET /approvals`,
    // `GET /approvals/{id}` and `POST /approvals/{id}/decision` from the service: nothing could
    // ever open a hold, so the three consumers were a control that read as real and was not.
    // Whitelisting them again would proxy straight to a 404 and re-teach the whole shape — the
    // Approve button that silently does nothing, which is worse than no button at all.
    for (const [method, path] of [
      ['GET', '/api/approvals'],
      ['GET', '/api/approvals/approval-q-42'],
      ['POST', '/api/approvals/approval-q-42/decision'],
    ] as const) {
      expect(resolveRoute(method, path), `${method} ${path}`).toBeNull();
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
    // The inbox is a read. A decision is answered on the session that raised it, and a POST here
    // would be a decision with no session named in the path — which is not a route the service
    // has, and must not become a path this proxy invents.
    expect(resolveRoute('POST', '/api/plans/pending')).toBeNull();
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
    // A note id is `note-{slug}`, and the slug comes
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

  describe('experiment protocols', () => {
    it('takes a design id as `design-` plus twelve lowercase hex, and nothing else', () => {
      // As narrow as a session id and for the same reason: the service mints the whole string, so
      // there is nothing here this repo does not own — unlike a note id, whose slug is a name the
      // model wrote, or a job id, which embeds a workflow id this repo cannot pin. That narrowness
      // is also the traversal protection: a segment matching it holds no separator and no escape.
      for (const bad of [
        'design-0123456789AB', // uppercase
        'design-0123456789a', // eleven
        'design-0123456789abc', // thirteen
        'design_0123456789ab',
        '0123456789ab',
        'design-../../etc/passwd',
        `design-${'0'.repeat(12)}/extra`,
      ]) {
        expect(resolveRoute('GET', `/api/protocols/${bad}`), bad).toBeNull();
      }
    });

    it('offers each protocol route by one verb only', () => {
      // A revision is written by POSTing to the collection; a design is read by GET. Nothing here
      // deletes: a design is retired by a status move, which records who did it and why, where a
      // DELETE would take the revision history of a document somebody may have run with.
      for (const [method, path] of [
        ['POST', `/api/protocols/${DESIGN}`],
        ['DELETE', `/api/protocols/${DESIGN}`],
        ['PUT', `/api/protocols/${DESIGN}`],
        ['DELETE', `/api/protocols/${DESIGN}/revisions`],
        ['GET', `/api/protocols/${DESIGN}/revisions`],
        ['GET', `/api/protocols/${DESIGN}/status`],
        ['POST', `/api/protocols/${DESIGN}/diff`],
        ['POST', '/api/protocols'],
      ] as const) {
        expect(resolveRoute(method, path), `${method} ${path}`).toBeNull();
      }
    });

    it('refuses a protocol path that is not one of the five', () => {
      // The whitelist is the whole boundary. A sub-path this UI never calls must not be reachable
      // just because its prefix is, which is exactly what a `startsWith('/api/protocols')` proxy
      // would have given away.
      for (const path of [
        `/api/protocols/${DESIGN}/export`,
        `/api/protocols/${DESIGN}/revisions/3`,
        '/api/protocols/all',
        '/api/protocols/../jobs',
      ]) {
        expect(resolveRoute('GET', path), path).toBeNull();
      }
    });

    it('labels a design route by its shape, never by the design it names', () => {
      // A per-design metric label mints a time series per document, which is the same leak the
      // session id gets its `{id}` for.
      expect(resolveRoute('GET', `/api/protocols/${DESIGN}/diff`)?.template).toBe(
        '/protocols/{id}/diff',
      );
    });
  });
});
