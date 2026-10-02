/**
 * Hand a blob to the browser as a file to save.
 *
 * Lifted out of `DownloadCsv` when artefact exports became a second caller — a CSV built in this
 * browser and a file the service rendered are saved the same way, and the two non-obvious rules
 * below were already paid for once.
 *
 * An object URL rather than a `data:` URI — a large table exceeds what some browsers will accept in
 * a URL. The anchor goes *in* the document and is revoked a tick later: Firefox ignores a click on
 * a detached anchor, and every browser starts the download asynchronously — revoking in the same
 * tick races the fetch the click just scheduled and yields an empty or failed save. A timeout is
 * the only handle available, since there is no event for "the download has read the blob".
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
