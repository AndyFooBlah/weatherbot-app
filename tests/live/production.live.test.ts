// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// LIVE: VoiceCommon's conformance checks against the config weatherbot sends
// in production: the real model constant, the real (voice) system
// instruction, the full real tool declaration set, the pinned voice, and
// server-VAD turn-taking at its defaults.
//
// Runs only via `npm run test:live` with GEMINI_API_KEY set. See TESTING.md
// for what each check proves, what a run costs and the latency baseline.

import { expect, it } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { LIVE_API_VERSION, LiveTestSession } from '@andyfooblah/voice-common/testing';
import { LIVE_TOKEN_API_VERSION, buildLiveTokenRequestConfig } from '../../functions/src/liveTokenConfig';
import { AUTO_GREET_TEXT } from '../../src/agent/instructionBuilder';
import {
  STUB_GARAGE_TEMPERATURE_F,
  createStubDispatcher,
  mentionsStubTemperature,
  weatherbotLiveProfile,
} from '../support/liveProfile';
import { LIVE_API_KEY, describeLive, recordCustom, runCheck, targetFor } from './liveEnv';

/**
 * Weatherbot is a snappy question-and-answer app: a reply should start within
 * about two seconds of the user finishing a question (this includes the
 * roughly 0.8 s the server's VAD waits to be sure the user has stopped).
 * Over this the latency check WARNS; it does not fail. Baseline numbers are
 * in TESTING.md.
 */
export const SNAPPY_SOFT_BUDGET_MS = 2_000;

describeLive('live: weatherbot production config', () => {
  const profile = weatherbotLiveProfile();
  const label = `${profile.name} / production`;
  const declared = (profile.tools?.length ?? 0) + 1; // + VoiceCommon's endSession

  it('setup is accepted', async () => {
    await runCheck(profile, 'setup', {}, label);
  });

  it('the full real tool declaration set is accepted', async () => {
    const result = await runCheck(profile, 'tool-declarations', {}, label);
    // Nine Toolbox tools, resolve_time, describe_time and endSession.
    expect(result.metrics.toolDeclarations).toBe(declared);
    expect(declared).toBeGreaterThanOrEqual(12);
  });

  it("text turn: the app's opening cue produces a spoken greeting", async () => {
    await runCheck(profile, 'text-turn', { textTurn: { prompt: AUTO_GREET_TEXT } }, label);
  });

  it('audio turn under server VAD with default settings (the production turn-taking)', async () => {
    const result = await runCheck(profile, 'audio-turn', {}, label);
    expect(result.status).toBe('pass'); // not skipped: the profile must not be on manual turn control
  });

  it("tool round trip: latest_observation, answered through the app's dispatcher from a stub Toolbox", async () => {
    // The canned result is what the production dispatcher hands back to the
    // model for the stub Toolbox's row, so result shaping is in the loop.
    const canned = await createStubDispatcher()('latest_observation', {
      location: 'Garage',
      measurement_type: 'temperature',
    });
    expect(canned).toContain(`"value":${STUB_GARAGE_TEMPERATURE_F}`);
    const result = await runCheck(
      profile,
      'tool-round-trip',
      {
        toolProbe: {
          prompt: 'What is the current garage temperature?',
          expectTool: 'latest_observation',
          result: canned,
        },
      },
      label,
    );
    expect(
      mentionsStubTemperature(String(result.metrics.reply)),
      `the spoken reply should state the stub reading (${STUB_GARAGE_TEMPERATURE_F}); got "${result.metrics.reply}"`,
    ).toBe(true);
  });

  it('barge-in interrupts the bot', async () => {
    await runCheck(
      profile,
      'barge-in',
      {
        bargeIn: {
          // Something this assistant will talk about at length, in its own domain.
          prompt:
            '[Test cue. Without calling any tool, explain slowly and in detail, in at least ten sentences, ' +
            'what each kind of weather sensor measures: temperature, humidity, pressure, wind, rain and UV.]',
        },
      },
      label,
    );
  });

  it('session resumption keeps context across a reconnect', async () => {
    await runCheck(profile, 'session-resumption', {}, label);
  });

  it('context window compression is accepted', async () => {
    await runCheck(profile, 'context-compression', {}, label);
  });

  it('the model is listed with bidiGenerateContent', async () => {
    await runCheck(profile, 'model-listed', {}, label);
  });

  it("ephemeral token: minted exactly as the broker mints it, opens the production session on the hook's API version", async () => {
    // The production auth path minus Firebase: mintGeminiLiveToken's request
    // (functions/src/liveTokenConfig.ts), then a connect with that token.
    const startedAt = Date.now();
    const ai = new GoogleGenAI({
      apiKey: LIVE_API_KEY,
      httpOptions: { apiVersion: LIVE_TOKEN_API_VERSION },
    });
    const token = await ai.authTokens.create({ config: buildLiveTokenRequestConfig(Date.now()) });
    expect(token.name, 'authTokens.create returned no token').toBeTruthy();
    const mintMs = Date.now() - startedAt;

    const { model, config } = targetFor(profile);
    const session = await LiveTestSession.connect({
      ephemeralToken: token.name!,
      model,
      config,
      apiVersion: LIVE_API_VERSION,
    });
    try {
      const since = session.mark();
      session.sendText(AUTO_GREET_TEXT);
      await session.waitForType('turnComplete', 30_000, { since });
      const audioSeconds = Number((session.audioBytes(since) / 48_000).toFixed(2));
      const outcome = {
        status: audioSeconds > 0 ? ('pass' as const) : ('fail' as const),
        detail:
          audioSeconds > 0
            ? `broker-shaped token minted on ${LIVE_TOKEN_API_VERSION}, session opened on ${LIVE_API_VERSION}, greeting spoken`
            : 'the session opened with the token but the bot did not speak',
        metrics: { mintMs, audioSeconds, mintApiVersion: LIVE_TOKEN_API_VERSION, connectApiVersion: LIVE_API_VERSION },
      };
      recordCustom(label, 'ephemeral-token:broker-request', startedAt, outcome);
      expect(outcome.status, outcome.detail).toBe('pass');
    } finally {
      await session.close();
    }
  });

  it(`latency: end of speech to first bot audio (warns over ${SNAPPY_SOFT_BUDGET_MS} ms, never fails on speed)`, async () => {
    const result = await runCheck(
      profile,
      'latency',
      {
        latency: {
          softBudgetMs: SNAPPY_SOFT_BUDGET_MS,
          // Warn only: speed alone never fails the suite. A turn that gets no
          // answer at all still fails.
          hardCapMs: Number.MAX_SAFE_INTEGER,
        },
      },
      label,
    );
    expect(['pass', 'warn']).toContain(result.status);
  });
});
