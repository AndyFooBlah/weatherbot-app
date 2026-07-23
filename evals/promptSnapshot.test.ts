// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Pins the production (voice) system prompt byte-for-byte against the
// snapshot taken immediately before the agent-core extraction
// (weatherbot-app#21). Guarantees the refactor — and any future section
// reshuffling — cannot silently change what the deployed bot is told.
//
// If you INTENTIONALLY change the prompt: review the diff, then refresh
// the fixture with
//   npx tsx evals/updatePromptSnapshot.ts
// and commit both together so the change is visible in review.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWeatherbotInstruction } from '../src/agent/instructionBuilder';
import { SNAPSHOT_NOW } from './updatePromptSnapshot';

describe('voice prompt snapshot', () => {
  it('matches the pinned production prompt byte-for-byte', () => {
    const snapshot = readFileSync(
      join(__dirname, 'fixtures', 'voice-prompt.snapshot.txt'),
      'utf8',
    );
    expect(buildWeatherbotInstruction(SNAPSHOT_NOW, 'voice')).toBe(snapshot);
  });

  it('text modality builds and differs only in modality sections', () => {
    const text = buildWeatherbotInstruction(SNAPSHOT_NOW, 'text');
    // Core sections present.
    expect(text).toContain('TWO TIME LAWS');
    expect(text).toContain('## Picking the right tool');
    expect(text).toContain('# Sensor reliability');
    // Voice-only sections absent.
    expect(text).not.toContain('# Emotional state');
    expect(text).not.toContain('# Charts and visualizations');
    expect(text).not.toContain('over voice');
  });
});
