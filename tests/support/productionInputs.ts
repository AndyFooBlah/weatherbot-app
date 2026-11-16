// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The app's real production inputs, assembled for tests: the committed
// Toolbox tool list, the declarations the agent core builds from it, and the
// voice system instruction. Node only (reads the fixture from disk).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FunctionDeclaration } from '@google/genai';
import {
  buildWeatherbotInstruction,
  captureNow,
  type NowContext,
} from '../../src/agent/instructionBuilder';
import { buildDeclarations } from '../../src/agent/toolDeclarations';
import type { McpTool } from '../../src/agent/types';

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = join(here, '..', '..');

/** Fixed "now" (the prompt snapshot's anchor) for deterministic offline tests. */
export const FIXED_NOW: NowContext = {
  timezone: 'America/Los_Angeles',
  localTimeStr: 'Monday, July 20, 2026, 9:05 PM PDT',
  utcIso: '2026-07-21T04:05:00.000Z',
};

/** The Toolbox `tools/list` answer recorded by evals/recordToolboxFixture.ts. */
export function loadToolboxFixture(): McpTool[] {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'evals', 'fixtures', 'toolbox-tools.json'), 'utf8'),
  ) as McpTool[];
}

/** The full production declaration set (Toolbox tools + client-side time tools). */
export function productionDeclarations(): FunctionDeclaration[] {
  return buildDeclarations(loadToolboxFixture()).declarations;
}

/** The production (voice) system instruction for a given, or the current, time. */
export function productionInstruction(now: NowContext = captureNow()): string {
  return buildWeatherbotInstruction(now, 'voice');
}
