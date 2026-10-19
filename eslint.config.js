import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', '.claude/**', 'portal/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'scripts/**/*.{mjs,ts}',
      'tests/fixtures/**/*.mjs',
      'tests/**/*.ts',
      '*.config.{js,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // CommonJS helper scripts run directly by Electron.
    files: ['scripts/**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
)
