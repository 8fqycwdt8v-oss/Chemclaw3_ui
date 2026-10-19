/**
 * The message composer.
 *
 * - Send is disabled while this conversation's turn streams; over the deployment's character cap
 *   the send is blocked with a counter.
 * - Enter by pointer type: on a coarse pointer Enter is a newline (no Shift on soft keyboards);
 *   Cmd/Ctrl+Enter sends everywhere.
 * - The draft lives in the store per conversation (this component does not unmount on a switch).
 * - A pasted structure is confirmed, not intercepted (`PasteConfirmation`): the text lands as
 *   pasted and a strip shows what RDKit made of it.
 * - It is a drop target for structures and files, and a window-level guard stops a missed drop
 *   navigating away.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Hexagon, Paperclip, Send, Square, Undo2, X } from 'lucide-react';
import { api } from '../api/client.ts';
import { config } from '../env.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useApiQuery } from '../api/queryClient.ts';
import { profilesQuery } from '../api/queries.ts';
import { useChatStore } from '../state/chatStore.ts';
import { sendMessage, stopStreaming, warmSession } from '../state/sendMessage.ts';
import {
  INSERT_STRUCTURE_EVENT,
  PREFILL_EVENT,
  type InsertStructureDetail,
  type PrefillDetail,
} from '../state/composerEvents.ts';
import { refsOf, useExhibitPane } from '../state/exhibitPane.ts';
import { ExhibitRefChips } from './exhibits/ExhibitRefChips.tsx';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label, Switch } from '@/components/ui/misc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loading } from '@/components/chem/Feedback';
import { useEntityStore } from '../chem/entities.ts';
import {
  readCanonicalSmilesFromMolblock,
  rdkitAvailable,
  type NotAChemicalVerdict,
} from '../chem/rdkit.ts';
import { looksLikeMolblock } from '../chem/recognise.ts';
import { mightBeStructure, readStructure } from '../chem/structure.ts';
import { Molecule } from './Molecule.tsx';
// `STRUCTURE_FILE` from the panel itself: a file dropped here goes to the panel or to the
// attachment route, and which one is the panel's rule about what it can read.
import {
  STRUCTURE_FILE,
  StructureInput,
  TOO_COMPLEX_EXPLANATION,
  type AcceptedStructure,
} from './StructureInput.tsx';

/**
 * What a paste turned out to be, and where it landed: `raw` at `at`. The span matters because
 * SMILES are often infixes of each other, so the write-back and invalidation both check this exact
 * text at this exact position.
 */
type PasteCheck = {
  /** What was pasted, as it lands in the draft. */
  raw: string;
  /** Where it starts. The caret at paste time, read before the browser inserted anything. */
  at: number;
} & (
  | {
      status: 'read';
      kind: 'molecule' | 'reaction' | 'molblock';
      /** RDKit's reading. Equal to `raw` for a reaction, which is not canonicalised. */
      canonical: string;
    }
  /** Structure-shaped, and RDKit said no. */
  | { status: 'refused' }
  /** RDKit itself never loaded, so nothing here is a claim about the string. */
  | { status: 'unavailable' }
  /**
   * Read as a molecule but not named on this thread — not a chemical refusal and not a missing
   * toolkit (`Refused` in `src/chem/rdkit.engine.ts`).
   */
  | { status: NotAChemicalVerdict }
);

/**
 * Whether the draft still holds this check's text at its position as a whole token (text, position
 * and token boundaries all matter). Shared by write-back and invalidation.
 */
const spanHolds = (draft: string, check: PasteCheck): boolean => {
  const end = check.at + check.raw.length;
  if (draft.slice(check.at, end) !== check.raw) return false;
  const before = draft.slice(0, check.at).slice(-1);
  const after = draft.slice(end, end + 1);
  return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
};

/** Enough of a pasted payload to recognise it by — a refused molblock is ten lines of MDL, and
 *  none of them belong in a strip above the composer. */
const shortly = (raw: string): string => (raw.length > 80 ? `${raw.slice(0, 80)}…` : raw);

const MAX_TEXTAREA_PX = 200;

type Upload =
  | { state: 'busy'; text: string; progress: number; abort: AbortController }
  | { state: 'ok' | 'failed'; text: string }
  | null;

/** Strip labels; a molblock is named so the chemist sees it was understood as a structure. */
const PASTE_LABEL: Record<'molecule' | 'reaction' | 'molblock', string> = {
  molecule: 'Pasted structure',
  reaction: 'Pasted reaction',
  molblock: 'Pasted molfile',
};

/**
 * "This is what I understood you to paste": a quiet strip above the composer that does not take
 * focus, shown until used or dismissed. If RDKit's canonical form differs from the paste, replacing
 * is offered, never performed. It also reports the negative cases (not a molecule, toolkit
 * unavailable).
 */
function PasteConfirmation({
  pasted,
  onReplace,
  onDismiss,
}: {
  pasted: PasteCheck;
  onReplace: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const differs = pasted.status === 'read' && pasted.canonical !== pasted.raw;
  return (
    <div
      // `status` when all is well; `alert` when something is wrong with the message being held.
      role={pasted.status === 'read' ? 'status' : 'alert'}
      className="mb-2 flex items-start gap-3 rounded-xl border border-border-subtle bg-surface-raised p-2.5"
    >
      {pasted.status === 'read' && (
        <div className="shrink-0 rounded-lg border border-border-subtle bg-surface p-1">
          <Molecule smiles={pasted.canonical} maxWidth={128} />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {pasted.status === 'read' && (
          <p className="text-xs text-ink-muted">
            {PASTE_LABEL[pasted.kind]} — RDKit read this as{' '}
            <span className="font-mono break-all text-ink">{pasted.canonical}</span>
          </p>
        )}
        {pasted.status === 'refused' && (
          // The panel's own wording, because the two surfaces must not disagree about the same
          // string — and this is the one on the muscle-memory path.
          <p className="text-xs text-danger-ink">
            Pasted <span className="font-mono break-all text-ink">{shortly(pasted.raw)}</span> —
            RDKit could not read this as a molecule.
          </p>
        )}
        {pasted.status === 'unavailable' && (
          <p className="text-xs text-warn-ink">
            The structure toolkit could not be loaded, so nothing pasted here can be checked. This
            is not a verdict about what you pasted.
          </p>
        )}
        {pasted.status === 'too-complex' && (
          // The shared `TOO_COMPLEX_EXPLANATION`, so both checking surfaces say the same thing;
          // only the clause after it is this surface's own.
          <p className="text-xs text-warn-ink">
            Pasted <span className="font-mono break-all text-ink">{shortly(pasted.raw)}</span> —{' '}
            {TOO_COMPLEX_EXPLANATION} The message carries your spelling unchanged.
          </p>
        )}
        {differs && pasted.status === 'read' && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="xs" onClick={onReplace}>
              {pasted.kind === 'molblock' ? 'Use the SMILES instead' : 'Use the canonical form'}
            </Button>
            <span className="text-2xs text-ink-subtle">
              {pasted.kind === 'molblock'
                ? 'Otherwise the message carries the whole molfile.'
                : 'Your spelling works too — the service canonicalises either way.'}
            </span>
          </div>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss the structure check"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

export function Composer({ conversationId }: { conversationId: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [dryRun, setDryRun] = useState(false);
  const [upload, setUpload] = useState<Upload>(null);
  const [structureOpen, setStructureOpen] = useState(false);
  /**
   * A dropped structure file for the panel to read; a new object per drop so the same file dropped
   * twice is re-read.
   */
  const [droppedFile, setDroppedFile] = useState<{ at: number; file: File } | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * The last paste's check, or null. Cleared by the next paste, by use, by dismissal or by the
   * draft moving — never on a timer.
   */
  const [pasted, setPasted] = useState<PasteCheck | null>(null);
  /**
   * Paste sequence number: only the newest paste may write the strip (reads resolve out of order).
   */
  const pasteSeq = useRef(0);
  /**
   * Tells "the paste has not landed yet" from "the chemist edited it": the read can finish before
   * the browser inserts the text.
   */
  const pasteBefore = useRef('');
  const pasteLanded = useRef(false);
  /** Mirrors the in-flight upload's controller out of state, which is where leaving cannot reach
   *  it. See the effect below. */
  const uploadAbort = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** The caret position captured when the structure panel opened. */
  const caretRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  /**
   * Per-conversation state reset when the conversation changes (this component does not unmount on
   * a switch), adjusted during render so the previous conversation's strip is never shown over the
   * new one.
   */
  const [ephemeralFor, setEphemeralFor] = useState(conversationId);
  if (ephemeralFor !== conversationId) {
    setEphemeralFor(conversationId);
    setUpload(null);
    setStructureOpen(false);
    setDroppedFile(null);
    setPasted(null);
    setDryRun(false);
  }

  /**
   * A paste read still in flight may not write the strip after a conversation switch. A layout
   * effect, so the cleanup runs before the microtask that resolves the read.
   */
  useLayoutEffect(() => {
    pasteSeq.current += 1;
  }, [conversationId]);

  /**
   * Abort an in-flight upload when the conversation changes or the composer unmounts; the upload
   * belongs to the session it started against.
   */
  useEffect(() => () => uploadAbort.current?.abort(), [conversationId]);

  const composerLock = useChatStore((s) => s.composerLock);
  // Scoped to this conversation, so another conversation's stream does not lock this composer.
  const streaming = useChatStore((s) =>
    s.streaming?.conversationId === conversationId ? s.streaming : null,
  );
  // Whether this conversation's message is still waiting in a shared line; the control then
  // withdraws rather than stops.
  const waitingInLine = useChatStore((s) => {
    const live = s.streaming?.conversationId === conversationId ? s.streaming : null;
    if (!live) return false;
    const message = s.conversations[conversationId]?.messages.find((m) => m.id === live.messageId);
    return message?.role === 'assistant' && Boolean(message.queuePlace);
  });
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const profile = useChatStore((s) => s.sessionProfiles[conversationId] ?? '');
  const setSessionProfile = useChatStore((s) => s.setSessionProfile);
  const text = useChatStore((s) => s.drafts[conversationId] ?? '');
  const setDraft = useChatStore((s) => s.setDraft);

  // Read once at mount so the first render already has the right Enter behaviour.
  const [coarsePointer, setCoarsePointer] = useState(
    () => window.matchMedia?.('(pointer: coarse)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(pointer: coarse)');
    if (!query) return;
    const onChange = (e: MediaQueryListEvent): void => setCoarsePointer(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Chips and prompt buttons deep in rendered markdown hand text back through a window event: a
  // plain string prefills; `{ text, autoSend: true }` sends at once. A ref keeps the handler
  // current without re-subscribing.
  const autoSendRef = useRef<((message: string) => void) | null>(null);
  // Updated after commit, not during render (StrictMode renders twice).
  useEffect(() => {
    autoSendRef.current = (message: string) => {
      const isBlocked =
        useChatStore.getState().composerLock !== false ||
        useChatStore.getState().streaming !== null;
      if (isBlocked || message.length > config.maxMessageChars || !message.trim()) return;
      setDraft(conversationId, '');
      void sendMessage({ conversationId, text: message, dryRun, auth });
    };
  });

  useEffect(() => {
    const onPrefill = (event: Event): void => {
      const raw = (event as CustomEvent<PrefillDetail>).detail;
      const message = typeof raw === 'string' ? raw : raw.text;
      const autoSend = typeof raw === 'object' && raw.autoSend === true;
      setDraft(conversationId, message);
      if (autoSend) {
        autoSendRef.current?.(message);
      } else {
        textareaRef.current?.focus();
      }
    };
    window.addEventListener(PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(PREFILL_EVENT, onPrefill);
  }, [conversationId, setDraft]);

  /**
   * Put a structure into the draft at the caret — the single implementation for the panel's Insert,
   * the `chemclaw:insert-structure` event and the paste strip. Uses the panel's captured caret,
   * else the live one.
   */
  const putStructure = useCallback(
    (canonical: string, caretAt: number): void => {
      const draft = useChatStore.getState().drafts[conversationId] ?? '';
      const at = Math.min(Math.max(caretAt, 0), draft.length);
      const before = draft.slice(0, at);
      const after = draft.slice(at);
      // Pad only where whitespace is missing, so the SMILES is its own token and the chemist's
      // spacing survives.
      const fragment = `${before && !/\s$/.test(before) ? ' ' : ''}${canonical}${after && !/^\s/.test(after) ? ' ' : ''}`;

      setDraft(conversationId, `${before}${fragment}${after}`);

      const caret = before.length + fragment.length;
      // After commit, so the caret is set against the updated value.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        el?.setSelectionRange(caret, caret);
      });
    },
    [conversationId, setDraft],
  );

  /**
   * A structure elsewhere in the app was handed back to be used: inserted at the live caret (the
   * dispatcher did not take focus). Not promoted to the rail; the rail already holds it or declined
   * it.
   */
  useEffect(() => {
    const onInsert = (event: Event): void => {
      const { smiles } = (event as CustomEvent<InsertStructureDetail>).detail;
      if (!smiles) return;
      putStructure(smiles, textareaRef.current?.selectionStart ?? Number.MAX_SAFE_INTEGER);
    };
    window.addEventListener(INSERT_STRUCTURE_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_STRUCTURE_EVENT, onInsert);
  }, [putStructure]);

  /** Swallow a file dropped anywhere else on the window, so the browser does not navigate to it. */
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  // The deployment's agent profiles (a service property, so `staleTime: Infinity`). Silent on
  // failure: no route means one profile.
  const { data: profiles = [] } = useApiQuery({ ...profilesQuery(auth), enabled: ready });

  // Mint the backend session while the user types (debounced; only once a token is available).
  useEffect(() => {
    if (!ready || !text.trim() || sessionId) return;
    const timer = setTimeout(() => warmSession(conversationId, auth), 300);
    return () => clearTimeout(timer);
  }, [text, ready, sessionId, conversationId, auth]);

  // Auto-grow from the value so the box also shrinks after a send.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  // The deployment's cap from `/config.js`, so the counter matches the service's validator.
  const maxChars = config.maxMessageChars;
  const tooLong = text.length > maxChars;
  const isStreaming = streaming !== null;
  const blocked = composerLock !== false || isStreaming;
  // Typing stays open while auth resolves — that is the point of painting the shell early, and
  // `warmSession` needs the keystrokes. Only the two things that need a token are held back.
  const canSend = ready && !blocked && !tooLong && text.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    const message = text;
    setDraft(conversationId, '');
    // The artefacts the reader attached ride with this message and no other: read at the moment of
    // sending, and cleared with the draft they were attached to.
    const exhibitRefs = refsOf(useExhibitPane.getState(), conversationId);
    useExhibitPane.getState().clearRefs(conversationId);
    void sendMessage({ conversationId, text: message, dryRun, auth, exhibitRefs });
  };

  /**
   * Accept a structure from the panel: inserted at the caret (rarely the whole question), and
   * promoted into the entity rail (a confirmed structure satisfies the rail's rule; see
   * `src/chem/entities.ts`). The panel stays open while the file has more records.
   */
  const insertStructure = ({ canonical, raw, source, moreRecords }: AcceptedStructure): void => {
    // The raw spelling: the store canonicalises for the key and keeps this as an alias.
    void useEntityStore.getState().ingestUserStructure(conversationId, raw, source);
    putStructure(canonical, caretRef.current ?? text.length);
    if (!moreRecords) setStructureOpen(false);
  };

  /**
   * Check what was just pasted, without intercepting it. Only a single whitespace-free token (or a
   * molblock) is checked, so pasted prose is ignored. A molecule is promoted to the rail (a human
   * supplied this exact string); a reaction is drawn but not promoted. The check records a span for
   * the strip's rewrite button.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    // What the browser is about to insert, and where. CRLF is normalised because a textarea does
    // the same on the way in, and a span that did not match the text that lands would be dropped.
    const clip = event.clipboardData.getData('text').replace(/\r\n/g, '\n');
    const caret = event.currentTarget.selectionStart ?? 0;
    const seq = (pasteSeq.current += 1);
    pasteBefore.current = useChatStore.getState().drafts[conversationId] ?? '';
    pasteLanded.current = false;
    setPasted(null);
    if (!clip.trim()) return;

    /** Show a finished check, unless a newer paste has started since. */
    const show = (check: PasteCheck): void => {
      if (seq === pasteSeq.current) setPasted(check);
    };

    /** RDKit said no — but to the string, or because it is not here at all? Only the first is a
     *  chemical claim, and saying it about a molecule the toolkit never read is the worse error. */
    const refusal = async (raw: string, at: number): Promise<PasteCheck> => ({
      status: (await rdkitAvailable()) ? 'refused' : 'unavailable',
      raw,
      at,
    });

    // A molblock is multi-line, so it is checked before the whitespace guard, and kept verbatim
    // (its header lines must not be trimmed).
    if (looksLikeMolblock(clip)) {
      void readCanonicalSmilesFromMolblock(clip).then(async (read) => {
        // Before `refusal`, for the reason the token path below gives: the toolkit is present and
        // read a molecule, so `refusal` would say RDKit could not read one.
        if (read.status === 'too-complex') {
          show({ status: 'too-complex', raw: clip, at: caret });
          return;
        }
        if (read.status !== 'named') {
          show(await refusal(clip, caret));
          return;
        }
        const { canonical } = read;
        void useEntityStore.getState().ingestUserStructure(conversationId, canonical, 'paste');
        show({ status: 'read', kind: 'molblock', raw: clip, at: caret, canonical });
      });
      return;
    }

    const token = clip.trim();
    if (/\s/.test(token)) return;
    // Where the *token* lands: the clipboard may carry whitespace around it, and the span is about
    // the token rather than about the payload.
    const at = caret + (clip.length - clip.trimStart().length);

    void readStructure(token).then(async (read) => {
      // Before `refusal` and `mightBeStructure`: a too-complex read is a molecule, not "could not
      // read".
      if (read?.kind === 'too-complex') {
        show({ status: 'too-complex', raw: token, at });
        return;
      }
      if (read) {
        if (read.kind === 'molecule') {
          void useEntityStore.getState().ingestUserStructure(conversationId, read.raw, 'paste');
        }
        show({ status: 'read', kind: read.kind, raw: token, at, canonical: read.canonical });
        return;
      }
      // Only for a token that looked like chemistry. A refusal on anything else would fire on
      // ordinary words, which is the noise the syntactic recogniser exists to keep out.
      if (!mightBeStructure(token)) return;
      show(await refusal(token, at));
    });
  };

  /**
   * Withdraw the strip when its span is edited; otherwise its button would splice the canonical
   * form into a different molecule.
   */
  useEffect(() => {
    if (!pasted) return;
    if (spanHolds(text, pasted)) {
      pasteLanded.current = true;
      return;
    }
    if (pasteLanded.current || text !== pasteBefore.current) setPasted(null);
  }, [text, pasted]);

  const onUpload = async (file: File): Promise<void> => {
    if (!sessionId) {
      // Reachable only when warming is switched off or has not landed yet — typing one character
      // is normally enough to create the session this needs.
      setUpload({
        state: 'failed',
        text: 'Type a message first so the conversation has a session to attach to.',
      });
      return;
    }
    const abort = new AbortController();
    uploadAbort.current = abort;
    setUpload({ state: 'busy', text: `Uploading ${file.name}…`, progress: 0, abort });
    try {
      const summary = await api.uploadAttachment(sessionId, file, auth, {
        signal: abort.signal,
        onProgress: (fraction) =>
          setUpload((u) => (u?.state === 'busy' ? { ...u, progress: fraction } : u)),
      });
      // rows is 0 for a non-tabular format, so only mention it when there is a table.
      setUpload({
        state: 'ok',
        text: `Attached ${summary.name}${summary.rows > 0 ? ` (${summary.rows} rows)` : ''}.`,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        setUpload(null);
        return;
      }
      setUpload({ state: 'failed', text: err instanceof Error ? err.message : 'Upload failed.' });
    }
  };

  /**
   * Route a dropped file: `.mol`/`.sdf` to the structure panel, anything else to the attachment
   * upload.
   */
  const takeDroppedFile = (file: File): void => {
    if (STRUCTURE_FILE.test(file.name)) {
      setDroppedFile({ at: Date.now(), file });
      setStructureOpen(true);
      return;
    }
    void onUpload(file);
  };

  return (
    <div
      id="composer"
      className={cn(
        'relative border-t border-border-subtle bg-surface-raised px-4 py-3 transition-colors',
        // env() clears the home indicator; --viewport-offset clears the iOS software keyboard,
        // which does not resize the layout viewport and so is invisible to dvh on its own.
        'pb-[calc(0.75rem+env(safe-area-inset-bottom)+var(--viewport-offset,0px))]',
        dragging && 'bg-brand-soft',
      )}
      // The whole composer region is the target, not the little box inside it: a drag carrying a
      // file is aimed roughly, and a 40px strip would be a target most drops miss.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the region. `dragleave` also fires as the
        // pointer crosses onto a child, which made the highlight strobe across the buttons.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) takeDroppedFile(file);
      }}
    >
      {dragging && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 -top-7 mx-auto w-fit rounded-md border border-brand bg-surface-raised px-2.5 py-1 text-xs text-brand-ink shadow-sm"
        >
          Drop a .mol or .sdf to read the structure — anything else is attached to the conversation
        </p>
      )}
      <div className="mx-auto w-full max-w-prose">
        {composerLock === 'turn_in_flight' && !isStreaming && (
          <p role="status" className="mb-2 text-xs text-warn-ink">
            A turn is already running for this conversation. Wait for it, or start a fresh session
            from the banner above.
          </p>
        )}
        {composerLock === 'budget_exhausted' && (
          <p role="alert" className="mb-2 text-xs text-danger-ink">
            The usage budget for this service is exhausted. New turns are refused until it resets.
          </p>
        )}
        {upload && (
          <div className="mb-2 flex items-center gap-2">
            {upload.state === 'busy' ? (
              <>
                <Loading size="xs">{upload.text}</Loading>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuenow={Math.round(upload.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-1 w-24 overflow-hidden rounded-full bg-surface-sunken"
                >
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-150"
                    style={{ width: `${Math.round(upload.progress * 100)}%` }}
                  />
                </div>
                <Button variant="ghost" size="xs" onClick={() => upload.abort.abort()}>
                  Cancel
                </Button>
              </>
            ) : (
              <p
                // A failed upload is an alert, distinct from a success.
                role={upload.state === 'failed' ? 'alert' : 'status'}
                className={cn(
                  'text-xs',
                  upload.state === 'failed' ? 'text-danger-ink' : 'text-ok-ink',
                )}
              >
                {upload.text}
              </p>
            )}
            {upload.state !== 'busy' && (
              <Button variant="ghost" size="xs" onClick={() => setUpload(null)}>
                Clear
              </Button>
            )}
          </div>
        )}

        <ExhibitRefChips conversationId={conversationId} />

        {pasted && (
          <PasteConfirmation
            pasted={pasted}
            onReplace={() => {
              const draft = useChatStore.getState().drafts[conversationId] ?? '';
              // Spliced at the recorded span, not by `String.replace` (which hits the first match
              // anywhere). If the span moved, the strip is stale and nothing is written.
              if (pasted.status === 'read' && spanHolds(draft, pasted)) {
                const before = draft.slice(0, pasted.at);
                const after = draft.slice(pasted.at + pasted.raw.length);
                setDraft(conversationId, `${before}${pasted.canonical}${after}`);
              }
              setPasted(null);
              textareaRef.current?.focus();
            }}
            onDismiss={() => setPasted(null)}
          />
        )}

        {structureOpen && (
          <StructureInput
            initialFile={droppedFile}
            onAccept={insertStructure}
            onClose={() => {
              setStructureOpen(false);
              setDroppedFile(null);
            }}
          />
        )}

        <div
          className={cn(
            'flex items-end gap-2 rounded-xl border bg-surface px-3 py-2 shadow-2xs transition-colors',
            // The wrapper carries the focus ring, because the textarea inside has no border of its
            // own. Before this, focusing the app's primary input showed nothing whatsoever.
            'focus-within:border-brand focus-within:ring-2 focus-within:ring-ring/25',
            tooLong ? 'border-danger' : 'border-border-subtle',
          )}
        >
          <label htmlFor="composer-input" className="sr-only-live">
            Message
          </label>
          <textarea
            id="composer-input"
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={composerLock === 'budget_exhausted'}
            aria-describedby={hintId}
            enterKeyHint={coarsePointer ? 'enter' : 'send'}
            autoCapitalize="sentences"
            spellCheck
            onChange={(e) => setDraft(conversationId, e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // An IME owns this Enter (`isComposing`, or `keyCode === 229` in browsers that do not
              // set it): it settles a candidate, it does not send.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                submit();
                return;
              }
              if (coarsePointer || e.shiftKey) return; // newline
              e.preventDefault();
              submit();
            }}
            placeholder="Ask about a reaction, a property, or what to run next…"
            className={cn(
              'max-h-50 min-h-6 flex-1 resize-none bg-transparent outline-none placeholder:text-ink-subtle',
              // >=16px on small screens, or iOS zooms the whole page in on focus.
              'text-[1rem] sm:text-base',
            )}
          />

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            // Restrict the picker to the types the service accepts.
            accept=".csv,.tsv,.txt,.json,.md,.pdf,.docx,.xlsx,text/*,application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
              e.target.value = '';
            }}
          />
          {/* Labelled, not just tooltipped: tooltips do not exist on touch. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Insert a structure"
                aria-expanded={structureOpen}
                className="tap-target sm:w-auto sm:px-2.5"
                onClick={() => {
                  // Read here, while the textarea still owns the selection. Once the panel opens
                  // it takes focus and `selectionStart` becomes the panel's own field.
                  caretRef.current = textareaRef.current?.selectionStart ?? null;
                  setStructureOpen((v) => !v);
                }}
              >
                <Hexagon />
                <span className="hidden text-xs sm:inline">Structure</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Paste, draw or drop a structure into this message</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Attach a working file"
                className="tap-target"
                disabled={!ready}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach a working file (CSV, SOP) to this conversation</TooltipContent>
          </Tooltip>

          {isStreaming ? (
            waitingInLine ? (
              <Button variant="outline" size="sm" onClick={stopStreaming}>
                <Undo2 className="size-3.5" />
                Withdraw
              </Button>
            ) : (
              <Button variant="destructive" size="sm" onClick={stopStreaming}>
                <Square className="size-3.5 fill-current" />
                Stop
              </Button>
            )
          ) : (
            // The label is visually replaced by an icon on narrow screens, so the name has to be
            // carried explicitly — otherwise the primary control of the app is unnamed on a phone.
            <Button size="sm" onClick={submit} disabled={!canSend} aria-label="Send">
              <Send className="sm:hidden" />
              <span className="hidden sm:inline">Send</span>
            </Button>
          )}
        </div>

        {/* min-h so the hint/counter swap does not shift the composer under the reader. */}
        <div className="mt-2 flex min-h-5 items-center justify-between gap-3 text-xs text-ink-muted">
          <div className="flex flex-wrap items-center gap-2">
            {/* Only before the session exists (the profile is fixed when it is minted), and only when there is a choice. */}
            {!sessionId && profiles.length > 1 && (
              <>
                <label htmlFor="profile" className="sr-only-live">
                  Agent profile
                </label>
                <select
                  id="profile"
                  value={profile}
                  onChange={(e) => setSessionProfile(conversationId, e.target.value)}
                  className="rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 text-xs outline-none focus-ring"
                >
                  <option value="">Default agent</option>
                  {profiles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Switch
              id="dry-run"
              checked={dryRun}
              onCheckedChange={setDryRun}
              aria-describedby="dry-run-hint"
            />
            {/* The backend's own dry_run: plan the turn without launching anything expensive. */}
            <Label htmlFor="dry-run" className="cursor-pointer text-xs font-normal">
              Dry run
            </Label>
            <span id="dry-run-hint" className="sr-only-live">
              Plan the turn without launching QM jobs or other expensive work.
            </span>
          </div>

          <span id={hintId} className="text-2xs">
            {text.length > maxChars * 0.8 ? (
              <span className={cn('tabular-nums', tooLong && 'text-danger-ink')}>
                {text.length.toLocaleString()} / {maxChars.toLocaleString()}
              </span>
            ) : (
              <span className="hidden sm:inline">
                {coarsePointer
                  ? 'Tap Send to submit'
                  : 'Enter to send · Shift+Enter for a new line'}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
