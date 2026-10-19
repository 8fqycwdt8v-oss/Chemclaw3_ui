export const ROOT: string;
export function sha256(bytes: string | Uint8Array): string;
export function readLock(): {
  repository: string;
  path: string;
  commit: string;
  contract_version: string;
  sha256: string;
};
export function readCopy(): { bytes: Buffer; document: Record<string, unknown> };
