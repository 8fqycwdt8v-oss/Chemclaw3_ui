/**
 * Start authentication at module scope, before React renders, so the session check leaves the
 * critical path to first paint and a StrictMode double-invoke cannot start it twice. Under `bff`
 * this is one `GET /auth/session`; a signed-out visitor is sent to sign in from here, so no
 * component ever renders against "nobody". Under `dev` it buys essentially nothing —
 * `createDevAuth()` is a pure object literal.
 */

import { createAuthProvider } from './index.ts';
import type { AuthProvider } from './types.ts';

export const authReady: Promise<AuthProvider> = createAuthProvider();
