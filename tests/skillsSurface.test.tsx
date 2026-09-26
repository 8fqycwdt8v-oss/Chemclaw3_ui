/**
 * The half of a bargain the service has been claiming, from the browser.
 *
 * `D-2026-09-05-the-gate-follows-behaviour-not-knowledge` grants the two stored skills tiers their
 * exemption from per-use review *on the condition* that the people they act on can see what they
 * say and get rid of them. Until these screens existed the only thing that could exercise that was
 * `curl`, so `ARCHITECTURE.md` and `SECURITY.md` were describing a control nobody could reach.
 *
 * **Two things this file is really about.**
 *
 * The first is the failure this page has had twice: *an empty list must never read as "nothing is
 * waiting on you" unless that is what the service said.* Both deleted sections got it wrong the
 * same way — a list route 404s, the client folds it into `[]`, and a confident empty queue ships
 * for a release. The proposals tier answers **503** where a deployment keeps no store, which is a
 * different fact from an empty queue, so both are driven separately here.
 *
 * The second is that a **revert puts back the bytes that stood before** rather than whatever
 * somebody retypes. The service holds the history for exactly that reason, and a surface that
 * showed the hashes without the bodies would be asking for a decision about something unseen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { BehaviourProposals } from '../src/components/BehaviourProposals.tsx';
import { SkillsPanel } from '../src/components/SkillsPanel.tsx';
import { stubFetch } from './helpers.ts';
import { resetQueryCache } from '../src/api/queryClient.ts';

const mode = { current: 'dev' as 'dev' | 'msal', roles: [] as string[], ready: true };

vi.mock('../src/auth/AuthContext.tsx', async () => {
  const { config } = await import('../src/env.ts');
  const auth = {
    getAccessToken: async () => null,
    get mode() {
      return mode.current;
    },
    get account() {
      return { id: 'u', username: 'u', name: 'u', roles: mode.roles };
    },
  };
  const value = {
    auth,
    get ready() {
      return mode.ready;
    },
    revision: 0,
  };
  return {
    useAuth: () => value,
    // The real implementation over the stub above, for `reviewQueue.test.tsx`'s reason: mocking
    // the gate away would test nothing, and this file's last case is about the gate.
    useIsReviewer: () =>
      mode.current === 'dev' || config.reviewerRoles.some((r) => mode.roles.includes(r)),
  };
});

const BODY = '---\nname: my-workup\ndescription: how I work up a Suzuki\n---\n\nQuench cold.\n';
const OLDER = '---\nname: house-workup\ndescription: the one that worked\n---\n\nQuench cold.\n';
const NEWER = '---\nname: house-workup\ndescription: the one that did not\n---\n\nQuench hot.\n';

let restore: (() => void) | null = null;

/** Every route these screens touch, answered from one place so a test changes one line. */
function serve(
  routes: Record<string, () => Response>,
  onCall?: (url: string, init?: RequestInit) => void,
): { calls: { url: string; init?: RequestInit }[] } {
  const stub = stubFetch((url, init) => {
    onCall?.(url, init);
    // Longest match first: `/skills/org` is a prefix of `/skills/org/<name>/versions`, and
    // `reviewQueue.test.tsx` records what answering the short one first costs.
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((route) => url.includes(route));
    if (key) return routes[key]!();
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  restore = stub.restore;
  return stub;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  cleanup();
  mode.current = 'dev';
  mode.roles = [];
  mode.ready = true;
  resetQueryCache();
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe('proposals waiting on a person', () => {
  it('shows the whole document, because that is what is being decided', async () => {
    serve({
      '/proposals': () =>
        json({
          proposals: [
            {
              kind: 'skill',
              name: 'my-workup',
              content_hash: 'hash-1',
              content: BODY,
              rationale: 'This went wrong the same way twice.',
              state: 'open',
              session_id: 'a'.repeat(32),
            },
          ],
        }),
    });
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    expect(await screen.findByText('my-workup')).toBeTruthy();
    expect(screen.getByText('This went wrong the same way twice.')).toBeTruthy();
    // The body itself, not a summary of it: the service returns it whole so nobody approves
    // something unseen, and a screen that hid it would give that away.
    expect(screen.getByText(/Quench cold\./)).toBeTruthy();
  });

  it('binds the decision to the document it showed', async () => {
    const seen: RequestInit[] = [];
    serve(
      {
        '/proposals': () =>
          json({
            proposals: [
              {
                kind: 'skill',
                name: 'my-workup',
                content_hash: 'hash-1',
                content: BODY,
                rationale: 'why',
                state: 'open',
                session_id: '',
              },
            ],
          }),
      },
      (url, init) => {
        if (init?.method === 'POST' && url.includes('/proposals/')) seen.push(init);
      },
    );
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Keep this skill/ }));

    await waitFor(() => expect(seen).toHaveLength(1));
    // `content_hash` is the point: a decision naming only the name would authorize whatever that
    // name currently holds, and the proposer can supersede between the read and the click.
    expect(JSON.parse(String(seen[0]!.body))).toMatchObject({
      content_hash: 'hash-1',
      accepted: true,
    });
  });

  it('tells a chemist at the row cap why the proposal stayed open', async () => {
    // One of four 409s the accept can answer — already decided, superseded, a shipped name, the
    // row cap — and only the service knows which. This rendered a fixed "already decided" for all
    // four, so a chemist at the cap was told the wrong thing and never learned the remedy.
    const cap =
      'you keep 8 personal skills, the most this deployment allows: every one is in the prompt of every turn you take. Remove one first.';
    serve({
      '/proposals/skill/my-workup': () => json({ detail: cap }, 409),
      '/proposals': () =>
        json({
          proposals: [
            {
              kind: 'skill',
              name: 'my-workup',
              content_hash: 'hash-1',
              content: BODY,
              rationale: 'why',
              state: 'open',
              session_id: '',
            },
          ],
        }),
    });
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Keep this skill/ }));

    expect(await screen.findByText(cap)).toBeTruthy();
    expect(screen.queryByText(/already been decided/i)).toBeNull();
  });

  it('says a deployment keeps no proposals rather than showing an empty queue', async () => {
    serve({ '/proposals': () => json({ detail: 'no store' }, 503) });
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    // The failure this page has shipped twice, in the one place it could ship again.
    expect(await screen.findByText(/keeps no proposals/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing proposed/i)).toBeNull();
    expect(screen.getByText(/CHEMCLAW_AGENT_MEMORY_ENABLED/)).toBeTruthy();
  });

  it('says nothing is proposed when that is what the service said', async () => {
    serve({ '/proposals': () => json({ proposals: [] }) });
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Nothing proposed/i)).toBeTruthy();
    expect(screen.queryByText(/keeps no proposals/i)).toBeNull();
  });
});

describe('what is acting on a chemist', () => {
  function serveSkills(extra: Record<string, () => Response> = {}): void {
    serve({
      '/skills/mine': () => json({ skills: ['my-workup'] }),
      '/skills/org': () => json({ skills: ['house-workup'] }),
      ...extra,
    });
  }

  it('lists both tiers and says which reaches whom', async () => {
    serveSkills();
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByText('my-workup')).toBeTruthy();
    expect(await screen.findByText('house-workup')).toBeTruthy();
    // The two bargains named, because a reader who cannot tell them apart cannot use either.
    expect(screen.getByText(/Acting on your turns and nobody else's/i)).toBeTruthy();
    expect(screen.getByText(/every turn every chemist here takes/i)).toBeTruthy();
  });

  it('removes one of the chemist’s own, which is the condition the tier is exempted under', async () => {
    const deletes: string[] = [];
    serve(
      {
        '/skills/mine': () => json({ skills: ['my-workup'] }),
        '/skills/org': () => json({ skills: [] }),
      },
      (url, init) => {
        if (init?.method === 'DELETE') deletes.push(url);
      },
    );
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Remove/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));

    await waitFor(() => expect(deletes.some((url) => url.includes('/skills/mine/'))).toBe(true));
  });

  /** A stub that answers the personal tier's list and its save separately — one URL, two methods. */
  function serveSave(save: (body: string) => Response): { posted: string[] } {
    const posted: string[] = [];
    restore = stubFetch((url, init) => {
      if (url.includes('/skills/mine') && init?.method === 'POST') {
        const body = String(JSON.parse(String(init.body)).body);
        posted.push(body);
        return save(body);
      }
      if (url.includes('/skills/mine')) return json({ skills: [] });
      if (url.includes('/skills/org')) return json({ skills: [] });
      return json({});
    }).restore;
    return { posted };
  }

  it('writes one for yourself, which is where a declined proposal is sent', async () => {
    // The decline dialog says "write it yourself on the skills screen", and until this there was
    // nowhere to write it. The document goes up whole, as pasted.
    const { posted } = serveSave(() => json({ name: 'my-workup', body: BODY }));
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText(/Your skill, as a whole SKILL.md/), {
      target: { value: BODY },
    });
    fireEvent.click(screen.getByRole('button', { name: /Keep it/ }));

    expect(await screen.findByText(/Kept my-workup\./)).toBeTruthy();
    expect(posted).toEqual([BODY]);
  });

  it('shows why a save was refused, in the service’s words', async () => {
    // A name a shipped skill already uses is a 409 whose detail names the collision; rewording it
    // here would lose the one fact the chemist needs, which is what to rename.
    const shipped =
      'a skill this deployment ships is already called my-workup; choose another name';
    serveSave(() => json({ detail: shipped }, 409));
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText(/Your skill, as a whole SKILL.md/), {
      target: { value: BODY },
    });
    fireEvent.click(screen.getByRole('button', { name: /Keep it/ }));

    expect(await screen.findByText(shipped)).toBeTruthy();
  });

  it('offers a revert that names the bytes it would put back', async () => {
    const posts: { url: string; body: unknown }[] = [];
    serve(
      {
        '/skills/mine': () => json({ skills: [] }),
        '/skills/org': () => json({ skills: ['house-workup'] }),
        '/skills/org/house-workup/versions': () =>
          json({
            versions: [
              {
                content_hash: 'hash-new',
                body: NEWER,
                activated_by: 'u-admin',
                activated_at: '2026-09-20T09:00:00Z',
              },
              {
                content_hash: 'hash-old',
                body: OLDER,
                activated_by: 'u-admin',
                activated_at: '2026-09-19T09:00:00Z',
              },
            ],
          }),
      },
      (url, init) => {
        if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
      },
    );
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText(/What it used to say/i));

    // The bodies are on screen, not just their hashes: a revert decided from a digest alone is a
    // decision about something unseen, which is the shape the service's own schema refuses.
    expect(await screen.findByText(/Quench cold\./)).toBeTruthy();
    expect(screen.getByText(/Quench hot\./)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /Put this back/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Revert$/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/skills/org/house-workup/revert');
    // The *older* hash, which is the one whose body the reader was shown.
    expect(posts[0]!.body).toMatchObject({ content_hash: 'hash-old' });
  });

  it('does not offer the write half to somebody without the role', async () => {
    mode.current = 'msal';
    mode.roles = [];
    serve({
      '/skills/mine': () => json({ skills: [] }),
      '/skills/org': () => json({ skills: ['house-workup'] }),
    });
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    // Reads stay open — deliberately, because this tier acts on people who did not approve it.
    expect(await screen.findByText('house-workup')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retire/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull();
  });

  it('says a deployment keeps no stored skills rather than showing an empty tier', async () => {
    serve({
      '/skills/mine': () => json({ detail: 'no store' }, 503),
      '/skills/org': () => json({ detail: 'no store' }, 503),
    });
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText(/CHEMCLAW_AGENT_MEMORY_ENABLED/)).toHaveLength(2);
    expect(screen.queryByText(/You keep none/i)).toBeNull();
    expect(screen.queryByText(/Nothing published/i)).toBeNull();
  });
});

describe('reads that wait for a token', () => {
  it('does not ask before auth is ready, and loads once it is', async () => {
    // Mounted before the token existed, every read here failed `token_unavailable` and — with
    // `retry: false` and a key auth does not change — stayed failed until the page was left.
    mode.ready = false;
    const { calls } = serve({
      '/skills/mine': () => json({ skills: ['my-workup'] }),
      '/skills/org': () => json({ skills: ['house-workup'] }),
      '/proposals': () => json({ proposals: [] }),
    });
    // A fresh element each time: re-rendering the same one lets React bail out, and the flip of
    // `ready` below would then never reach the components.
    const tree = () => (
      <MemoryRouter>
        <SkillsPanel />
        <BehaviourProposals />
      </MemoryRouter>
    );
    const { rerender } = render(tree());
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(screen.queryByText(/You keep none/i)).toBeNull();
    expect(screen.queryByText(/Nothing proposed/i)).toBeNull();

    mode.ready = true;
    rerender(tree());

    expect(await screen.findByText('my-workup')).toBeTruthy();
    expect(await screen.findByText('house-workup')).toBeTruthy();
    expect(await screen.findByText(/Nothing proposed/i)).toBeTruthy();
  });
});

describe('a write refreshes what the page is showing about it', () => {
  it('replaces an open body after a revert', async () => {
    let active = NEWER;
    serve({
      '/skills/mine': () => json({ skills: [] }),
      '/skills/org': () => json({ skills: ['house-workup'] }),
      '/skills/org/house-workup': () => json({ name: 'house-workup', body: active }),
      '/skills/org/house-workup/versions': () =>
        json({
          versions: [
            {
              content_hash: 'hash-new',
              body: NEWER,
              activated_by: 'u-admin',
              activated_at: '2026-09-20T09:00:00Z',
            },
            {
              content_hash: 'hash-old',
              body: OLDER,
              activated_by: 'u-admin',
              activated_at: '2026-09-19T09:00:00Z',
            },
          ],
        }),
      '/skills/org/house-workup/revert': () => {
        active = OLDER;
        return json({ name: 'house-workup', body: OLDER });
      },
    });
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText(/Read what it tells the agent/i));
    await waitFor(() => expect(screen.getAllByText(/Quench hot\./)).toHaveLength(1));
    fireEvent.click(await screen.findByText(/What it used to say/i));
    fireEvent.click(await screen.findByRole('button', { name: /Put this back/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Revert$/ }));

    // The open body now says what acts: the older text twice (body and held version), the newer
    // only in the history where it is kept.
    await waitFor(() => expect(screen.getAllByText(/Quench cold\./)).toHaveLength(2));
    expect(screen.getAllByText(/Quench hot\./)).toHaveLength(1);
  });

  it('publishes once however quickly the button is pressed twice', async () => {
    const posts: string[] = [];
    serve(
      {
        '/skills/mine': () => json({ skills: [] }),
        '/skills/org': () => json({ skills: [] }),
      },
      (url, init) => {
        if (init?.method === 'POST') posts.push(url);
      },
    );
    render(
      <MemoryRouter>
        <SkillsPanel />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByPlaceholderText(/house-workup/), {
      target: { value: OLDER },
    });
    const button = screen.getByRole('button', { name: /^Publish$/ });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(posts).toHaveLength(1));
  });
});

describe('a proposal that is a record rather than a skill', () => {
  it('does not tell a chemist a profile will act on their turns', async () => {
    serve({
      '/proposals': () =>
        json({
          proposals: [
            {
              kind: 'profile',
              name: 'kinetics-helper',
              content_hash: 'hash-p',
              content: 'name: kinetics-helper\n',
              rationale: 'Asked for three times this week.',
              state: 'open',
              session_id: '',
            },
          ],
        }),
    });
    render(
      <MemoryRouter>
        <BehaviourProposals />
      </MemoryRouter>,
    );

    expect(await screen.findByText('kinetics-helper')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Record that you want it/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep this skill/ })).toBeNull();
    expect(screen.getByText(/Read the whole profile/)).toBeTruthy();
    expect(screen.getByText(/reviewed commit to data\/profiles\//)).toBeTruthy();
    expect(screen.queryByText(/act on your turns from the next one/)).toBeNull();
  });
});
