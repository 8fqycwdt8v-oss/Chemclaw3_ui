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
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Hexagon, Paperclip, Send, Square } from 'lucide-react';
import { MAX_MESSAGE_CHARS } from '../../shared/events.ts';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { sendMessage, stopStreaming, warmSession } from '../state/sendMessage.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label, Switch } from '@/components/ui/misc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loading } from '@/components/chem/Feedback';
import { useEntityStore } from '../chem/entities.ts';
import { StructureInput, type AcceptedStructure } from './StructureInput.tsx';

const MAX_TEXTAREA_PX = 200;

type Upload =
  | { state: 'busy'; text: string; progress: number; abort: AbortController }
  | { state: 'ok' | 'failed'; text: string }
  | null;

export function Composer({ conversationId }: { conversationId: string }): React.JSX.Element {
  const { auth, ready } = useAuth();
  const [dryRun, setDryRun] = useState(false);
  const [upload, setUpload] = useState<Upload>(null);
  const [structureOpen, setStructureOpen] = useState(false);
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
      const raw = (event as CustomEvent<string | { text: string; autoSend?: boolean }>).detail;
      const message = typeof raw === 'string' ? raw : raw.text;
      const autoSend = typeof raw === 'object' && raw.autoSend === true;
      setDraft(conversationId, message);
      if (autoSend) {
        autoSendRef.current?.(message);
      } else {
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('chemclaw:prefill', onPrefill);
    return () => window.removeEventListener('chemclaw:prefill', onPrefill);
  }, [conversationId, setDraft]);

  // The profiles this deployment offers, if more than one. Fetched once and cached in component
  // state rather than the store: it is a property of the service, not of a conversation, and the
  // composer outlives every conversation switch.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .listProfiles(() => auth.getAccessToken())
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
   * Put an accepted structure into the message being written — and nowhere else.
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
   */
  const insertStructure = ({ canonical, raw, source }: AcceptedStructure): void => {
    // The raw spelling, not the canonical one: the store canonicalises for the key and keeps what
    // was typed as an alias, so the rail can show a chemist the string they recognise.
    void useEntityStore.getState().ingestUserStructure(conversationId, raw, source);

    const at = caretRef.current ?? text.length;
    const before = text.slice(0, at);
    const after = text.slice(at);
    // A SMILES glued to the previous word is a different token, and `looksLikeSmiles` would be
    // right to refuse it. Pad only where padding is missing, so the chemist's own spacing survives.
    const fragment = `${before && !/\s$/.test(before) ? ' ' : ''}${canonical}${after && !/^\s/.test(after) ? ' ' : ''}`;

    setDraft(conversationId, `${before}${fragment}${after}`);
    setStructureOpen(false);

    const caret = before.length + fragment.length;
    // After the state has been committed and the textarea is back on screen; setting the range
    // against the pre-update value would put the caret in the wrong place.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

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
      const summary = await api.uploadAttachment(sessionId, file, () => auth.getAccessToken(), {
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

  return (
    <div
      id="composer"
      className={cn(
        'border-t border-border-subtle bg-surface-raised px-4 py-3',
        // env() clears the home indicator; --viewport-offset clears the iOS software keyboard,
        // which does not resize the layout viewport and so is invisible to dvh on its own.
        'pb-[calc(0.75rem+env(safe-area-inset-bottom)+var(--viewport-offset,0px))]',
      )}
    >
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

        {structureOpen && (
          <StructureInput onAccept={insertStructure} onClose={() => setStructureOpen(false)} />
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Insert a structure"
                className="tap-target"
                onClick={() => {
                  // Read here, while the textarea still owns the selection. Once the panel opens
                  // it takes focus and `selectionStart` becomes the panel's own field.
                  caretRef.current = textareaRef.current?.selectionStart ?? null;
                  setStructureOpen((v) => !v);
                }}
              >
                <Hexagon />
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
