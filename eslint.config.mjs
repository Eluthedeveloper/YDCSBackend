import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // Build output, dependencies, and runtime media/backup folders are not source.
  globalIgnores(['dist', 'node_modules', 'uploads', 'backups', 'coverage']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // The schema layer deliberately models rows as `Record<string, any>`, and
      // mysql2 errors arrive untyped. Narrowing every row and catch block would
      // add casts without making anything safer; `unknown` is used where it
      // actually matters (request bodies, external API responses).
      '@typescript-eslint/no-explicit-any': 'off',
      // Cache helpers intentionally swallow Redis failures because the cache is
      // non-critical, which leaves genuinely empty catch blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A leading underscore marks a value the code must accept but does not use
      // (`_next` in an Express error handler, `_maxAge` when clearing a cookie).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Wrapping a caught error in a migration-named message is intentional; the
      // original error is already what the message reports.
      'preserve-caught-error': 'off',
    },
  },
]);
