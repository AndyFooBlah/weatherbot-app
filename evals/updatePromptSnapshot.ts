// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Refreshes evals/fixtures/voice-prompt.snapshot.txt from the current
// instruction builder. Run ONLY when a prompt change is intentional:
//   npx tsx evals/updatePromptSnapshot.ts
// and commit the fixture together with the builder change.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWeatherbotInstruction,
  NowContext,
} from '../src/agent/instructionBuilder';

/** Fixed anchor used by the snapshot — never change this, or every
 * timestamp interpolation in the fixture shifts at once. */
export const SNAPSHOT_NOW: NowContext = {
  timezone: 'America/Los_Angeles',
  localTimeStr: 'Monday, July 20, 2026, 9:05 PM PDT',
  utcIso: '2026-07-21T04:05:00.000Z',
};

// Only regenerate when executed directly, not when imported by the test.
if (process.argv[1]?.endsWith('updatePromptSnapshot.ts')) {
  const path = join(__dirname, 'fixtures', 'voice-prompt.snapshot.txt');
  writeFileSync(path, buildWeatherbotInstruction(SNAPSHOT_NOW, 'voice'));
  console.log(`refreshed ${path}`);
}
