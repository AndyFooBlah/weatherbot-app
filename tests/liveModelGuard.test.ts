// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Guard: a Gemini Live model id is written in exactly one file,
// src/agent/liveModel.ts, and no shipping or test code names a model the
// VoiceCommon registry marks legacy or shut down, or one it has never
// verified. A model swap that edits one path and forgets another, or that
// reintroduces a retired id, fails here with the file and line.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLiveModelInfo } from '@andyfooblah/voice-common/testing';
import { WEATHERBOT_LIVE_MODEL } from '../src/agent/liveModel';
import { REPO_ROOT } from './support/productionInputs';

/** The one file allowed to contain a Live model id. */
const CONSTANT_FILE = 'src/agent/liveModel.ts';

/** Shipping code, the functions, the evals and the tests themselves. */
const SCANNED_DIRS = ['src', 'functions/src', 'evals', 'tests', 'scripts', '.github/workflows'];
const SKIPPED_DIRS = new Set(['node_modules', 'lib', 'dist', 'results']);
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|sh)$/;

/**
 * Anything shaped like a Live (bidirectional audio) model id: `gemini-…-live…`
 * or `gemini-…-native-audio…`. Other Gemini models (the eval judge, for
 * example) are not this guard's business.
 */
const LIVE_MODEL_ID = /gemini-[a-z0-9.]+(?:-[a-z0-9.]+)*/g;
const isLiveModelId = (id: string) => /-live(-|$)|^gemini-live-|native-audio/.test(id);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else if (SCANNED_EXTENSIONS.test(entry)) out.push(path);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  id: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const path of listFiles(join(REPO_ROOT, dir))) {
      const file = relative(REPO_ROOT, path).split('\\').join('/');
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(LIVE_MODEL_ID)) {
            if (isLiveModelId(match[0])) hits.push({ file, line: index + 1, id: match[0] });
          }
        });
    }
  }
  return hits;
}

const hits = scan();
const where = (h: Hit) => `${h.file}:${h.line} '${h.id}'`;

describe('Live model id guard', () => {
  it('finds the constant where it is supposed to be (the scan works)', () => {
    expect(hits.filter((h) => h.file === CONSTANT_FILE).map((h) => h.id)).toContain(WEATHERBOT_LIVE_MODEL);
    expect(isLiveModelId('gemini-3.8-live')).toBe(true);
    expect(isLiveModelId('gemini-3.8-live-extended-thinking')).toBe(true);
    expect(isLiveModelId('gemini-live-2.5-flash-preview')).toBe(true);
    expect(isLiveModelId('gemini-2.5-flash-native-audio-preview-12-2025')).toBe(true);
    expect(isLiveModelId('gemini-3.8-flash')).toBe(false);
    expect(isLiveModelId('gemini-3.5-flash-lite')).toBe(false);
  });

  it(`writes Live model ids only in ${CONSTANT_FILE}`, () => {
    // The ids in the self-check above are this file's own; everything else must be clean.
    const elsewhere = hits.filter((h) => h.file !== CONSTANT_FILE && h.file !== 'tests/liveModelGuard.test.ts');
    expect(
      elsewhere.map(where),
      `Live model ids outside ${CONSTANT_FILE}. Import WEATHERBOT_LIVE_MODEL instead of repeating the id.`,
    ).toEqual([]);
  });

  it('names no Live model the registry marks legacy or shut down, and none it has not verified', () => {
    const problems = hits
      .filter((h) => h.file !== 'tests/liveModelGuard.test.ts')
      .flatMap((h) => {
        const info = getLiveModelInfo(h.id);
        if (!info) return [`${where(h)}: not in VoiceCommon's Live model registry (unverified id)`];
        if (info.status !== 'current') {
          return [
            `${where(h)}: ${info.status}` + (info.replacement ? `, replaced by '${info.replacement}'` : ''),
          ];
        }
        return [];
      });
    expect(problems).toEqual([]);
  });
});
