/**
 * What one tool call returned — as a typed card when the result has a shape we render, and as the
 * preview it has always been otherwise.
 *
 * **Fetched only when a chemist expands the row.** That is not laziness for its own sake: the
 * 200-character preview exists because the turn stream fans out to every consumer and "never a
 * whole evidence sweep streamed to a browser" is the budget it protects. Pulling every result as
 * it arrived would spend that budget from the other end. One result, once, because somebody
 * decided to look at it — which is the exact trade the backend's `result_ref` was added to make
 * possible.
 *
 * **Every path degrades to today's behaviour.** No ref (an older backend, a store that is off, a
 * result over the byte cap, a write that failed), no session, a failed fetch, a result that is not
 * JSON, a shape nothing here recognises — all of them land on the same `<pre>` of the same
 * preview. A deployment that never gets the backend change is unaffected by any of this.
 *
 * **Nothing chemical is ever read out of the preview.** It is cut at an arbitrary byte, and a
 * SMILES cut short frequently stays valid as a smaller, wrong molecule; the whole point of having
 * a ref is that a structure now comes from the fetched payload or from nowhere.
 */

import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { useAuth } from '../../auth/AuthContext.tsx';
import { isFetchableRef, parseResultText, storedText } from '../../chem/results.ts';
import { useChatStore } from '../../state/chatStore.ts';
import { CitedFlags } from './CitedFlags.tsx';
import { Ranked } from './Ranked.tsx';
import { RowTable } from './RowTable.tsx';
import { ValueCard } from './ValueCard.tsx';
import { detectResult, type DetectedResult } from './shapes.ts';

/** The preview, exactly as the panel showed it before any of this existed. */
function Preview({ preview }: { preview: string }): React.JSX.Element {
  return (
    <>
      <p className="text-xs text-ink-muted">returned</p>
      {/* Raw and truncated server-side; never parsed, and never mined for chemistry. */}
      <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
        {preview}
      </pre>
    </>
  );
}

function Card({ result }: { result: DetectedResult }): React.JSX.Element {
  switch (result.kind) {
    case 'cited-flags':
      return <CitedFlags result={result} />;
    case 'ranked':
      return <Ranked result={result} />;
    case 'rows':
      return <RowTable result={result} />;
    case 'value':
      return <ValueCard result={result} />;
  }
}

type Phase =
  | 'idle'
  | 'loading'
  /** Fetched, parsed, and a renderer claimed it. */
  | 'shown'
  /** Fetched, but nothing here recognises the shape — a supported outcome, not a failure. */
  | 'unrendered'
  /** The fetch or the decode failed. The preview stands, and the row says the read did not. */
  | 'failed';

function Fetchable({
  tool,
  preview,
  sessionId,
  resultRef,
}: {
  tool: string;
  preview: string;
  sessionId: string;
  resultRef: string;
}): React.JSX.Element {
  const { auth } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<DetectedResult | null>(null);

  // Through a ref, so the callback below does not change identity on every render — `useAuth()`
  // hands back a fresh object each time, and a dependency on it would re-create the handler under
  // every state change this component makes.
  const authRef = useRef(auth);
  authRef.current = auth;
  const token = useCallback((): Promise<string | null> => authRef.current.getAccessToken(), []);

  const load = useCallback(() => {
    // Hiding a card and opening it again is a change of mind, not a new question. The result is
    // content-addressed and immutable, so a second request could only return the same bytes.
    if (result) {
      setPhase('shown');
      return;
    }
    setPhase('loading');
    void (async () => {
      try {
        const stored = await api.getToolResult(sessionId, resultRef, token);
        const text = storedText(stored);
        const detected = text === null ? null : detectResult(tool, parseResultText(text));
        setResult(detected);
        setPhase(detected ? 'shown' : 'unrendered');
      } catch {
        // Every cause lands here on purpose — a backend without the route, a ref retention has
        // swept, a session that was rotated out from under this transcript, an expired token. The
        // chemist's next step is the same for all of them and they already have it on screen.
        setPhase('failed');
      }
    })();
  }, [result, resultRef, sessionId, token, tool]);

  return (
    <div>
      {phase === 'shown' && result ? (
        <>
          <div className="rounded-md border border-border-subtle bg-surface p-3">
            <Card result={result} />
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-ink-muted">
              what the service streamed (truncated)
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
              {preview}
            </pre>
          </details>
        </>
      ) : (
        <Preview preview={preview} />
      )}

      {phase === 'idle' && (
        <button
          type="button"
          onClick={load}
          className="mt-1 text-xs text-accent underline underline-offset-2"
        >
          Render the full result
        </button>
      )}
      {phase === 'loading' && <p className="mt-1 text-xs text-ink-muted">reading the result…</p>}
      {phase === 'unrendered' && (
        // Read successfully; simply not a shape with a card. Saying so is the difference between
        // "we could not fetch this" and "we fetched it and have no better rendering than the text".
        <p className="mt-1 text-xs text-ink-muted">
          The full result was read and is not a shape this panel cards. The preview above is what
          the service streamed.
        </p>
      )}
      {phase === 'failed' && (
        <p className="mt-1 text-xs text-ink-muted">
          The full result could not be read, so this is the truncated preview.
        </p>
      )}
      {phase === 'shown' && (
        <button
          type="button"
          onClick={() => setPhase('idle')}
          className="mt-1 text-xs text-ink-muted underline underline-offset-2"
        >
          Hide the card
        </button>
      )}
    </div>
  );
}

export function ResultCard({
  tool,
  preview,
  resultRef,
}: {
  tool: string;
  preview: string;
  resultRef?: string | undefined;
}): React.JSX.Element {
  // The session the ref is scoped to. Read here rather than passed down, because the panel's own
  // caller has no session in hand — and read from the active conversation, which is the one whose
  // transcript this row is in. A conversation whose session was rotated (the 404 path) can no
  // longer resolve its older refs, and that fetch 404s into the preview, which is correct: the
  // result belonged to a conversation the service no longer has.
  const sessionId = useChatStore((s) =>
    s.activeId ? (s.conversations[s.activeId]?.sessionId ?? null) : null,
  );

  // Deliberately short-circuited *before* anything that touches auth or the network: a row with
  // nothing to fetch must cost nothing and must render exactly what it rendered before.
  if (!isFetchableRef(resultRef) || !sessionId) return <Preview preview={preview} />;

  return <Fetchable tool={tool} preview={preview} sessionId={sessionId} resultRef={resultRef} />;
}
