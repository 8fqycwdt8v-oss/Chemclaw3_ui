/**
 * Saving a chemist's revision, and handling a 409 when the artefact moved underneath it (agent or
 * colleague revisions are ordinary). Shared by every editable view.
 *
 * - **`stale`** holds the edit, its base and the head the service named (`StaleRevisionError`);
 *   `RebasePrompt` diffs head against base so the chemist sees what changed.
 * - **`retryOnHead`** re-sends with `parent_revision` = head. Never automatic: a silent rebase is
 *   the overwrite the 409 prevents. Success invalidates `keys.exhibits` and puts the pane back on
 *   the head, now the chemist's revision.
 */

import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.tsx';
import { api } from '../../api/client.ts';
import { StaleRevisionError } from '../../api/errors.ts';
import { keys, queryClient } from '../../api/queryClient.ts';
import { useExhibitPane } from '../../state/exhibitPane.ts';
import { isSpec, type ExhibitView, type RawExhibitSpec } from '../../../shared/exhibits.ts';

export type ReviseState =
  | { status: 'idle' }
  | { status: 'saving' }
  | {
      status: 'stale';
      /** The revision the edit was written against. */
      base: number;
      /** The head the service named, or `null` when it named none (then the head is re-read). */
      head: number | null;
      spec: RawExhibitSpec;
      changeNote: string;
    }
  | { status: 'failed'; message: string };

export interface Revise {
  state: ReviseState;
  /**
   * Save `spec` as a revision on top of `base`; resolves `true` on success.
   *
   * `base` is the revision the edit started on, never the one on screen at save time: the head can
   * refetch while typing, and posting against an unseen revision would drop its changes without a
   * 409. `spec` is a stored spec built from `raw_spec`, so untouched bindings go back verbatim.
   */
  save: (spec: RawExhibitSpec, changeNote: string, base: number) => Promise<boolean>;
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
    spec: RawExhibitSpec,
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
      useExhibitPane.getState().setRevision(sessionId, view.exhibit_id, 0);
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
    save: (spec, changeNote, base) => write(base, spec, changeNote),
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
      useExhibitPane.getState().setRevision(sessionId, view.exhibit_id, 0);
    },
    reset() {
      setState({ status: 'idle' });
    },
  };
}
