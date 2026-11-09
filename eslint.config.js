// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import Module from 'node:module';

// typescript-eslint cannot load TypeScript 7 (its JS API is gone; see
// https://github.com/typescript-eslint/typescript-eslint/issues/10940).
// Until it supports TS >=7.1, serve it the TS 6 API from @typescript/typescript6
// while `tsc` itself stays on TS 7. Must run before the plugin is imported.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'typescript' && parent?.filename && /[\\/]node_modules[\\/](@typescript-eslint|ts-api-utils)[\\/]/.test(parent.filename)) {
    request = '@typescript/typescript6';
  }
  return resolveFilename.call(this, request, parent, ...rest);
};

const { default: tseslint } = await import('@typescript-eslint/eslint-plugin');
const { default: tsparser } = await import('@typescript-eslint/parser');

export default [
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // TypeScript already errors on genuinely undefined identifiers;
      // eslint's no-undef doesn't understand TS types/globals and only
      // produces false positives here (e.g. the React UMD global).
      'no-undef': 'off',
      // Key guard: the Gemini key lives in Secret Manager and reaches the
      // browser only as a single-use ephemeral token minted by the
      // mintGeminiLiveToken callable. Nothing client-side may read a
      // long-lived key from Vite env. (Same guard as the sibling repos;
      // paired with scripts/check-bundle-for-secrets.mjs at build time.)
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name=/^VITE_(GEMINI|GOOGLE_MAPS)/]",
          message:
            'Do not read VITE_GEMINI_* / VITE_GOOGLE_MAPS_* — the key must stay server-side; use the token broker.',
        },
        {
          selector:
            "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name=/_(SECRET|TOKEN)$/]",
          message:
            'Do not read VITE_*_SECRET / VITE_*_TOKEN from client code.',
        },
      ],
    },
  },
];
