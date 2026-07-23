// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Corpus runner (weatherbot-app#22). One vitest test per EvalCase:
// scripted conversation through the headless driver → trajectory checks
// (agentevals superset + forbidden list) → the case's ground-truth check.
//
// On demand only (no schedule):
//   GEMINI_API_KEY=$(gcloud secrets versions access latest \
//       --secret=GEMINI_API_KEY --project=weatherbot-app) \
//   TOOLBOX_URL=https://weatherbot-toolbox-eval-....run.app \
//   npm run eval:corpus              # full corpus (~10 min)
//   npm run eval:corpus -- -t "[smoke]"   # fast gate
//
// retry:1 per case — live-model variance is real; failing twice is the
// defect signal. A scoreboard lands in evals/results/last-run.json.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES } from './cases';
import { runConversation, type ConversationResult } from './driver';
import {
  expectToolsUsed,
  newestObservation,
  recordCaseResult,
  writeScoreboard,
} from './harness';
import { createToolboxTransport } from './toolboxTransport';

const apiKey = process.env.GEMINI_API_KEY;
const toolboxUrl = process.env.TOOLBOX_URL;
const enabled = Boolean(apiKey && toolboxUrl);

describe.skipIf(!enabled)('eval corpus', () => {
  beforeAll(async () => {
    // Freshness guard: the eval DB is a static snapshot. Aggregate cases
    // over "today"/"last night" degrade into no-data-disclosure checks as
    // it ages — still valid, but less coverage. Re-seed for a full run:
    //   (cd ../weatherbot && bash infra/07-seed-eval-db.sh)
    const newest = await newestObservation(createToolboxTransport(toolboxUrl!));
    const ageH = (Date.now() - newest.getTime()) / 3_600_000;
    if (ageH > 3) {
      console.warn(
        `\n⚠ eval DB is stale: newest reading ${ageH.toFixed(1)}h old — ` +
          `time-relative cases will exercise no-data paths. Re-seed with ` +
          `infra/07-seed-eval-db.sh for full coverage.\n`,
      );
    }
  }, 60_000);

  afterAll(() => writeScoreboard());

  for (const c of CASES) {
    const title = `${c.id} ${c.tags.map((t) => `[${t}]`).join('')}`;
    it(title, { timeout: 240_000, retry: 1 }, async () => {
      const transport = createToolboxTransport(toolboxUrl!);
      const t0 = Date.now();
      let result: ConversationResult | undefined;
      try {
        result = await runConversation(c.turns, { transport, apiKey });

        if (c.requiredTools?.length) {
          const traj = await expectToolsUsed(result.events, c.requiredTools);
          expect(
            traj.score,
            `required tools ${c.requiredTools.join(',')} — ${traj.comment ?? ''}` +
              ` (actual: ${result.toolCalls.map((x) => x.name).join(' → ')})`,
          ).toBeTruthy();
        }
        for (const banned of c.forbiddenTools ?? []) {
          expect(
            result.toolCalls.map((x) => x.name),
            `forbidden tool ${banned}`,
          ).not.toContain(banned);
        }
        await c.check?.({ result, answers: result.answers, transport });

        recordCaseResult({
          id: c.id,
          tags: c.tags,
          ok: true,
          ms: Date.now() - t0,
          answer: result.answers.at(-1)?.slice(0, 200),
          trajectory: result.toolCalls.map((x) => x.name),
        });
      } catch (err) {
        recordCaseResult({
          id: c.id,
          tags: c.tags,
          ok: false,
          ms: Date.now() - t0,
          error: (err as Error).message?.slice(0, 300),
          answer: result?.answers.at(-1)?.slice(0, 200),
          trajectory: result?.toolCalls.map((x) => x.name),
        });
        throw err;
      }
    });
  }
});
