/**
 * The message composer.
 *
 * Two backend facts shape this component:
 *  - Turns are serialised per session and a second concurrent POST is a hard 409, not a queue.
 *    So the send control is disabled for the whole streamed turn rather than optimistically
 *    accepting input.
 *  - Messages over the service's character cap are a 422. We show the counter as it approaches
 *    and block the send, rather than letting the user write an essay and then lose it.
 *
 * The Enter key is decided by pointer type, not by convention. A soft keyboard has no Shift, so
 * "Enter sends, Shift+Enter for a newline" means a phone user cannot write a multi-line message at
 * all — on a tool whose users paste procedures. On a coarse pointer Enter inserts a newline and
 * the Send button is the only way to submit; Cmd/Ctrl+Enter sends everywhere.
 *
 * The draft lives in the store, keyed by conversation. As component state on a component that does
 * not unmount when `conversationId` changes, it leaked: you could type in one conversation, switch
 * to another, and send the first one's text into the second.
 *
 * ## The paste is confirmed, because the paste is what people do
 *
 * `StructureInput` is built on one rule — a chemist must never send a structure they have not seen
 * — and for a while the fastest way in went round it. Pasting a SMILES out of ChemDraw, an Excel
 * column or a colleague's mail put an unchecked string straight into the message: no
 * canonicalisation, no drawing, no rail row. The safest path was behind an unlabelled hexagon and
 * the unguarded one was the muscle memory everybody already had.
 *
 * `PasteConfirmation` closes that. It is deliberately **not** a dialog: the paste itself is never
 * intercepted, the text lands exactly as pasted, and a strip appears above the composer a beat
 * later showing what RDKit made of it. A chemist who pasted the right thing loses nothing and can
 * keep typing; one who pasted the wrong thing sees it before they press Send. Blocking the caret
 * to demand an acknowledgement would tax the correct case to catch the rare one.
 *
 * ## Dropping a file anywhere here used to navigate the browser away
 *
 * A page with no drop handler hands a dropped file to the browser, which opens it — losing the
 * draft and the whole app with it. So the composer is a drop target for structures and working
 * files alike, and a window-level guard turns a *missed* drop into nothing at all rather than into
 * a navigation.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Hexagon, Paperclip, Send, Square, X } from 'lucide-react';
import { MAX_MESSAGE_CHARS } from '../../shared/events.ts';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { sendMessage, stopStreaming, warmSession } from '../state/sendMessage.ts';
import {
  INSERT_STRUCTURE_EVENT,
  PREFILL_EVENT,
  type InsertStructureDetail,
  type PrefillDetail,
} from '../state/composerEvents.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label, Switch } from '@/components/ui/misc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loading } from '@/components/chem/Feedback';
import { useEntityStore } from '../chem/entities.ts';
import { canonicalSmilesFromMolblock, rdkitAvailable } from '../chem/rdkit.ts';
import { looksLikeMolblock } from '../chem/recognise.ts';
import { mightBeStructure, readStructure } from '../chem/structure.ts';
import { Molecule } from './Molecule.tsx';
// `STRUCTURE_FILE` from the panel itself: a file dropped here goes to the panel or to the
// attachment route, and which one is the panel's rule about what it can read.
import { STRUCTURE_FILE, StructureInput, type AcceptedStructure } from './StructureInput.tsx';

/**
 * What a paste turned out to be, once RDKit had looked at it — and **where it landed**.
 *
 * The span is the load-bearing part. A confirmation that knows only its own text cannot say which
 * occurrence of that text it is about, and SMILES collide constantly because every one of them is
 * an infix of larger ones: with `compare OCCO with ` in the box, pasting `OCC` and accepting the
 * canonical form rewrote the *glycol* to `CCOO` — ethyl hydroperoxide, a real and different
 * compound — and left the pasted token alone, with nothing on screen saying anything had changed.
 *
 * So a check names a span, `raw` at `at`, and both the write-back and the invalidation below ask
 * the same question of it: does the draft still say exactly this, exactly there?
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
);

/**
 * Does the draft still hold this check's text, at its position, as a whole token?
 *
 * Asked in one place so the write-back and the invalidation cannot answer it differently. All
 * three clauses earn their place: the text, or the strip is about something else; the position,
 * or `OCC` matches inside `OCCO`; and the boundaries, because typing `Cl` onto a pasted `OCC`
 * leaves the span itself untouched while the message now names 2-chloroethanol.
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

/** What the strip calls each thing it can be handed. A molblock is named as one because the
 *  chemist pasted ten lines of MDL and needs to see that it was understood as a structure. */
const PASTE_LABEL: Record<'molecule' | 'reaction' | 'molblock', string> = {
  molecule: 'Pasted structure',
  reaction: 'Pasted reaction',
  molblock: 'Pasted molfile',
};

/**
 * "This is what I understood you to paste."
 *
 * The confirmation `StructureInput` gives a typed or drawn structure, given to a pasted one — and
 * given the way a paste can afford, which is quietly. It appears above the composer, it does not
 * take focus, it does not block the caret, and it stays until it is used or dismissed.
 *
 * What it shows is decided by whether RDKit's reading matches the chemist's spelling. When it does
 * — the overwhelmingly common case, because most SMILES a chemist copies are already canonical —
 * there is nothing to offer and the strip is purely a picture saying "yes, that one". When it does
 * not, the difference is the whole point: `BrC1=CC=C(OC)C=C1` and `COc1ccc(Br)cc1` are one compound
 * with two spellings, and only one of them is the entity key the rest of this app will file it
 * under.
 *
 * Replacing is offered, never performed. The chemist's own spelling is valid input — the backend
 * canonicalises everything it is given — so rewriting their message under them would be taking a
 * decision that is not this component's to take.
 *
 * ## It says the negative cases too
 *
 * It used to be asymmetric in exactly the wrong direction: a picture when the paste was fine, and
 * nothing whatsoever when the app already knew the string was not a molecule or that RDKit had
 * never loaded. Those are the two the chemist needed, and they are the two that reached the
 * message unremarked, which is the silence this whole control exists to close.
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
      // "status" while nothing is wrong: interrupting a chemist who pasted the right structure to
      // tell them it was the right structure is how a signal gets trained away. The other two
      // states are something being wrong about the message they are holding, and an assertive
      // announcement is what a screen-reader user gets instead of a picture they cannot see.
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
  /** A structure file dropped on the composer, handed to the panel to read. Carries the drop it
   *  came from, so dropping the same file twice re-reads it — the panel keys its own reset on
   *  this object's identity, and two drops of one file are two intentions. */
  const [droppedFile, setDroppedFile] = useState<{ at: number; file: File } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** What the last paste turned out to be, or null. Cleared by the next paste, by using it, by
   *  dismissing it, and by the draft moving out from under it — never on a timer, because a strip
   *  that vanishes while a chemist is reading it is worse than no strip. */
  const [pasted, setPasted] = useState<PasteCheck | null>(null);
  /** Every paste gets a number and only the newest may write the strip. Two pastes start two
   *  independent reads, and a reaction resolves later than a molecule — it awaits every component
   *  of both sides — so the slower, older one used to win and its button then acted on that older
   *  string. */
  const pasteSeq = useRef(0);
  /**
   * The two facts that tell "the paste has not landed yet" from "the chemist edited it".
   *
   * The read can finish on a microtask that runs *before* the browser has inserted the pasted
   * text, so a draft that does not hold the span is not evidence of an edit while it is still
   * exactly the draft the paste started from. Once it is anything else — or once the span has
   * been seen to hold and then stopped holding, which is what an undo looks like — it is.
   */
  const pasteBefore = useRef('');
  const pasteLanded = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Where the caret was when the structure panel took focus. Captured on open rather than read
   *  back on insert, because by then the caret belongs to the panel's own input. */
  const caretRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  const composerLock = useChatStore((s) => s.composerLock);
  // Scoped to THIS conversation. A global check locked the composer in every conversation while
  // one of them streamed — invisible before the router, routine once Back can switch in a
  // keypress.
  const streaming = useChatStore((s) =>
    s.streaming?.conversationId === conversationId ? s.streaming : null,
  );
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const profile = useChatStore((s) => s.sessionProfiles[conversationId] ?? '');
  const setSessionProfile = useChatStore((s) => s.setSessionProfile);
  const [profiles, setProfiles] = useState<string[]>([]);
  const text = useChatStore((s) => s.drafts[conversationId] ?? '');
  const setDraft = useChatStore((s) => s.setDraft);

  // A soft keyboard cannot produce Shift+Enter, so Enter has to mean "newline" there. Read once
  // at mount rather than set from inside the effect: the effect version rendered twice, and the
  // first render had the wrong key behaviour.
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

  // Citation chips and prompt buttons hand text back through a window event rather than being
  // wired through the tree — they are rendered deep inside markdown output.
  //
  // The detail may be a plain string (prefill only) or { text, autoSend: true } (approval
  // buttons — skips the "type and press Send" step so the user gets one-tap approve/decline).
  // We use a ref so the handler always sees the current blocked/dryRun/conversationId values
  // without being recreated on every render.
  const autoSendRef = useRef<((message: string) => void) | null>(null);
  // Refreshed after every commit rather than assigned during render: a ref write in the render
  // body is a side effect, and under StrictMode's double render it happens twice.
  useEffect(() => {
    autoSendRef.current = (message: string) => {
      const isBlocked =
        useChatStore.getState().composerLock !== false ||
        useChatStore.getState().streaming !== null;
      if (isBlocked || message.length > MAX_MESSAGE_CHARS || !message.trim()) return;
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
   * Put a structure into the draft at the caret.
   *
   * The single implementation, reached three ways: the structure panel's Insert, the
   * `chemclaw:insert-structure` event that every rendered structure in the app now dispatches, and
   * the paste strip's "replace with the canonical form". They must agree about padding and about
   * where the caret lands afterwards, and the only way to guarantee that is for there to be one of
   * them.
   *
   * `caretAt` is read from the ref when the panel captured it and from the live textarea otherwise
   * — an event arriving from a rail row has no captured caret, and appending at `text.length` would
   * put a structure at the end of a sentence the chemist was writing in the middle of.
   */
  const putStructure = useCallback(
    (canonical: string, caretAt: number): void => {
      const draft = useChatStore.getState().drafts[conversationId] ?? '';
      const at = Math.min(Math.max(caretAt, 0), draft.length);
      const before = draft.slice(0, at);
      const after = draft.slice(at);
      // A SMILES glued to the previous word is a different token, and `looksLikeSmiles` would be
      // right to refuse it. Pad only where padding is missing, so the chemist's own spacing
      // survives.
      const fragment = `${before && !/\s$/.test(before) ? ' ' : ''}${canonical}${after && !/^\s/.test(after) ? ' ' : ''}`;

      setDraft(conversationId, `${before}${fragment}${after}`);

      const caret = before.length + fragment.length;
      // After the state has been committed and the textarea is back on screen; setting the range
      // against the pre-update value would put the caret in the wrong place.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        el?.setSelectionRange(caret, caret);
      });
    },
    [conversationId, setDraft],
  );

  /**
   * A structure somewhere in the app was handed back to be used.
   *
   * Inserted at the *live* caret rather than at `caretRef`, which only holds a position when the
   * structure panel captured one. The dispatcher is a rail row, a search hit or an inline span,
   * none of which took focus off the textarea, so `selectionStart` is still the chemist's own
   * cursor — and appending at the end would drop a structure after a sentence they were editing
   * in the middle of.
   *
   * Not promoted to the rail: every structure that can dispatch this is one the rail either
   * already holds or has deliberately declined to hold, so admitting it here would either be a
   * no-op or a way round the promotion rule.
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

  /**
   * A file dropped anywhere else on the window is swallowed.
   *
   * Without this the browser's default takes over and *navigates to the file* — the draft, the
   * conversation and the whole app go with it. A chemist dragging a `.mol` and missing the
   * composer by ten pixels should get nothing, not a lost afternoon.
   */
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

  // The profiles this deployment offers, if more than one. Fetched once and cached in component
  // state rather than the store: it is a property of the service, not of a conversation, and the
  // composer outlives every conversation switch.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listProfiles(auth)
      .then((list) => !cancelled && setProfiles(list))
      // Silent: a service without the route has exactly one profile, and a banner about a
      // picker nobody asked for would be noise.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, auth]);

  // Mint the backend session while they type, so the first send is one round-trip rather than
  // two. Debounced, so a stray keypress in a conversation they abandon does not cost a session;
  // gated on `ready`, because under Entra a pre-token POST /sessions is just a 401.
  useEffect(() => {
    if (!ready || !text.trim() || sessionId) return;
    const timer = setTimeout(() => warmSession(conversationId, auth), 300);
    return () => clearTimeout(timer);
  }, [text, ready, sessionId, conversationId, auth]);

  // Auto-grow, driven from the value rather than the change event so it also shrinks back after a
  // send. Previously the inline height survived clearing the text, leaving a tall empty box.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const isStreaming = streaming !== null;
  const blocked = composerLock !== false || isStreaming;
  // Typing stays open while auth resolves — that is the point of painting the shell early, and
  // `warmSession` needs the keystrokes. Only the two things that need a token are held back.
  const canSend = ready && !blocked && !tooLong && text.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    const message = text;
    setDraft(conversationId, '');
    void sendMessage({ conversationId, text: message, dryRun, auth });
  };

  /**
   * Accept a structure from the panel — into the message, and nowhere else.
   *
   * It is inserted at the caret rather than sent, because a structure is almost never the whole
   * question: "screen this for hazards" and "what is the pKa of this" are what a chemist is
   * actually writing, and a panel that sent the SMILES on its own would force them to describe the
   * molecule twice.
   *
   * It is also promoted into the entity rail. A structure a human drew or dropped and confirmed
   * satisfies the rail's structured-source rule rather than weakening it — the rule exists to keep
   * out strings the UI *guessed* were molecules, and there is no guess here (see the
   * promotion-rule docstring in `src/chem/entities.ts`).
   *
   * The panel stays open when the file it is showing holds more than one structure. Closing it was
   * right for the single-structure case and made inserting record 2 of 12 cost a full reopen —
   * hexagon, re-drop, step, Insert — for every record after the first.
   */
  const insertStructure = ({ canonical, raw, source, moreRecords }: AcceptedStructure): void => {
    // The raw spelling, not the canonical one: the store canonicalises for the key and keeps what
    // was typed as an alias, so the rail can show a chemist the string they recognise.
    void useEntityStore.getState().ingestUserStructure(conversationId, raw, source);
    putStructure(canonical, caretRef.current ?? text.length);
    if (!moreRecords) setStructureOpen(false);
  };

  /**
   * Look at what was just pasted, and say what RDKit made of it.
   *
   * The paste is **never** intercepted — `preventDefault` is not called and the text lands exactly
   * as pasted. Only a paste that is one whitespace-free token is even asked about, which is what
   * keeps this off the path of somebody pasting a paragraph of a procedure: a structure arrives as
   * a token, and prose does not.
   *
   * A molecule is promoted into the rail here, and that is the same door `ingestUserStructure`
   * opens for the panel rather than a way round it. Read the promotion rule for what it defends
   * against — *inference*. There is none here: a human put this exact string on their clipboard,
   * and the strip draws it back to them at the moment it is admitted.
   *
   * A reaction is drawn and not promoted. `ingestUserStructure` canonicalises, a molecule toolkit
   * cannot canonicalise a reaction, and inventing a second user-supplied door for a case nobody has
   * asked for would be surface without a caller.
   *
   * What is recorded is a **span** — the text and the caret it went in at — because the strip's
   * one button rewrites the draft, and a rewrite that only knows its own text cannot say which
   * occurrence of it to touch.
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

    // A molblock is looked at *before* the whitespace guard below, because it is multi-line by
    // definition: the most common copy-out of a drawing package was the one payload no paste path
    // handled, while the file-drop path parsed byte-identical content happily. It is kept
    // verbatim — a molblock's header is four fixed lines and the first is routinely blank, so
    // trimming it would shift the counts line and destroy the file.
    if (looksLikeMolblock(clip)) {
      void canonicalSmilesFromMolblock(clip).then(async (canonical) => {
        if (!canonical) {
          show(await refusal(clip, caret));
          return;
        }
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
   * A confirmation that outlives its subject is worse than none.
   *
   * The strip is bound to a span of the draft, not to a string, so editing that span withdraws it:
   * it used to keep drawing ethanol over `OCCCl` — 2-chloroethanol — and its button then spliced
   * the canonical form into the middle of the edited token, producing `CCOCl`. Displayed: ethanol.
   * Transmitted: ethyl hypochlorite.
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
   * Route a dropped file to the surface that can read it.
   *
   * A `.mol`/`.sdf` opens the structure panel already holding it; anything else goes to the
   * attachment route, which is what the paperclip beside this does and what a dropped CSV almost
   * certainly means. Neither destination is new — the drop is just a second way to reach them.
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
                // A failed upload used to look exactly like a successful one — same muted grey, in
                // the same place — and neither ever cleared.
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

        {pasted && (
          <PasteConfirmation
            pasted={pasted}
            onReplace={() => {
              const draft = useChatStore.getState().drafts[conversationId] ?? '';
              // Spliced at the recorded span rather than replaced by value: the chemist pasted it
              // into a sentence and the sentence should keep its shape, but `String.replace` with
              // a string pattern rewrites the *first* match anywhere in the draft, which is a
              // different molecule whenever the pasted one is an infix of something already
              // there. If the span has moved under us the strip is stale, and the right thing to
              // do is drop it without writing anything.
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
            // The tooltip has always said "CSV, SOP"; without this every file type was offerable
            // and the rejection happened server-side, after the upload.
            accept=".csv,.tsv,.txt,.json,.md,.pdf,.docx,.xlsx,text/*,application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
              e.target.value = '';
            }}
          />
          {/* Named, not just tooltipped. This is the domain-defining control of a chemistry app
              and it was an unlabelled hexagon — a tooltip does not exist on touch, which is the
              pointer a bench chemist has. The word appears wherever there is room for it, on the
              same icon-at-narrow pattern Send uses. */}
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
            <Button variant="destructive" size="sm" onClick={stopStreaming}>
              <Square className="size-3.5 fill-current" />
              Stop
            </Button>
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
            {/* Only before the session exists: the profile is fixed on the service when the
                session is minted, so offering the choice afterwards would be offering a control
                that silently does nothing. And only when there is a choice to make. */}
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
            {text.length > MAX_MESSAGE_CHARS * 0.8 ? (
              <span className={cn('tabular-nums', tooLong && 'text-danger-ink')}>
                {text.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
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
