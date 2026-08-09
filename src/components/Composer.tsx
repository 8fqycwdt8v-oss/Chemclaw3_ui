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
import { Paperclip, Send, Square } from 'lucide-react';
import { MAX_MESSAGE_CHARS } from '../../shared/events.ts';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { sendMessage, stopStreaming } from '../state/sendMessage.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label, Switch } from '@/components/ui/misc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loading } from '@/components/chem/Feedback';

const MAX_TEXTAREA_PX = 200;

type Upload = { state: 'busy' | 'ok' | 'failed'; text: string } | null;

export function Composer({ conversationId }: { conversationId: string }): React.JSX.Element {
  const { auth } = useAuth();
  const [dryRun, setDryRun] = useState(false);
  const [upload, setUpload] = useState<Upload>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  const composerLock = useChatStore((s) => s.composerLock);
  const streaming = useChatStore((s) => s.streaming);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);
  const text = useChatStore((s) => s.drafts[conversationId] ?? '');
  const setDraft = useChatStore((s) => s.setDraft);

  // A soft keyboard cannot produce Shift+Enter, so Enter has to mean "newline" there.
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.('(pointer: coarse)');
    if (!query) return;
    setCoarsePointer(query.matches);
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
  autoSendRef.current = (message: string) => {
    const isBlocked =
      useChatStore.getState().composerLock !== false || useChatStore.getState().streaming !== null;
    if (isBlocked || message.length > MAX_MESSAGE_CHARS || !message.trim()) return;
    setDraft(conversationId, '');
    void sendMessage({ conversationId, text: message, dryRun, auth });
  };

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
  const canSend = !blocked && !tooLong && text.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    const message = text;
    setDraft(conversationId, '');
    void sendMessage({ conversationId, text: message, dryRun, auth });
  };

  const onUpload = async (file: File): Promise<void> => {
    if (!sessionId) {
      setUpload({
        state: 'failed',
        text: 'Send a message first so the conversation has a session.',
      });
      return;
    }
    setUpload({ state: 'busy', text: `Uploading ${file.name}…` });
    try {
      const summary = await api.uploadAttachment(sessionId, file, () => auth.getAccessToken());
      // rows is 0 for a non-tabular format, so only mention it when there is a table.
      setUpload({
        state: 'ok',
        text: `Attached ${summary.name}${summary.rows > 0 ? ` (${summary.rows} rows)` : ''}.`,
      });
    } catch (err) {
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
              <Loading size="xs">{upload.text}</Loading>
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
                aria-label="Attach a working file"
                className="tap-target"
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
          <div className="flex items-center gap-2">
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
                {coarsePointer ? 'Tap Send to submit' : 'Enter to send · Shift+Enter for a new line'}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
