import { defineConfig } from 'vitest/config';

// `npm test`: offline tests only. The live conformance suite
// (tests/live/*.live.test.ts) opens real Gemini Live sessions and is run by
// vitest.live.config.ts (`npm run test:live`); see TESTING.md.
export default defineConfig({
  test: {
    environment: 'node',
    env: { TZ: 'America/Los_Angeles' },
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});
