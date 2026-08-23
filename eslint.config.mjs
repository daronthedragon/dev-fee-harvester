import js from '@eslint/js';
import globals from 'globals';
import html from 'eslint-plugin-html';

/**
 * Lint rules, chosen for the bugs this codebase can actually have.
 *
 * The recommended set does the heavy lifting. Everything added on top is a
 * rule that would have caught something real here: an unused export left
 * behind by a refactor, a promise whose rejection nobody handles, a `catch`
 * that swallows a failure — that last one being the exact shape of the
 * mistakes this project has had to fix twice.
 *
 * No stylistic rules. Formatting is consistent already, and a mass reformat
 * would bury the history under a diff nobody can review.
 */
export default [
  {
    ignores: ['node_modules/**', 'pw-browsers/**', 'assets/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',        // `catch {}` and unused error bindings are deliberate in places
      }],
      'no-await-in-loop': 'off',      // sequential batches are the point in several places
      'no-console': 'off',            // this is a CLI
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-coercion': ['error', { boolean: false }],
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-promise-executor-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable-loop': 'error',
      'array-callback-return': 'error',
      'consistent-return': 'off',
    },
  },

  {
    // The dashboard's script is inline in the page, so it needs the HTML
    // processor to be linted at all — and it is where two bugs have lived.
    files: ['web/**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Substituted by the server before the page is served, so they are
        // real at runtime and only absent in the file on disk.
        __ALLOW_EXECUTE__: 'readonly',
        __TOKEN__: 'readonly',
      },
    },
  },

  {
    // Callbacks handed to page.evaluate() run inside the browser, so the
    // document and window globals are legitimate there.
    files: ['test/browser.test.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  {
    // Tests and the fixtures they share.
    files: ['test/**/*.mjs', 'test-support/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
