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
