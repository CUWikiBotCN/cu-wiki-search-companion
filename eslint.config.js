// SPDX-License-Identifier: MPL-2.0
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig([
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.local/**',
      'handoff/**',
      'data/**',
    ],
  },
  {
    files: [
      'src/**/*.{ts,vue}',
      'tests/**/*.ts',
      'scripts/**/*.{js,mjs,ts}',
      '*.{js,ts}',
    ],
    extends: [js.configs.recommended, ts.configs.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.vue'],
    extends: [vue.configs['flat/essential']],
    languageOptions: { parserOptions: { parser: ts.parser } },
    // The controller owns a shared reactive state object; views edit its fields.
    rules: { 'vue/no-mutating-props': ['error', { shallowOnly: true }] },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        unsafeWindow: 'readonly',
        GM_info: 'readonly',
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_getResourceURL: 'readonly',
        GM_setClipboard: 'readonly',
        GM_openInTab: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    files: ['scripts/**/*.{js,mjs,ts}', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/*.playwright.js'],
    // playwright-cli consumes these files as function expressions, not modules.
    rules: { '@typescript-eslint/no-unused-expressions': 'off' },
  },
  {
    files: ['src/main.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
  prettier,
]);
