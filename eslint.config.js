/**
 * Lint rules, kept to the ones that catch classes of bug this codebase can actually produce.
 *
 * `react-hooks/exhaustive-deps` is the reason this file exists. The UI rebuild rewrote every
 * effect in the app — scroll pinning, visual-viewport tracking, media queries, the prefill
 * listener — and a stale closure in any of them fails silently and intermittently, which is the
 * worst way for a bug to fail. Reviewing for it by eye does not scale.
 *
 * `jsx-a11y` is here for the same reason the contrast script is: the accessibility work on this
 * branch is only as durable as the thing that re-checks it.
 *
 * The type-aware block below is the second reason, and it was measured rather than assumed:
 * `npx eslint --print-config` reported `parserOptions.project: {}` and not one type-checked rule,
 * because `tseslint.configs.recommended` is the NON-type-checked preset. So `no-floating-promises`
 * was absent in a codebase with 32 `void promise` sites — including the one `Composer` uses for
 * every Send, whose orchestrator ran five store writes outside its own `try`. `chatStore` records
 * what that costs when it fires: "no bubble, no answer, no banner, no lock. Send did nothing, for
 * ever."
 *
 * Only the three rules that catch that class are enabled, not the whole `recommendedTypeChecked`
 * preset. The rest of that preset is mostly `no-unsafe-*`, which fires all over code that
 * deliberately handles `unknown` at a process boundary — this file's own rule is that a lint rule
 * earns its place by catching a bug this codebase can produce.
 *
 * Pinned to ESLint 9 because eslint-plugin-jsx-a11y does not declare support for 10 yet.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The store deliberately discards keys by destructuring; `_`-prefixed names are intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `title` is not an accessible name, and this codebase used to lean on it heavily. Every
      // icon-only control now carries an aria-label; keep it that way.
      'jsx-a11y/control-has-associated-label': 'off', // too many false positives on Radix asChild
      'jsx-a11y/no-autofocus': 'error',

      // Two checkers disagree here and both are right, so the rule is widened rather than
      // silenced. `axe` fails a scrollable region that nothing inside it can focus — the content
      // past the edge is unreachable without a pointer — and the fix is `tabindex="0"` on the
      // scroller. This rule's default then objects that a `<pre>` or a `<div>` is not
      // interactive. The markup that satisfies both is a *named* `role="region"`, which is also
      // what WAI-ARIA recommends for a focusable scroll container, so `region` joins the allowed
      // roles. A bare `tabIndex` on an unnamed, unroled element is still an error.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'] }],
    },
  },

  // Type-aware linting, scoped to the application code that `tsconfig.json` actually includes.
  // `projectService` rather than a `project` glob: it resolves each file through the nearest
  // tsconfig, so nothing has to be listed twice and a new directory does not silently drop out of
  // the check.
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The three that catch a promise nobody is holding. `void` still silences the first
      // deliberately — that is what it is for — so an existing `void promise` is unaffected and a
      // NEW un-awaited call has to be marked as intended.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // A classic <script> that runs before the bundle: browser globals, no module semantics.
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },

  // Scripts and the fixture service are plain Node ESM, not typed application code.
  {
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);
