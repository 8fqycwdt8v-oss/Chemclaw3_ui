/**
 * A document artefact: a report draft, an SOP section, a comparison write-up.
 *
 * Read through the app's own `Markdown`, which forbids raw HTML, `script`, `iframe`, `object` and
 * `form` — the reason the declined interactive kind is not needed for a draft, and the reason a
 * tool result that carried prompt-injection markup into the agent's prose cannot carry it into the
 * page. Citations are the same chips an answer has.
 *
 * Edited as text with a preview beside it, saved as a revision on top of the one on screen. The
 * edit is only offered on the **head**: editing revision 2 of a document whose head is 4 would be
 * either a revert nobody asked for or a guaranteed 409, and neither is what the button says.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { DocumentSpec, ExhibitView } from '../../../../shared/exhibits.ts';
import { Markdown } from '../../LazyMarkdown.tsx';
import { Button } from '@/components/ui/button';
import { RebasePrompt } from '../RebasePrompt.tsx';
import { useRevise } from '../useRevise.ts';

export function DocumentView({
  sessionId,
  view,
  spec,
  isHead,
}: {
  sessionId: string;
  view: ExhibitView;
  spec: DocumentSpec;
  isHead: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const revise = useRevise(sessionId, view);
  const saving = revise.state.status === 'saving';

  if (revise.state.status === 'stale') {
    return (
      <RebasePrompt
        sessionId={sessionId}
        exhibitId={view.exhibit_id}
        base={revise.state.base}
        head={revise.state.head}
        saving={saving}
        onRetry={() => void revise.retryOnHead().then((ok) => ok && setDraft(null))}
        onDiscard={() => {
          revise.discard();
          setDraft(null);
        }}
      />
    );
  }

  if (draft === null) {
    return (
      <div className="flex flex-col gap-3">
        {isHead && (
          <div data-print="hide" className="flex justify-end">
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                revise.reset();
                setNote('');
                setDraft(spec.markdown);
              }}
            >
              <Pencil aria-hidden className="size-3.5" />
              Edit
            </Button>
          </div>
        )}
        <div className="text-sm">
          <Markdown>{spec.markdown}</Markdown>
        </div>
      </div>
    );
  }

  const save = async (): Promise<void> => {
    const ok = await revise.save({ kind: 'document', markdown: draft }, note.trim());
    if (ok) setDraft(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <label className="flex flex-col gap-1 text-2xs text-ink-subtle">
          Document text (Markdown)
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            className="min-h-48 rounded-md border border-border-subtle bg-surface-raised p-2 font-mono text-xs text-ink focus-ring"
          />
        </label>
        <section
          aria-label="Preview"
          className="rounded-md border border-border-subtle p-2 text-sm"
        >
          <p className="mb-1 text-2xs text-ink-subtle">Preview</p>
          <Markdown>{draft}</Markdown>
        </section>
      </div>
      <label className="flex flex-col gap-1 text-2xs text-ink-subtle">
        What you changed, for the revision history
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-sm text-ink focus-ring"
        />
      </label>
      {revise.state.status === 'failed' && (
        <p role="alert" className="text-xs text-danger-ink">
          {revise.state.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || draft === spec.markdown}>
          {saving ? 'Saving…' : `Save as revision ${view.head_revision + 1}`}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDraft(null)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
