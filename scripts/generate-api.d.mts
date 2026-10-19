/** Types for the parts of `generate-api.mjs` that tests import. */

export interface PinnedContract {
  lock: {
    repository: string;
    path: string;
    commit: string;
    contract_version: string;
    sha256: string;
  };
  document: Record<string, unknown>;
}

/** The pinned contract, refused if the committed copy does not match its lock. */
export function loadPinned(): PinnedContract;

/** Every generated file as `{ path relative to the repository root: text }`. */
export function generate(input?: PinnedContract): Promise<Record<string, string>>;
