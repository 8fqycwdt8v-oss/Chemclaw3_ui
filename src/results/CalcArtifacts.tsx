/**
 * A calculation's stored by-products, as files a chemist can take away — the C4 story.
 *
 * `list_artifacts` answers with a list of `{artifact_ref, name, media_type, byte_size}` and
 * `fetch_artifact` with one of them plus its bounded text. Until the service had a byte route
 * (artefacts wave 2, `GET /calc-artifacts/content`), both were dead ends for "take the optimised
 * geometry or the Hessian into another package": the model saw truncated text and binaries were
 * refused by design. Each row now carries **Download**, which fetches the file itself.
 *
 * Its own module, loaded with the first result block that needs it, because the registry in
 * `renderers.tsx` is on the first load and this is not something the first load needs.
 *
 * **What it does not claim.** `fetch_artifact`'s text may be part of the file; `truncated` says so
 * above the text and the download is the whole thing. A size is the file's full size as stored,
 * never the length of what is on screen.
 */

import { Badge } from '@/components/ui/badge';
import { CalcArtifactDownload } from '../components/CalcArtifactDownload.tsx';
import { num, rows, str, type Json } from './shape.ts';
import type { ResultViewProps } from './renderers.tsx';

/** Bytes as a reader sizes a file — the stored size, in binary kilobytes and megabytes. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One row's fields, or `null` for a row that names no artifact this route could fetch. */
function entryOf(
  row: Json,
): { ref: string; name: string; type: string; size: number | null } | null {
  const ref = str(row.artifact_ref);
  if (!ref.includes('#')) return null;
  return {
    ref,
    name: str(row.name) || ref.slice(ref.lastIndexOf('#') + 1),
    type: str(row.media_type),
    size: num(row.byte_size),
  };
}

export function CalcArtifactsResult({ data, compact }: ResultViewProps): React.JSX.Element {
  const listed = rows(data.items).flatMap((row) => entryOf(row) ?? []);
  const single = listed.length === 0 ? entryOf(data) : null;

  if (single) {
    const text = str(data.text);
    const shown = compact && text.length > 400 ? `${text.slice(0, 400)}…` : text;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono">{single.name}</span>
          {single.type && <Badge>{single.type}</Badge>}
          {single.size !== null && <span className="text-ink-muted">{fileSize(single.size)}</span>}
          {data.truncated === true && <Badge tone="warn">part of the file</Badge>}
          <CalcArtifactDownload reference={single.ref} label="Download the whole file" />
        </div>
        {shown && (
          <pre
            tabIndex={0}
            role="region"
            aria-label={`${single.name} — the text the tool returned`}
            className="max-h-72 overflow-auto rounded-lg border border-border-subtle bg-surface-sunken p-3 font-mono text-2xs leading-relaxed whitespace-pre focus-ring"
          >
            {shown}
          </pre>
        )}
      </div>
    );
  }

  if (listed.length === 0) {
    // An empty list is a real answer (`list_artifacts`' own docstring): most calculations keep no
    // by-products. It is not "the calculation is missing".
    return <p className="text-xs text-ink-muted">This calculation kept no files.</p>;
  }

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Stored calculation files"
      className="overflow-x-auto rounded-lg border border-border-subtle focus-ring"
    >
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-sunken text-2xs tracking-wide text-ink-subtle uppercase">
          <tr>
            <th scope="col" className="px-2.5 py-2 font-medium">
              File
            </th>
            <th scope="col" className="px-2.5 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-2.5 py-2 text-right font-medium">
              Size
            </th>
            <th scope="col" className="px-2.5 py-2 font-medium">
              <span className="sr-only">Download</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {listed.map((entry) => (
            <tr key={entry.ref}>
              <td className="px-2.5 py-1.5 font-mono">{entry.name}</td>
              <td className="px-2.5 py-1.5">{entry.type || '—'}</td>
              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                {entry.size === null ? '—' : fileSize(entry.size)}
              </td>
              <td className="px-2.5 py-1.5">
                <CalcArtifactDownload reference={entry.ref} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
