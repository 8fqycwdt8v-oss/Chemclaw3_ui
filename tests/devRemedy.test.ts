/**
 * The remedy a reader is told to follow names a module the backend actually has.
 *
 * Three places once told a reader to start the service with `uvicorn service.app:create_app`.
 * There is no `service` package — the factory is `chemclaw.api.app:create_app`, and the old string
 * exits with `ModuleNotFoundError`. It is the first instruction somebody follows after the dev
 * proxy fails to connect, which is the worst possible place for it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const FACTORY = 'chemclaw.api.app:create_app';

describe('the remedy names a module the backend actually has', () => {
  it.each(['scripts/dev.mjs', 'README.md'])(
    '%s tells the reader to run the factory that exists',
    (file) => {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(`uvicorn ${FACTORY}`);
      expect(text, `${file} still names a module the backend does not have`).not.toContain(
        'service.app:create_app',
      );
    },
  );
});
