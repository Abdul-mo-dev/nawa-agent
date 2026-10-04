// Repo-wide lint config (lint only — no formatter, so no whole-repo format diff).
// Rules are tuned so the current codebase passes cleanly; tighten incrementally.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.build/**',
      '**/release/**',
      '**/target/**',
      '**/coverage/**',
      '.task/**',
      'scripts/drivers/**',
      'apps/*/build/**',
      'packages/*/src/vendor/**',
      // Browser-side extractor fragments are function-body slices (top-level
      // return), not modules; they are injected as raw text.
      'packages/html2docx/src/browser/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase interoperates with untyped vendor APIs (Univer, pptxgenjs,
      // Electron IPC payloads); `any` at those boundaries is deliberate.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // Empty catch = deliberate fail-open; other empty blocks still flagged.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },
  {
    // These sanitizers deliberately match NUL and other control characters.
    files: [
      'apps/browser/server/workspace.mjs',
      'apps/shell/src/main/directory-actions/file-safety.ts',
      'apps/shell/src/renderer/src/directory-actions/controller.ts',
      'apps/shell/src/renderer/src/directory-actions/filesystem-tools.ts',
      'apps/shell/src/renderer/src/explorer/model.ts',
      'packages/file-parse/src/rag-text.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
  {
    // tsc already checks undefined identifiers with full type info; eslint's
    // no-undef false-positives on TS-only constructs.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // html2docx's generation layer is ported JS under @ts-nocheck until it is
    // typed file by file (packages/html2docx/README.md).
    files: ['packages/html2docx/src/generate.ts', 'packages/html2docx/src/generate/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  {
    // Classic hooks rules only; the React-Compiler rule set (refs, purity,
    // immutability, …) is not adopted yet.
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Plain JS build/tool scripts run in Node without type info.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // MyAgent errors are redacted before rethrow; retaining the raw cause can
    // expose connection credentials through diagnostics.
    files: ['apps/shell/src/main/myagent/service.ts'],
    rules: { 'preserve-caught-error': 'off' },
  },
  {
    // These review scripts execute callbacks in a browser page.
    files: ['tools/myagent-settings-review/test.mjs', 'tools/sidebar-review/activity-test.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The dependency-free mounted-folder workspace is browser code, not Node.
    files: ['apps/browser/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
)
