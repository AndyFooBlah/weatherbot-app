import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { TZ: 'America/Los_Angeles' },
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts'],
  },
});
