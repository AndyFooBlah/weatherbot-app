// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Vitest config for the LIVE suite: `npm run test:live`.
//
// These tests open real Gemini Live sessions with the app's production
// configuration. Every test skips itself unless GEMINI_API_KEY is set in the
// environment. They run in Node, one file at a time, so parallel sessions do
// not trip rate limits or skew the latency numbers. See TESTING.md.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { TZ: 'America/Los_Angeles' },
    include: ['tests/live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Model output varies and networks blip; a real break fails twice.
    retry: 1,
  },
});
