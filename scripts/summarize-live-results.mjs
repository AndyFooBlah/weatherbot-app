#!/usr/bin/env node
// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Turn the JSON-lines file written by the live suite (LIVE_RESULTS_FILE) into
 * a Markdown table. Used by .github/workflows/live-contract.yml for the job
 * summary and the tracking issue, and handy locally:
 *
 *   LIVE_RESULTS_FILE=/tmp/live.jsonl npm run test:live
 *   node scripts/summarize-live-results.mjs /tmp/live.jsonl
 *   node scripts/summarize-live-results.mjs /tmp/live.jsonl --failures-only
 *
 * The results were redacted by the kit when they were produced; this script
 * redacts key shapes once more before printing.
 */

import fs from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
const failuresOnly = flags.includes('--failures-only');

const redact = (text) =>
  String(text)
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/auth_tokens\/[A-Za-z0-9_.-]+/g, '[REDACTED]');
const cell = (text) => redact(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

if (!file || !fs.existsSync(file)) {
  console.log('No live results were recorded.');
  process.exit(0);
}

const rows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// A retried check appears more than once; the last attempt is the verdict.
const latest = new Map();
for (const row of rows) latest.set(`${row.label} :: ${row.name}`, row);
const results = [...latest.values()];

const LABEL = { pass: 'pass', warn: 'WARN', skipped: 'skip', fail: '**FAIL**', 'contract-changed': '**CONTRACT CHANGED**' };
const count = (status) => results.filter((r) => r.status === status).length;
const shown = failuresOnly ? results.filter((r) => r.status === 'fail' || r.status === 'contract-changed') : results;

if (!failuresOnly) {
  console.log('### Live suite results');
  console.log('');
  console.log(
    `${count('pass')} passed, ${count('warn')} warned, ${count('skipped')} skipped, ${count('fail')} failed, ` +
      `${count('contract-changed')} contract changed (${rows.length - results.length} retried attempt(s) superseded).`,
  );
  console.log('');
}
if (shown.length === 0) {
  console.log(failuresOnly ? '' : 'No results.');
  process.exit(0);
}

const metric = (r) =>
  Object.entries(r.metrics ?? {})
    .filter(([, v]) => v !== '' && v !== -1)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

console.log('| Result | Model / preset | Check | Detail | Metrics |');
console.log('|---|---|---|---|---|');
for (const r of shown) {
  console.log(
    `| ${LABEL[r.status] ?? r.status} | ${cell(r.label)} | ${cell(r.name)} | ${cell(r.detail).slice(0, 300)} | ${cell(metric(r)).slice(0, 400)} |`,
  );
}
