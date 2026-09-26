/**
 * What judgment is acting on your answers, and who put it there.
 *
 * Three tiers shape every reply the agent gives, and until this screen existed a chemist could see
 * none of them. `D-2026-09-05-the-gate-follows-behaviour-not-knowledge` grants the two *stored*
 * tiers their exemption from per-use review on a stated condition — that the people a skill acts on
 * can see what it says and get rid of it — and the only thing that could exercise that condition was
 * `curl`. So this page is not a convenience: it is the half of a bargain the service has been
 * claiming for both tiers.
 *
 * **Two tiers, two different bargains, and the screen says which is which.**
 *
 *  - **Yours** reaches your turns and nobody else's. You wrote it or accepted it, so you can delete
 *    it, and that is the whole of the review it gets.
 *  - **The organisation's** reaches every turn every chemist here takes. You can read all of it —
 *    deliberately, because it acts on people who did not approve it — and only the privileged role
 *    can change it (`D-2026-09-20-a-behaviour-change-is-gated-by-its-blast-radius`).
 *
 * The shared `skills/` tree is not listed, and its absence is a decision rather than an omission:
 * it changes only by a reviewed commit to the repository, so there is nothing here anybody could do
 * about it and a read-only list of it would be documentation pretending to be a control.
 *
 * **Nothing on this page writes a skill on the agent's behalf.** `SkillsReadOnlyRefusal` refuses
 * every write a turn could attempt, on every tier; what reaches these routes is a person clicking.
 *
 * **The admin half is hidden by `useIsReviewer` and refused by the service, and it needs both.**
 * Hiding is this app's established posture for a role-gated control (`JobsPanel.tsx` offers
 * cancellation the same way), and it is the right one: a publish box somebody can fill in and then
 * be refused wastes the writing. But the hook reads `config.reviewerRoles`, which is the
 * *deployment's* copy of the service's `entra_privileged_roles` — two settings that can drift —
 * so the refusal is handled as well. When they disagree the service wins, and the copy says which
 * setting to look at rather than leaving a reader to guess that the button lied.
 */

import { useState } from 'react';
import { BookOpen, Building2, Trash2, Undo2, User } from 'lucide-react';
import { useAuth, useIsReviewer } from '../auth/AuthContext.tsx';
import { keys, queryClient, useApiQuery } from '../api/queryClient.ts';
import { api, type OrgSkillVersion } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { relativeTime } from '../lib/format.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/chem/ConfirmDialog';
import { EmptyState, Loading } from '@/components/chem/Feedback';

/** A service timestamp as "3 hours ago", or the raw value when it is not one. */
function when(value: string): string {
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? value : relativeTime(at);
}

/**
 * The one message an unavailable tier gets, and it names the setting.
 *
 * Both tiers ride the same store, so both answer 503 on the same misconfiguration — and an operator
 * reading over somebody's shoulder is the person who can fix it, which is why the copy is the
 * setting's name rather than "unavailable".
 */
function unavailableCopy(error: unknown): string | null {
  return error instanceof ApiError && error.status === 503
    ? 'This deployment keeps no stored skills: it needs the durable memory store (CHEMCLAW_AGENT_MEMORY_ENABLED with a Postgres session store).'
    : null;
}

/**
 * Re-read everything this screen holds about one tier after a write to it.
 *
 * The list, every open body and every open history share the tier's key prefix, so one
 * invalidation reaches all of them. Refetching only the list is what left an open body showing the
 * text a revert or a save-over had just replaced — a page describing a skill that no longer acts.
 */
function invalidateTier(tier: 'mine' | 'org'): void {
  void queryClient.invalidateQueries({
    queryKey: tier === 'mine' ? keys.mySkills : keys.orgSkills,
  });
}

/**
 * A `<details>` whose children are mounted only once it is open.
 *
 * **`<details>` renders its children whether or not it is open**, so a query inside one fires on
 * page load — and the version history carries every held *body*, so a deployment with a dozen org
 * skills fetched a dozen full histories to show nobody anything. Driven: the versions query ran
 * for every skill on first paint, which is what the "Query data cannot be undefined" warning in
 * the test output was pointing at.
 */
function Disclosure({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-ink-muted">{summary}</summary>
      {open && children}
    </details>
  );
}

/** One skill's body, fetched only when somebody asks to read it. */
function SkillBody({ tier, name }: { tier: 'mine' | 'org'; name: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.skillBody(tier, name),
    queryFn: () => (tier === 'mine' ? api.readMySkill(auth, name) : api.readOrgSkill(auth, name)),
    enabled: ready,
  });

  if (isPending) return <Loading size="xs">Loading the skill…</Loading>;
  if (error) {
    return <p className="text-sm text-danger">Could not read {name}.</p>;
  }
  // Preformatted rather than rendered, for `BehaviourProposals.tsx`'s reason: the frontmatter is
  // part of what is acting, and rendering the document hides it.
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-sunken p-3 text-xs whitespace-pre-wrap">
      {data?.body ?? ''}
    </pre>
  );
}

/** The chemist's own tier: read and remove, which is the whole of the bargain. */
function MySkills(): React.JSX.Element {
  // Gated on `ready`, as every other authenticated read here is: on a cold load under MSAL these
  // mounted before the token existed, failed `token_unavailable`, and — with `retry: false` and a
  // key that does not change when auth resolves — stayed failed until the page was left.
  const { auth, ready } = useAuth();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.mySkills,
    queryFn: () => api.listMySkills(auth),
    enabled: ready,
  });
  const [failed, setFailed] = useState('');

  if (isPending) return <Loading>Loading your skills…</Loading>;
  if (error) {
    const unavailable = unavailableCopy(error);
    return (
      <EmptyState
        icon={<User className="size-5" />}
        title={unavailable ? 'This deployment keeps no personal skills' : 'Could not load'}
      >
        {unavailable ?? (error instanceof Error ? error.message : 'The service did not answer.')}
      </EmptyState>
    );
  }

  const names = data ?? [];
  if (names.length === 0) {
    return (
      <>
        <EmptyState icon={<User className="size-5" />} title="You keep none">
          When a turn works out a procedure worth keeping, it can propose one — you decide on the
          review screen, and what you accept appears here.
        </EmptyState>
        <WriteMine onSaved={() => invalidateTier('mine')} />
      </>
    );
  }

  async function forget(name: string): Promise<void> {
    setFailed('');
    try {
      await api.forgetMySkill(auth, name);
      invalidateTier('mine');
    } catch (err) {
      setFailed(err instanceof Error ? err.message : `Could not remove ${name}.`);
    }
  }

  return (
    <>
      {failed && <p className="mb-2 text-sm text-danger">{failed}</p>}
      <ul className="space-y-3">
        {names.map((name) => (
          <li key={name} className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{name}</h3>
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <Trash2 className="size-4" /> Remove
                  </Button>
                }
                title={`Remove ${name}?`}
                description="It stops acting on your turns from the next one. Nobody else is affected, because nobody else could reach it."
                confirmLabel="Remove"
                variant="destructive"
                onConfirm={() => void forget(name)}
              />
            </div>
            <Disclosure summary="Read what it tells the agent">
              <SkillBody tier="mine" name={name} />
            </Disclosure>
          </li>
        ))}
      </ul>
      <WriteMine onSaved={() => invalidateTier('mine')} />
    </>
  );
}

/**
 * Write one for yourself — the path a declined proposal's dialog points at, which until this
 * existed pointed at nothing.
 *
 * Its refusals are the service's sentences, shown as they arrive: a name a skill this deployment
 * ships already uses and the row cap are both 409s, a document that is not a `SKILL.md` or is too
 * long is a 422, and each detail says what to change. A saved name that already exists is
 * replaced, which the button says rather than the reader discovering it.
 */
function WriteMine({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { auth } = useAuth();
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    setFailed('');
    setSaved('');
    try {
      const kept = await api.saveMySkill(auth, draft);
      setDraft('');
      setSaved(`Kept ${kept.name}. It acts on your turns from the next one, and on nobody else's.`);
      onSaved();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The skill was not kept.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-line p-4">
      <h3 className="font-medium">Write one yourself</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Paste the whole <code>SKILL.md</code>, frontmatter included — its <code>name</code> is what
        it is kept under, and saving a name you already keep replaces it.
      </p>
      <textarea
        aria-label="Your skill, as a whole SKILL.md"
        className="mt-2 h-40 w-full rounded border border-line bg-surface p-2 font-mono text-xs"
        placeholder={'---\nname: my-workup\ndescription: how I work one up\n---\n\n…'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {failed && <p className="mt-2 text-sm text-danger">{failed}</p>}
      {saved && <p className="mt-2 text-sm text-success">{saved}</p>}
      <Button
        className="mt-2"
        size="sm"
        disabled={busy || !draft.trim()}
        onClick={() => void save()}
      >
        {busy ? 'Keeping…' : 'Keep it'}
      </Button>
    </div>
  );
}

/** One organisation skill's history — the blame half, open to everybody it acts on. */
function OrgHistory({ name }: { name: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const isReviewer = useIsReviewer();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.orgSkillVersions(name),
    queryFn: () => api.listOrgSkillVersions(auth, name),
    enabled: ready,
  });
  const [failed, setFailed] = useState('');

  if (isPending) return <Loading size="xs">Loading what it used to say…</Loading>;
  if (error) return <p className="text-sm text-danger">Could not read the history of {name}.</p>;

  const versions = data ?? [];
  if (versions.length === 0) return <p className="text-sm text-ink-muted">No history held.</p>;

  async function revert(version: OrgSkillVersion): Promise<void> {
    setFailed('');
    try {
      await api.revertOrgSkill(auth, name, version.content_hash);
      invalidateTier('org');
    } catch (err) {
      setFailed(
        err instanceof ApiError && err.status === 403
          ? 'Changing an organisation skill needs the privileged role this deployment names in CHEMCLAW_ENTRA_PRIVILEGED_ROLES.'
          : err instanceof Error
            ? err.message
            : 'The revert did not go through.',
      );
    }
  }

  return (
    <>
      {failed && <p className="mt-2 text-sm text-danger">{failed}</p>}
      <ul className="mt-2 space-y-2">
        {versions.map((version, index) => (
          <li key={version.content_hash} className="rounded border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                {index === 0 ? <Badge>Active</Badge> : <Badge>Held</Badge>}{' '}
                <span className="text-ink-muted">
                  {version.activated_by || 'somebody'} · {when(version.activated_at)}
                </span>
              </span>
              {index !== 0 && isReviewer && (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      <Undo2 className="size-4" /> Put this back
                    </Button>
                  }
                  title={`Revert ${name} to this version?`}
                  description="Every turn in this deployment is handed these exact bytes from the next one. The version it replaces is kept, so this is itself reversible."
                  confirmLabel="Revert"
                  onConfirm={() => void revert(version)}
                />
              )}
            </div>
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-surface-sunken p-2 text-xs whitespace-pre-wrap">
              {version.body}
            </pre>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The organisation's tier: everybody reads, the privileged role changes. */
function OrgSkills(): React.JSX.Element {
  const { auth, ready } = useAuth();
  const isReviewer = useIsReviewer();
  const { data, error, isPending } = useApiQuery({
    queryKey: keys.orgSkills,
    queryFn: () => api.listOrgSkills(auth),
    enabled: ready,
  });
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState('');
  const [published, setPublished] = useState('');
  // Publishing is a write every turn in the deployment reads, so a second click while the first is
  // in flight must not send it twice — the guard `WriteMine` already has.
  const [busy, setBusy] = useState(false);

  if (isPending) return <Loading>Loading the organisation's skills…</Loading>;
  if (error) {
    const unavailable = unavailableCopy(error);
    return (
      <EmptyState
        icon={<Building2 className="size-5" />}
        title={unavailable ? 'This deployment publishes none' : 'Could not load'}
      >
        {unavailable ?? (error instanceof Error ? error.message : 'The service did not answer.')}
      </EmptyState>
    );
  }

  async function act(run: () => Promise<unknown>, done = ''): Promise<void> {
    setBusy(true);
    setFailed('');
    setPublished('');
    try {
      await run();
      invalidateTier('org');
      if (done) setPublished(done);
    } catch (err) {
      setFailed(
        err instanceof ApiError && err.status === 403
          ? 'Changing an organisation skill is an administrator action: it needs the privileged role this deployment names in CHEMCLAW_ENTRA_PRIVILEGED_ROLES.'
          : err instanceof Error
            ? err.message
            : 'That did not go through.',
      );
    } finally {
      setBusy(false);
    }
  }

  const names = data ?? [];

  return (
    <>
      {names.length === 0 ? (
        <EmptyState icon={<Building2 className="size-5" />} title="Nothing published">
          Nobody has published a skill to everyone here. One that is published acts on every turn
          every chemist takes, so it takes the privileged role to add one.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {names.map((name) => (
            <li key={name} className="rounded-lg border border-line p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{name}</h3>
                {isReviewer && (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="outline">
                        <Trash2 className="size-4" /> Retire
                      </Button>
                    }
                    title={`Retire ${name}?`}
                    description="It stops acting on everybody's turns. Its history is kept on the service, so an administrator can restore it by name — but a retired skill leaves this list, and with it this screen's revert."
                    confirmLabel="Retire"
                    variant="destructive"
                    onConfirm={() => void act(() => api.retireOrgSkill(auth, name))}
                  />
                )}
              </div>
              <Disclosure summary="Read what it tells the agent">
                <SkillBody tier="org" name={name} />
              </Disclosure>
              <Disclosure summary="What it used to say, and who changed it">
                <OrgHistory name={name} />
              </Disclosure>
            </li>
          ))}
        </ul>
      )}

      {/* Hidden rather than disabled for a non-reviewer: a textarea somebody can fill in and then
          be refused wastes the writing, which is the reason `JobsPanel.tsx` hides its cancel
          control the same way. The refusal below is still handled — see the file docstring. */}
      {isReviewer && (
        <div className="mt-6 rounded-lg border border-line p-4">
          <h3 className="font-medium">Publish one to everyone</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Paste the whole <code>SKILL.md</code>, frontmatter included — what you paste is what
            every turn reads, byte for byte. This needs the privileged role; without it the service
            refuses and nothing changes.
          </p>
          <textarea
            aria-label="Organisation skill to publish, as a whole SKILL.md"
            className="mt-2 h-40 w-full rounded border border-line bg-surface p-2 font-mono text-xs"
            placeholder={'---\nname: house-workup\ndescription: how we work one up here\n---\n\n…'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {failed && <p className="mt-2 text-sm text-danger">{failed}</p>}
          {published && <p className="mt-2 text-sm text-success">{published}</p>}
          <Button
            className="mt-2"
            size="sm"
            disabled={busy || !draft.trim()}
            onClick={() =>
              void act(async () => {
                const saved = await api.publishOrgSkill(auth, draft);
                setDraft('');
                return saved;
              }, 'Published. Every turn in this deployment reads it from the next one.')
            }
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      )}
    </>
  );
}

/** The page. */
export function SkillsPanel(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <BookOpen className="size-6" /> Skills
      </h1>
      <p className="mb-6 text-sm text-ink-muted">
        Judgment the agent applies when it answers — what it is, where it came from, and what you
        can do about it. A turn reads these and can never write one.
      </p>

      <div className="space-y-10">
        <section aria-labelledby="mine-heading">
          <h2 id="mine-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Yours
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Acting on your turns and nobody else's. You accepted each of these, so removing one
            needs nobody's agreement but your own.
          </p>
          <MySkills />
        </section>

        <section aria-labelledby="org-heading">
          <h2 id="org-heading" className="mb-1 text-lg font-semibold tracking-tight">
            Your organisation's
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Acting on every turn every chemist here takes, including yours. Everybody can read these
            — they shape answers people did not approve — and an administrator publishes, reverts
            and retires them.
          </p>
          <OrgSkills />
        </section>
      </div>
    </div>
  );
}
