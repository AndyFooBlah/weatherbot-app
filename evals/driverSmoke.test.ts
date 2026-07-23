// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Live smoke test for the headless driver: one real conversation against
// the production model + a real toolbox. Env-gated so `npm test` stays
// green without credentials:
//
//   GEMINI_API_KEY=$(gcloud secrets versions access latest \
//       --secret=GEMINI_API_KEY --project=weatherbot-app) \
//   TOOLBOX_URL=https://weatherbot-toolbox-....run.app \
//   npx vitest run evals/driverSmoke.test.ts
//
// Uses a read-only question so running against the PROD toolbox is safe.
// P1a's weatherbot-toolbox-eval becomes the default target once it exists.

import { describe, expect, it } from 'vitest';
import { runConversation } from './driver';
import { createToolboxTransport } from './toolboxTransport';

const apiKey = process.env.GEMINI_API_KEY;
const toolboxUrl = process.env.TOOLBOX_URL;
const enabled = Boolean(apiKey && toolboxUrl);

describe.skipIf(!enabled)('headless driver live smoke', () => {
  it(
    'answers a current-temperature question via latest_observation',
    { timeout: 120_000 },
    async () => {
      const result = await runConversation(
        ['What is the current garage temperature?'],
        {
          transport: createToolboxTransport(toolboxUrl!),
          apiKey,
          debug: true,
        },
      );

      // The production brain must have used a tool, not guessed.
      const toolNames = result.toolCalls.map((c) => c.name);
      expect(toolNames).toContain('latest_observation');

      // And said something non-empty containing a plausible number.
      const answer = result.answers[0];
      expect(answer.length).toBeGreaterThan(0);
      expect(answer).toMatch(/\d|degrees|eighty|seventy|ninety|sixty/i);
    },
  );
});
