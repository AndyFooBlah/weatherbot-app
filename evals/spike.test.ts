// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// P1b SPIKE (weatherbot-app#22): four end-to-end eval cases proving the
// harness shape before the full ~50-case corpus. Data correctness first:
// every numeric/timestamp expectation is computed at eval time from the
// SAME eval database via direct curated-tool calls or nl2time — no
// stale goldens.
//
// Run (on demand — needs the eval stack from weatherbot#15):
//   GEMINI_API_KEY=$(gcloud secrets versions access latest \
//       --secret=GEMINI_API_KEY --project=weatherbot-app) \
//   TOOLBOX_URL=https://weatherbot-toolbox-eval-....run.app \
//   npx vitest run evals/spike.test.ts
//
// Live-model variance policy: each case retries once on failure (LLM
// nondeterminism is real — the smoke test already caught one transient).
// A case failing twice in a row is a genuine defect signal.

import { describe, expect, it } from 'vitest';
import { describeTimeTool } from '../src/agent/nl2timeTools';
import { runConversation } from './driver';
import {
  expectToolsUsed,
  textContainsNumber,
  truthEventTime,
  truthLatestValue,
  truthMaxOver,
} from './harness';
import { createToolboxTransport } from './toolboxTransport';

const apiKey = process.env.GEMINI_API_KEY;
const toolboxUrl = process.env.TOOLBOX_URL;
const enabled = Boolean(apiKey && toolboxUrl);

const RETRIES = 1;
const TIMEOUT = 180_000;

describe.skipIf(!enabled)('P1b spike — agent E2E vs ground truth', () => {
  const transport = () => createToolboxTransport(toolboxUrl!);

  it(
    'S1 current garage temperature — value matches latest_observation',
    { timeout: TIMEOUT, retry: RETRIES },
    async () => {
      const t = transport();
      const expected = await truthLatestValue(t, 'Garage', 'temperature');
      const r = await runConversation(
        ['What is the current garage temperature?'],
        { transport: t, apiKey },
      );
      const traj = await expectToolsUsed(r.events, ['latest_observation']);
      expect(traj.score, traj.comment).toBeTruthy();
      expect(
        textContainsNumber(r.answers[0], expected),
        `expected ${expected} in: "${r.answers[0]}"`,
      ).toBe(true);
    },
  );

  it(
    'S2 high temp yesterday — resolve_time + summarize_period, value matches',
    { timeout: TIMEOUT, retry: RETRIES },
    async () => {
      const t = transport();
      const expected = await truthMaxOver(t, 'Outdoor', 'temperature', 'yesterday');
      const r = await runConversation(
        ['What was the high outdoor temperature yesterday?'],
        { transport: t, apiKey },
      );
      const traj = await expectToolsUsed(r.events, [
        'resolve_time',
        'summarize_period',
      ]);
      expect(traj.score, traj.comment).toBeTruthy();
      // The curated-aggregate rule: ask_data must NOT be the answer path.
      expect(r.toolCalls.map((c) => c.name)).not.toContain('ask_data');
      expect(
        textContainsNumber(r.answers[0], expected),
        `expected ${expected} in: "${r.answers[0]}"`,
      ).toBe(true);
    },
  );

  it(
    'S3 event recall (fixture F2) — spoken time matches describe_time truth',
    { timeout: TIMEOUT, retry: RETRIES },
    async () => {
      const t = transport();
      const occurredAt = await truthEventTime(t, /Cleaned the pool filter/i);
      // The expected spoken phrase is whatever describe_time itself says —
      // the agent is REQUIRED (Law 2) to speak that text verbatim.
      const [expectedPhrase] = describeTimeTool(occurredAt);
      const r = await runConversation(
        ['When did I clean the pool filter?'],
        { transport: t, apiKey },
      );
      const traj = await expectToolsUsed(r.events, [
        'list_events',
        'describe_time',
      ]);
      expect(traj.score, traj.comment).toBeTruthy();
      // Loose containment: the answer must carry the key tokens of the
      // canonical phrase (day-word or relative word), not the whole string.
      const answer = r.answers[0].toLowerCase();
      const keyTokens = expectedPhrase.text
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) =>
          /^(today|tonight|yesterday|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night)$/.test(w),
        );
      expect(keyTokens.length, `no anchor tokens in "${expectedPhrase.text}"`)
        .toBeGreaterThan(0);
      for (const tok of keyTokens) {
        expect(answer, `expected "${tok}" (from "${expectedPhrase.text}")`)
          .toContain(tok);
      }
    },
  );

  it(
    'S4 guardrail — a plain question never triggers record_event',
    { timeout: TIMEOUT, retry: RETRIES },
    async () => {
      const r = await runConversation(
        ['What is the pool temperature right now?'],
        { transport: transport(), apiKey },
      );
      const names = r.toolCalls.map((c) => c.name);
      expect(names).not.toContain('record_event');
      expect(names.length).toBeGreaterThan(0); // it must have used a tool
      expect(r.answers[0].length).toBeGreaterThan(0);
    },
  );
});
