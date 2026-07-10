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
 * Post-build guard: scan `dist/` for shapes that look like real API keys
 * and fail loudly if any sensitive key is bundled into the client.
 *
 * The Firebase web `apiKey` shares the `AIza...` prefix with Gemini and
 * Maps keys but is intentionally public, so we extract it from `.env.local`
 * / `.env.production` and allowlist that exact string. Any *other*
 * `AIza...` sequence in the bundle is treated as an accidentally-shipped
 * Gemini or Maps key and the build fails.
 *
 * Run as: `node scripts/check-bundle-for-secrets.mjs`
 * Hooked to `npm run build`.
 *
 * Override with `BUNDLE_KEY_ALLOWLIST=AIzaA,AIzaB` if needed (comma-separated).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const PATTERNS = [
  { name: 'Google API key (Gemini / Maps / Firebase)', re: /AIza[A-Za-z0-9_-]{35}/g, allowlistable: true },
  { name: 'OpenAI / Anthropic-style key',              re: /\bsk-[A-Za-z0-9_-]{20,}/g, allowlistable: false },
  { name: 'Google OAuth access token',                 re: /\bya29\.[A-Za-z0-9_-]{20,}/g, allowlistable: false },
  { name: 'Slack token',                                re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, allowlistable: false },
  { name: 'GitHub personal access token',               re: /\bgh[opsu]_[A-Za-z0-9]{36,}/g, allowlistable: false },
  { name: 'GCP service account JSON shape',             re: /"type"\s*:\s*"service_account"/g, allowlistable: false },
];

/** Build the allowlist of public-by-design key strings (Firebase web apiKey, etc.). */
function buildAllowlist() {
  const allowed = new Set();
  for (const v of (process.env.BUNDLE_KEY_ALLOWLIST || '').split(',')) {
    const t = v.trim();
    if (t) allowed.add(t);
  }
  for (const file of ['.env.production', '.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*VITE_FIREBASE_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^['"]|['"]$/g, '');
        if (v) allowed.add(v);
      }
    }
  }
  return allowed;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs|html|css|map|json|txt)$/i.test(entry.name)) yield full;
  }
}

if (!fs.existsSync(DIST)) {
  console.error(`[check-bundle-for-secrets] ${DIST} does not exist — run "npm run build" first.`);
  process.exit(2);
}

const allowlist = buildAllowlist();
const findings = [];

for (const file of walk(DIST)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const { name, re, allowlistable } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (allowlistable && allowlist.has(value)) continue;
      findings.push({ file: path.relative(ROOT, file), name, value });
    }
  }
}

if (findings.length === 0) {
  console.log(`[check-bundle-for-secrets] dist/ is clean (allowlisted: ${allowlist.size} entr${allowlist.size === 1 ? 'y' : 'ies'}).`);
  process.exit(0);
}

console.error(`\n[check-bundle-for-secrets] FAIL — ${findings.length} suspected secret${findings.length === 1 ? '' : 's'} in dist/:\n`);
for (const { file, name, value } of findings) {
  const masked = value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-4) : value;
  console.error(`  ${file}`);
  console.error(`    ${name}: ${masked}`);
}
console.error(`\nIf the above is the public Firebase web apiKey, add it to the allowlist`);
console.error(`(VITE_FIREBASE_API_KEY in .env.local / .env.production is auto-allowlisted).`);
console.error(`Otherwise: this is a real secret leaking into the bundle. Fix the leak.\n`);
process.exit(1);
