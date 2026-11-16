// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Shared plumbing for the live suite (`npm run test:live`).
//
// The key is read from the environment and handed to VoiceCommon's kit; it is
// never printed or written. Each check result is printed on one line and,
// when LIVE_RESULTS_FILE is set, appended to that file as a JSON line (the
// kit redacts results before returning them) so a run can be summarised with
// scripts/summarize-live-results.mjs.

import { appendFileSync } from 'node:fs';
import { describe } from 'vitest';
import {
  buildProfileConnectConfig,
  formatLiveConformanceReport,
  runLiveConformance,
} from '@andyfooblah/voice-common/testing';
import type { LiveAppProfile, LiveConformanceReport } from '@andyfooblah/voice-common/testing';

type RunOptions = Parameters<typeof runLiveConformance>[1];
type CheckName = NonNullable<RunOptions['checks']>[number];
export type LiveCheckResult = LiveConformanceReport['results'][number];
export type LiveCheckTarget = ReturnType<typeof buildProfileConnectConfig> & { apiKey: string };

export const LIVE_API_KEY = process.env.GEMINI_API_KEY ?? '';

/** `describe` that skips the whole block (green) when no key is configured. */
export const describeLive = describe.skipIf(!LIVE_API_KEY);

/** Print and record one check result. Returns it. */
export function recordResult(result: LiveCheckResult, label: string): LiveCheckResult {
  const metrics = Object.entries(result.metrics)
    .filter(([, v]) => v !== '' && v !== -1)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(
    `[live] ${result.status.toUpperCase().padEnd(16)} ${label} :: ${result.name} :: ${result.detail}` +
      (metrics ? ` [${metrics}]` : ''),
  );
  if (!result.pass && result.trace?.length) {
    console.log(`[live] trace for ${label} :: ${result.name}\n  ${result.trace.join('\n  ')}`);
  }
  if (process.env.LIVE_RESULTS_FILE) {
    appendFileSync(
      process.env.LIVE_RESULTS_FILE,
      JSON.stringify({ label, at: new Date().toISOString(), ...result }) + '\n',
    );
  }
  return result;
}

/**
 * Run ONE named conformance check for a profile through `runLiveConformance`,
 * record it, and throw unless it passed (a `warn` passes). One check per
 * vitest test, so a flaky turn retries alone.
 */
export async function runCheck(
  profile: LiveAppProfile,
  check: CheckName,
  options: Omit<RunOptions, 'apiKey' | 'checks'> = {},
  label: string = profile.name,
): Promise<LiveCheckResult> {
  const report = await runLiveConformance(profile, { apiKey: LIVE_API_KEY, checks: [check], ...options });
  const result = report.results[0];
  if (!result) throw new Error(`[${label}] ${check}: the kit returned no result`);
  recordResult(result, label);
  if (!report.ok) {
    throw new Error(`[${label}] ${check} ${result.status}: ${result.detail}\n${formatLiveConformanceReport(report)}`);
  }
  return result;
}

/** Record a result for a check this suite implements itself. */
export function recordCustom(
  label: string,
  name: string,
  startedAt: number,
  outcome: { status: 'pass' | 'warn' | 'fail'; detail: string; metrics?: Record<string, number | string | boolean> },
): LiveCheckResult {
  return recordResult(
    {
      name,
      pass: outcome.status !== 'fail',
      status: outcome.status,
      detail: outcome.detail,
      metrics: outcome.metrics ?? {},
      durationMs: Date.now() - startedAt,
    },
    label,
  );
}

/** Resolve a profile to the model and connect config the kit will send. */
export function targetFor(profile: LiveAppProfile): LiveCheckTarget {
  return { apiKey: LIVE_API_KEY, ...buildProfileConnectConfig(profile) };
}
