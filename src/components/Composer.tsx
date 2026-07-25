/**
 * The message composer.
 *
 * Two backend facts shape this component:
 *  - Turns are serialised per session and a second concurrent POST is a hard 409, not a queue.
 *    So the send control is disabled for the whole streamed turn rather than optimistically
 *    accepting input.
 *  - Messages over the service's character cap are a 422. We show the counter as it approaches
 *    and block the send, rather than letting the user write an essay and then lose it.
 */

import { useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_CHARS } from '../../shared/events.ts';
import { api } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useChatStore } from '../state/chatStore.ts';
import { sendMessage, stopStreaming } from '../state/sendMessage.ts';
import { cn } from '../lib/cn.ts';

export function Composer({ conversationId }: { conversationId: string }): React.JSX.Element {
  const { auth } = useAuth();
  const [text, setText] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const composerLock = useChatStore((s) => s.composerLock);
  const streaming = useChatStore((s) => s.streaming);
  const sessionId = useChatStore((s) => s.conversations[conversationId]?.sessionId ?? null);

  // Citation chips and prompt buttons hand text back through a window event rather than being
  // wired through the tree — they are rendered deep inside markdown output.
  useEffect(() => {
    const onPrefill = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      setText(detail);
      textareaRef.current?.focus();
    };
    window.addEventListener('chemclaw:prefill', onPrefill);
    return () => window.removeEventListener('chemclaw:prefill', onPrefill);
  }, []);

  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const isStreaming = streaming !== null;
  const blocked = composerLock !== false || isStreaming;

  const submit = (): void => {
    if (blocked || tooLong || !text.trim()) return;
    const message = text;
    setText('');
    void sendMessage({ conversationId, text: message, dryRun, auth });
  };

  const onUpload = async (file: File): Promise<void> => {
    if (!sessionId) {
      setUploading('Send a message first so the conversation has a session.');
      return;
    }
    setUploading(`Uploading ${file.name}…`);
    try {
      const summary = await api.uploadAttachment(sessionId, file, () => auth.getAccessToken());
      // rows is 0 for a non-tabular format, so only mention it when there is a table.
      setUploading(`Attached ${summary.name}${summary.rows > 0 ? ` (${summary.rows} rows)` : ''}.`);
    } catch (err) {
      setUploading(err instanceof Error ? err.message : 'Upload failed.');
    }
  };

  return (
    <div className="border-t border-border-subtle bg-surface-raised px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {composerLock === 'turn_in_flight' && !isStreaming && (
          <p className="mb-2 text-xs text-warn">
            A turn is already running for this conversation. Wait for it, or start a fresh session
            from the banner above.
          </p>
        )}
        {composerLock === 'budget_exhausted' && (
          <p className="mb-2 text-xs text-danger">
            The usage budget for this service is exhausted. New turns are refused until it resets.
          </p>
        )}
        {uploading && <p className="mb-2 text-xs text-ink-muted">{uploading}</p>}

        <div
          className={cn(
            'flex items-end gap-2 rounded-xl border bg-surface px-3 py-2',
            tooLong ? 'border-danger' : 'border-border-subtle',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={composerLock === 'budget_exhausted'}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. Standard for a chat surface.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask about a reaction, a property, or what to run next…"
            className="max-h-50 min-h-6 flex-1 resize-none bg-transparent text-[0.95rem] outline-none placeholder:text-ink-muted"
          />

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            title="Attach a working file (CSV, SOP) to this conversation"
            onClick={() => fileRef.current?.click()}
            className="rounded px-1.5 py-1 text-ink-muted hover:bg-surface-sunken"
          >
            📎
          </button>

          {isStreaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={blocked || tooLong || !text.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between text-xs text-ink-muted">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            {/* The backend's own dry_run: plan the turn without launching anything expensive. */}
            <span title="Plan the turn without launching QM jobs or other expensive work">
              Dry run
            </span>
          </label>
          {text.length > MAX_MESSAGE_CHARS * 0.8 && (
            <span className={tooLong ? 'text-danger' : undefined}>
              {text.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
