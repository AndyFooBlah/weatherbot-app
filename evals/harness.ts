// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Shared helpers for agent eval cases (P1b spike — weatherbot-app#22).
//
// Grading philosophy (data correctness first):
//   1. Trajectory checks via agentevals — did the agent use the right
//      tools? (trajectorySuperset: the actual trajectory must contain at
//      least the reference tools.)
//   2. Ground truth via DIRECT curated-tool calls against the same eval
//      toolbox — the curated tools are deterministic SQL we already
//      trust, so the harness needs no separate Postgres client, and
//      expected values can never go stale (computed at eval time).
//   3. Spoken-number matching: the voice bot says "eighty-seven point
//      four", not "87.4" — numberVariants() generates the acceptable
//      spoken/digit forms for an expected value.

import { createTrajectoryMatchEvaluator } from 'agentevals';
import type { TraceEvent } from './driver';

// ─── Trace → OpenAI-style messages (agentevals input format) ───────────

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: string };
  }>;
}

export function toOpenAIMessages(events: TraceEvent[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const e of events) {
    if (e.type === 'user') out.push({ role: 'user', content: e.text });
    else if (e.type === 'tool_call')
      out.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: e.name, arguments: JSON.stringify(e.args) } },
        ],
      });
    else if (e.type === 'tool_result')
      out.push({ role: 'tool', content: e.result });
    else out.push({ role: 'assistant', content: e.text });
  }
  return out;
}

/** Assert the actual trajectory used at least the reference tools
 * (order-insensitive, args ignored). Returns the agentevals result. */
export async function expectToolsUsed(
  events: TraceEvent[],
  requiredTools: string[],
): Promise<{ score: boolean | number; comment?: string }> {
  const outputs = toOpenAIMessages(events);
  const referenceOutputs: OpenAIMessage[] = requiredTools.map((name) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name, arguments: '{}' } }],
  }));
  const evaluator = createTrajectoryMatchEvaluator({
    trajectoryMatchMode: 'superset',
    toolArgsMatchMode: 'ignore',
  });
  const res = await evaluator({
    outputs: outputs as never,
    referenceOutputs: referenceOutputs as never,
  });
  return { score: res.score as boolean | number, comment: res.comment };
}

// ─── Spoken-number matching ─────────────────────────────────────────────

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety',
];

function intToWords(n: number): string {
  if (n < 0) return `negative ${intToWords(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}-${ONES[r]}`;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return r === 0
      ? `${ONES[h]} hundred`
      : `${ONES[h]} hundred ${intToWords(r)}`;
  }
  return String(n); // beyond spike needs
}

/**
 * Acceptable textual forms for an expected numeric value in a voice
 * transcription: digits ("87.4"), full spoken ("eighty-seven point
 * four"), and the integer part alone (bots round: "about eighty-seven",
 * "87 degrees").
 */
export function numberVariants(value: number): string[] {
  const variants = new Set<string>();
  const fixed1 = value.toFixed(1);
  const intPart = Math.trunc(Math.abs(value));
  variants.add(String(value));
  variants.add(fixed1);
  variants.add(String(intPart));
  variants.add(String(intPart + 1)); // rounding up crosses the integer
  variants.add(intToWords(intPart));
  variants.add(intToWords(intPart + 1));
  if (fixed1.includes('.')) {
    const [i, d] = fixed1.split('.');
    variants.add(`${intToWords(+i)} point ${ONES[+d]}`);
  }
  // Hyphen/space variation: "eighty-seven" vs "eighty seven".
  for (const v of [...variants]) {
    if (v.includes('-')) variants.add(v.replace(/-/g, ' '));
  }
  return [...variants];
}

/** True if any acceptable form of `value` appears in `text`. */
export function textContainsNumber(text: string, value: number): boolean {
  const t = text.toLowerCase();
  return numberVariants(value).some((v) => t.includes(v.toLowerCase()));
}

// ─── Ground truth via direct tool calls ─────────────────────────────────

import { resolveTimeTool } from '../src/agent/nl2timeTools';
import type { ToolTransport } from '../src/agent/types';

function rowsOf(resultText: string): Array<Record<string, unknown>> {
  // postgres-sql tools return one JSON document per row as separate MCP
  // content parts, which the transport joins with newlines — i.e. NDJSON
  // for multi-row results, a single object or array for single-part ones.
  try {
    const parsed = JSON.parse(resultText);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return resultText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        const p = JSON.parse(l);
        return Array.isArray(p) ? p : [p];
      });
  }
}

async function callRows(
  transport: ToolTransport,
  name: string,
  args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const res = await transport.callTool(name, args);
  if (res.isError) {
    throw new Error(`ground-truth ${name} failed: ${res.content?.[0]?.text}`);
  }
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return rowsOf(text);
}

/** Ground truth: latest reading value for a location/measurement. */
export async function truthLatestValue(
  transport: ToolTransport,
  location: string,
  measurementType: string,
): Promise<number> {
  const rows = await callRows(transport, 'latest_observation', {
    location,
    measurement_type: measurementType,
  });
  if (!rows.length) throw new Error(`no latest_observation for ${location}`);
  return Number(rows[0].value);
}

/** Ground truth: max value over a natural-language window ("yesterday"). */
export async function truthMaxOver(
  transport: ToolTransport,
  location: string,
  measurementType: string,
  when: string,
): Promise<number> {
  const range = resolveTimeTool(when);
  const rows = await callRows(transport, 'summarize_period', {
    location,
    measurement_type: measurementType,
    from_ts: range.start_utc,
    to_ts: range.end_utc,
  });
  if (!rows.length) throw new Error(`no summarize_period rows for ${when}`);
  const max = rows
    .map((r) => Number(r.max_value ?? r.max ?? NaN))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)[0];
  if (max === undefined) {
    throw new Error(
      `summarize_period returned no max column: ${JSON.stringify(rows[0])}`,
    );
  }
  return max;
}

/** Ground truth: occurred_at of the newest event whose note matches. */
export async function truthEventTime(
  transport: ToolTransport,
  notePattern: RegExp,
): Promise<string> {
  const rows = await callRows(transport, 'list_events', { row_limit: 100 });
  const hit = rows.find((r) => notePattern.test(String(r.note ?? '')));
  if (!hit) throw new Error(`no event matching ${notePattern}`);
  return String(hit.occurred_at);
}

// ─── Additional ground truths (corpus) ──────────────────────────────────

/** Ground truth: an aggregate (min_value/max_value/avg_value) over a
 * natural-language window, via summarize_period. */
export async function truthAggOver(
  transport: ToolTransport,
  location: string,
  measurementType: string,
  when: string,
  agg: 'min' | 'max' | 'avg',
): Promise<number> {
  const range = resolveTimeTool(when);
  const rows = await callRows(transport, 'summarize_period', {
    location,
    measurement_type: measurementType,
    from_ts: range.start_utc,
    to_ts: range.end_utc,
  });
  if (!rows.length) throw new Error(`no summarize_period rows for ${when}`);
  const key = `${agg}_value`;
  const vals = rows
    .map((r) => Number(r[key] ?? NaN))
    .filter((n) => !Number.isNaN(n));
  if (!vals.length) {
    throw new Error(`no ${key} in: ${JSON.stringify(rows[0])}`);
  }
  if (agg === 'min') return Math.min(...vals);
  if (agg === 'max') return Math.max(...vals);
  return vals[0]; // avg over one matched sensor
}

/** Ground truth: every reading value in a natural-language window (the
 * bot may quote any single reading, an average, or a rounded value). */
export async function truthWindowValues(
  transport: ToolTransport,
  location: string,
  measurementType: string,
  when: string,
): Promise<number[]> {
  const range = resolveTimeTool(when);
  const rows = await callRows(transport, 'observations_in_range', {
    location,
    measurement_type: measurementType,
    from_ts: range.start_utc,
    to_ts: range.end_utc,
  });
  return rows
    .map((r) => Number(r.value ?? NaN))
    .filter((n) => !Number.isNaN(n));
}

/** True if the text contains any acceptable form of any value in
 * [min(values)-0.5, max(values)+0.5] that matches an actual value —
 * i.e. the bot quoted a number consistent with the window. */
export function textContainsAnyNumber(text: string, values: number[]): boolean {
  return values.some((v) => textContainsNumber(text, v));
}

// ─── Tool-call inspection ───────────────────────────────────────────────

import type { ConversationResult } from './driver';

/** Args of the first call to `name`, or throws with the actual trajectory. */
export function argsOf(
  result: ConversationResult,
  name: string,
): Record<string, unknown> {
  const hit = result.toolCalls.find((c) => c.name === name);
  if (!hit) {
    throw new Error(
      `expected a ${name} call; trajectory was: ` +
        result.toolCalls.map((c) => c.name).join(' → '),
    );
  }
  return hit.args;
}

export function allArgsOf(
  result: ConversationResult,
  name: string,
): Array<Record<string, unknown>> {
  return result.toolCalls.filter((c) => c.name === name).map((c) => c.args);
}

// ─── Minimal LLM judge (rubric checks that string-matching can't do) ────

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

/** Judge model per the model-class table (medium batch task → Flash).
 * Verify the current id against https://ai.google.dev/gemini-api/docs/models
 * when bumping. */
export const JUDGE_MODEL = 'gemini-3-flash-preview';

let judge: ChatGoogleGenerativeAI | null = null;

/**
 * YES/NO rubric check. Returns { pass, reason }. Used ONLY where a
 * deterministic check can't express the criterion (caveat disclosure,
 * refusal quality) — data correctness stays deterministic.
 */
export async function judgeCheck(
  answer: string,
  criterion: string,
): Promise<{ pass: boolean; reason: string }> {
  judge ??= new ChatGoogleGenerativeAI({
    model: JUDGE_MODEL,
    temperature: 0,
    apiKey: process.env.GEMINI_API_KEY,
  });
  const res = await judge.invoke([
    [
      'system',
      'You are grading a voice assistant\'s spoken answer against one ' +
        'criterion. Reply with exactly "YES: <reason>" or "NO: <reason>".',
    ],
    ['human', `Criterion: ${criterion}\n\nAnswer to grade: "${answer}"`],
  ]);
  const text = String(res.content).trim();
  return { pass: /^YES/i.test(text), reason: text };
}

// ─── Results recorder (scoreboard) ──────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export interface CaseResult {
  id: string;
  tags: string[];
  ok: boolean;
  ms: number;
  error?: string;
  answer?: string;
  trajectory?: string[];
}

const caseResults: CaseResult[] = [];

export function recordCaseResult(r: CaseResult): void {
  // Upsert by id: with vitest retry, a failed first attempt may be
  // followed by a passing retry — the final attempt wins.
  const i = caseResults.findIndex((x) => x.id === r.id);
  if (i >= 0) caseResults[i] = r;
  else caseResults.push(r);
}

/** Write evals/results/last-run.json + print a compact scoreboard. */
export function writeScoreboard(): void {
  if (!caseResults.length) return;
  const dir = pathJoin(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  const passed = caseResults.filter((r) => r.ok).length;
  const summary = {
    at: new Date().toISOString(),
    passed,
    failed: caseResults.length - passed,
    cases: caseResults,
  };
  writeFileSync(
    pathJoin(dir, 'last-run.json'),
    JSON.stringify(summary, null, 2),
  );
  const byTag = new Map<string, { p: number; f: number }>();
  for (const r of caseResults) {
    for (const t of r.tags) {
      const e = byTag.get(t) ?? { p: 0, f: 0 };
      r.ok ? e.p++ : e.f++;
      byTag.set(t, e);
    }
  }
  console.log(`\n── eval scoreboard: ${passed}/${caseResults.length} ──`);
  for (const [t, e] of [...byTag].sort()) {
    console.log(`  ${t.padEnd(12)} ${e.p}/${e.p + e.f}`);
  }
  for (const r of caseResults.filter((x) => !x.ok)) {
    console.log(`  ✗ ${r.id}: ${r.error?.slice(0, 120)}`);
  }
}

/** Ground truth: notes of events inside a natural-language window. */
export async function truthEventsInWindow(
  transport: ToolTransport,
  when: string,
): Promise<string[]> {
  const range = resolveTimeTool(when);
  const rows = await callRows(transport, 'list_events', {
    from_ts: range.start_utc,
    to_ts: range.end_utc,
    row_limit: 100,
  });
  return rows.map((r) => String(r.note ?? '')).filter(Boolean);
}

/** Newest observation timestamp across all sensors — used by the corpus
 * freshness guard (a stale static snapshot degrades relative-time cases
 * into no-data checks; re-seed for full coverage). */
export async function newestObservation(
  transport: ToolTransport,
): Promise<Date> {
  const rows = await callRows(transport, 'latest_observation', {});
  const times = rows
    .map((r) => new Date(String(r.observed_at)).getTime())
    .filter((t) => !Number.isNaN(t));
  if (!times.length) throw new Error('no observations at all in eval DB');
  return new Date(Math.max(...times));
}
