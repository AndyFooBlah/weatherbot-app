// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    port: 3005,
    // Dev-only: LAN-exposed on purpose so the mobile-first UI can be tested
    // from a phone on the same network. Nothing secret runs in dev.
    host: '0.0.0.0',
    // signInWithPopup requires this to avoid COOP violations closing the popup.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Prevent duplicate instances of shared singletons (matters when
    // VoiceCommon is npm-linked for local development).
    dedupe: [
      'react',
      'react-dom',
      'firebase',
      'firebase/app',
      'firebase/auth',
      'firebase/firestore',
      'firebase/storage',
      'firebase/functions',
    ],
  },
  build: {
    // The two largest chunks (firebase, index) sit ~510-520 KB raw —
    // safely under the bumped threshold so the build output stays clean.
    // Drop this when we split firebase further or dynamic-import the
    // voice stack.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split the big vendor libs into their own cacheable chunks.
        // Browser can fetch them in parallel and re-uses cached copies
        // across deploys that only touch app code.
        manualChunks: {
          react: ['react', 'react-dom'],
          firebase: [
            'firebase/app',
            'firebase/auth',
            'firebase/firestore',
            'firebase/functions',
            'firebase/storage',
          ],
          gemini: ['@google/genai'],
        },
      },
    },
  },
});
