// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The server side of the Live path: what the mintGeminiLiveToken callable
// asks Gemini for (functions/src/liveTokenConfig.ts, pure data) and that it
// cannot drift from the client's model or API version.
//
// The broker deliberately carries no model allow-list and no token
// constraint, so the client's WEATHERBOT_LIVE_MODEL is the only place the
// model is named. If a constraint is added, the last test here must be
// replaced by an equality with that constant; until then it stays absent.
//
// functions/src/auth.ts (who may call the broker) is NOT covered here; it has
// had no unit tests since the September audit (REF-08).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_API_VERSION } from '@andyfooblah/voice-common/testing';
import {
  LIVE_TOKEN_API_VERSION,
  NEW_SESSION_WINDOW_MS,
  TOKEN_TTL_MS,
  buildLiveTokenRequestConfig,
} from '../functions/src/liveTokenConfig';
import { REPO_ROOT } from './support/productionInputs';

const brokerSource = readFileSync(join(REPO_ROOT, 'functions', 'src', 'liveToken.ts'), 'utf8');

describe('mintGeminiLiveToken request', () => {
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);
  const config = buildLiveTokenRequestConfig(now);

  it('is single use, valid 30 minutes, and must open its session within a minute', () => {
    expect(config.uses).toBe(1);
    expect(TOKEN_TTL_MS).toBe(30 * 60_000);
    expect(NEW_SESSION_WINDOW_MS).toBe(60_000);
    expect(config.expireTime).toBe('2026-11-15T12:30:00.000Z');
    expect(config.newSessionExpireTime).toBe('2026-11-15T12:01:00.000Z');
  });

  it('is minted on the API version the browser connects on', () => {
    expect(LIVE_TOKEN_API_VERSION).toBe(LIVE_API_VERSION);
  });

  it('is the request the callable really sends', () => {
    // The handler needs firebase-functions to load, so this reads its source:
    // it must build its request and its API version from liveTokenConfig.ts.
    expect(brokerSource).toMatch(/const config = buildLiveTokenRequestConfig\(Date\.now\(\)\);/);
    expect(brokerSource).toMatch(/authTokens\.create\(\{ config \}\)/);
    expect(brokerSource).toMatch(/apiVersion: LIVE_TOKEN_API_VERSION/);
    expect(brokerSource).toMatch(/await requireAllowed\(request\);/);
  });

  it('pins no Live model: the client constant is the only one', () => {
    expect(Object.keys(config).sort()).toEqual(['expireTime', 'newSessionExpireTime', 'uses']);
    expect(config).not.toHaveProperty('liveConnectConstraints');
    expect(brokerSource).not.toMatch(/liveConnectConstraints|lockAdditionalFields/);
  });
});
