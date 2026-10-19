/**
 * The stored skills that shape the agent's answers, and who put them there — the condition on which
 * these tiers skip per-use review is that the people they act on can see and remove them.
 *
 * - **Yours** reaches only your turns; you can delete it.
 * - **The organisation's** reaches everyone's turns; everyone can read it, only the privileged role
 *   can change it.
 *
 * The repository's `skills/` tree is not listed (it changes only by reviewed commit). Nothing here
 * writes a skill for the agent. Admin controls are hidden by `useIsReviewer` and the service's
 * refusal is still handled, since the deployment's role list can drift from the service's.
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

/** The message for an unavailable tier (503), naming the setting an operator must fix. */
function unavailableCopy(error: unknown): string | null {
  return error instanceof ApiError && error.status === 503
    ? 'This deployment keeps no stored skills: it needs the durable memory store (CHEMCLAW_AGENT_MEMORY_ENABLED with a Postgres session store).'
    : null;
}

/** After a write to a tier, invalidate its whole key prefix: list, open bodies and histories. */
function invalidateTier(tier: 'mine' | 'org'): void {
  void queryClient.invalidateQueries({
    queryKey: tier === 'mine' ? keys.mySkills : keys.orgSkills,
  });
}

/** A `<details>` whose children mount only when open, so closed histories fetch nothing. */
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
  // Gated on `ready`: before a token exists the read would fail and, with `retry: false`, stay
  // failed.
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
        {/* Same key in both branches, so the "Kept …" confirmation survives the first save moving the tier between them. */}
        <WriteMine key="write-mine" onSaved={() => invalidateTier('mine')} />
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
      <WriteMine key="write-mine" onSaved={() => invalidateTier('mine')} />
    </>
  );
}

/**
 * Write a skill for yourself. The service's 409 (reserved name, row cap) and 422 (not a valid
 * `SKILL.md`) sentences are shown as they arrive. An existing name is replaced, and the button says
 * so.
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

/**
 * One organisation skill's version history. `retired`: no version is active (retiring keeps every
 * version), so none is badged and any can be restored.
 */
function OrgHistory({
  name,
  retired = false,
  onReverted,
}: {
  name: string;
  retired?: boolean;
  onReverted?: () => void;
}): React.JSX.Element {
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
      onReverted?.();
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
                {index === 0 && !retired ? <Badge>Active</Badge> : <Badge>Held</Badge>}{' '}
                <span className="text-ink-muted">
                  {version.activated_by || 'somebody'} · {when(version.activated_at)}
                </span>
              </span>
              {(index !== 0 || retired) && isReviewer && (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      <Undo2 className="size-4" /> Put this back
                    </Button>
                  }
                  title={
                    retired ? `Restore ${name} as this version?` : `Revert ${name} to this version?`
                  }
                  description={
                    retired
                      ? 'It is published again, and every turn in this deployment is handed these exact bytes from the next one. Retiring it again is the way back.'
                      : 'Every turn in this deployment is handed these exact bytes from the next one. The version it replaces is kept, so this is itself reversible.'
                  }
                  confirmLabel={retired ? 'Restore' : 'Revert'}
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

/**
 * Restore a retired skill by name (`POST /skills/org/{name}/revert` activates any held body).
 * Reviewer-only. A still-published name is sent back to its own row.
 */
function RestoreRetired({ published }: { published: readonly string[] }): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [looking, setLooking] = useState('');
  const [restored, setRestored] = useState('');
  const name = looking.trim();
  const stillPublished = name !== '' && published.includes(name);

  return (
    <div className="mt-6 rounded-lg border border-line p-4">
      <h3 className="font-medium">Restore a retired skill</h3>
      <p className="mt-1 text-sm text-ink-muted">
        A retired skill leaves the list above, but the service keeps every version it held. Name it
        to see them, then put the one you want back.
      </p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setRestored('');
          setLooking(draft);
        }}
      >
        <input
          aria-label="Name of the retired skill"
          className="min-w-0 flex-1 rounded border border-line bg-surface p-2 font-mono text-xs"
          placeholder="its frontmatter name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!draft.trim()}>
          Show what it held
        </Button>
      </form>
      {restored && <p className="mt-2 text-sm text-success">{restored}</p>}
      {stillPublished && (
        <p className="mt-2 text-sm text-ink-muted">
          {name} is still published — its own history in the list above is where to revert it.
        </p>
      )}
      {name && !stillPublished && (
        <OrgHistory
          key={name}
          name={name}
          retired
          onReverted={() => {
            setLooking('');
            setDraft('');
            setRestored(
              `Restored ${name}. Every turn in this deployment reads it from the next one.`,
            );
          }}
        />
      )}
    </div>
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
                    description="It stops acting on everybody's turns and leaves this list. Its history is kept on the service, so an administrator can bring it back by name under “Restore a retired skill”."
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

      {/* Hidden for non-reviewers (as `JobsPanel` hides cancel); the service's refusal is still handled. */}
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
      {isReviewer && <RestoreRetired published={names} />}
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
