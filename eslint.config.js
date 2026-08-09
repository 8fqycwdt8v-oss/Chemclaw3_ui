/**
 * Lint configuration.
 *
 * There was none at all before this — the only static analysis was `tsc -b`. TypeScript is strict
 * here (`strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`) and it still could not
 * catch the two classes of defect this codebase actually shipped:
 *
 *   - `react-hooks` flags the ref mutated during render in `Composer.tsx` and the effect
 *     dependency lists that re-subscribe the job-feed stream on every render.
 *   - `jsx-a11y` flags most of the accessibility gaps: the unlabelled textarea, the emoji-only
 *     buttons, the disclosure toggles with no `aria-expanded`.
 *
 * Type-aware linting is deliberately NOT enabled. It needs a full program per lint run, which on
 * this project costs more than `tsc -b` does for rules that mostly duplicate what strict mode
 * already rejects. The value here is the React and a11y plugins, which are syntactic.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The SPA.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Emoji-only controls are real here (📎 upload, ⌬ structure toggle). They must carry an
      // accessible name; a `title` alone is not reliably announced.
      'jsx-a11y/control-has-associated-label': 'warn',
    },
  },

  // The BFF and the shared contract: Node, no JSX.
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Build and dev scripts. These were included in tsconfig without `allowJs`, so nothing checked
  // them at all — a `.mjs` file could reference an undefined variable and no command would say so.
  {
    // Node-side tooling: build scripts, config files, and the E2E harness (its mock backend is a
    // real Node server, and its specs run under Playwright rather than in the browser).
    files: ['scripts/**/*.mjs', 'e2e/**/*.{mjs,ts}', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Scripts legitimately talk to the operator.
      'no-console': 'off',
    },
  },

  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Tests reach into partial shapes on purpose when pinning coercion behaviour.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    rules: {
      // `_`-prefixed names are the established convention here for deliberate discards, e.g. the
      // destructuring omit in `chatStore.deleteConversation`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
);
