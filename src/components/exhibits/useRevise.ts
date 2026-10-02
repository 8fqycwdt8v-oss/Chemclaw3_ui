/**
 * Saving a chemist's revision, and what happens when the artefact moved underneath it.
 *
 * Shared by every editable view (a document's text, a table's cells), because the hard part is not
 * the editor — it is the 409. The agent revises artefacts as part of its answers, and in a shared
 * session so do colleagues, so "the head moved while I was typing" is an ordinary state rather than
 * a race worth ignoring. The service answers it with `{code: "stale_revision", head_revision: N}`
 * (`StaleRevisionError`), and this hook turns that into a state the view can render:
 *
 *  - **`stale`** holds the edit the chemist made, the base it was written against, and the head the
 *    service named. `RebasePrompt` shows the diff *head against base* — what somebody else changed
 *    — so the decision to apply the edit on top is made having seen what it lands on.
 *  - **`retryOnHead`** re-sends the same spec with `parent_revision` = that head. Never automatic:
 *    a silent rebase is exactly the overwrite the 409 exists to prevent, moved one step later.
 *
 * A successful save invalidates the session's artefact prefix (`keys.exhibits`), which reaches the
 * list, the head body and the history in one call, and puts the pane back on the head — which is
 * now the chemist's own revision.
 */

import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.tsx';
import { api } from '../../api/client.ts';
import { StaleRevisionError } from '../../api/errors.ts';
import { keys, queryClient } from '../../api/queryClient.ts';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import { isSpec, type ExhibitSpec, type ExhibitView } from '../../../shared/exhibits.ts';

export type ReviseState =
  | { status: 'idle' }
  | { status: 'saving' }
  | {
      status: 'stale';
      /** The revision the edit was written against. */
      base: number;
      /** The head the service named, or `null` when it named none (then the head is re-read). */
      head: number | null;
      spec: ExhibitSpec;
      changeNote: string;
    }
  | { status: 'failed'; message: string };

export interface Revise {
  state: ReviseState;
  /** Save `spec` as a new revision on top of the one on screen. Resolves `true` on success. */
  save: (spec: ExhibitSpec, changeNote: string) => Promise<boolean>;
  /** Apply the stale edit on top of the head the service named. */
  retryOnHead: () => Promise<boolean>;
  /** Drop the stale edit and show the head. */
  discard: () => void;
  reset: () => void;
}

export function useRevise(sessionId: string, view: ExhibitView): Revise {
  const { auth } = useAuth();
  const [state, setState] = useState<ReviseState>({ status: 'idle' });

  const write = async (
    parentRevision: number,
    spec: ExhibitSpec,
    changeNote: string,
  ): Promise<boolean> => {
    // The service is the authority on a spec and will say so in its own words; this catches an
    // edit *this app* built wrong before it is reported to the chemist as a refusal.
    if (!isSpec(spec)) {
      setState({ status: 'failed', message: 'This edit could not be turned into an artefact.' });
      return false;
    }
    setState({ status: 'saving' });
    try {
      await api.postExhibitRevision(
        sessionId,
        view.exhibit_id,
        { parentRevision, spec, changeNote },
        auth,
      );
      setState({ status: 'idle' });
      useExhibitPane.getState().setRevision(0);
      // After the write settles, never before it — `api.decidePlan`'s argument: invalidating
      // refetches an active observer at once, and a read issued before the POST could land the old
      // head and cache it as fresh.
      void queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
      return true;
    } catch (err) {
      if (err instanceof StaleRevisionError) {
        setState({
          status: 'stale',
          base: parentRevision,
          head: err.headRevision,
          spec,
          changeNote,
        });
        // The list and the head are now known to be stale; refetch them so the prompt and the
        // picker describe the artefact as it is.
        void queryClient.invalidateQueries({ queryKey: keys.exhibits(sessionId) });
        return false;
      }
      setState({
        status: 'failed',
        message: err instanceof Error ? err.message : 'The revision could not be saved.',
      });
      return false;
    }
  };

  return {
    state,
    save: (spec, changeNote) => write(view.revision, spec, changeNote),
    async retryOnHead() {
      if (state.status !== 'stale') return false;
      let head = state.head;
      if (head === null) {
        // The service did not name the head: ask for it rather than guess a number to rebase onto.
        try {
          head = (await api.getExhibit(sessionId, view.exhibit_id, auth)).revision;
        } catch (err) {
          setState({
            status: 'failed',
            message: err instanceof Error ? err.message : 'The artefact could not be re-read.',
          });
          return false;
        }
      }
      return write(head, state.spec, state.changeNote);
    },
    discard() {
      setState({ status: 'idle' });
      useExhibitPane.getState().setRevision(0);
    },
    reset() {
      setState({ status: 'idle' });
    },
  };
}
