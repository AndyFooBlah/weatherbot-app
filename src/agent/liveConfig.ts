// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The weatherbot Live session configuration, as data. Part of the agent core
// (see types.ts): no browser, React, or Firebase imports (the VoiceCommon
// imports below are types only and are erased at build time).
//
// Every code path that opens a Gemini Live session builds its connect config
// from this module and VoiceCommon's `buildLiveConnectConfig`:
//
//   - the SPA: useWeatherbotSession spreads WEATHERBOT_LIVE_SESSION_OPTIONS
//     into VoiceCommon's `useSession`, which calls the builder itself;
//   - the eval driver (evals/driver.ts) and the live conformance suite
//     (tests/live/): `buildLiveConnectConfig(weatherbotLiveConnectParams(...))`.
//
// tests/liveConfig.test.ts and src/hooks/useWeatherbotSession.test.ts prove
// the two routes give the same config for the same instruction and tools, so
// the evals measure what production sends.

import type { FunctionDeclaration, SpeechConfig } from '@google/genai';
import type { BuildLiveConnectConfigParams } from '@andyfooblah/voice-common';
import { WEATHERBOT_LIVE_MODEL, WEATHERBOT_LIVE_THINKING_LEVEL } from './liveModel';

/**
 * Pinned Gemini Live prebuilt voice. Aoede = warm, friendly, mid-pitch — fits
 * weatherbot's "calm helpful assistant" persona. Eventually expose as a user
 * preference; for now hardcoded so the bot sounds the same every session.
 */
export const WEATHERBOT_VOICE_NAME = 'Aoede';

export const WEATHERBOT_SPEECH_CONFIG: SpeechConfig = {
  voiceConfig: { prebuiltVoiceConfig: { voiceName: WEATHERBOT_VOICE_NAME } },
};

/**
 * The Live options the SPA hands to VoiceCommon's `useSession`.
 *
 * Turn-taking is deliberately absent. Weatherbot keeps the server's automatic
 * voice-activity detection with VoiceCommon's defaults, for snappy question
 * and answer; the owner rejected manual turn control for this app on
 * 2026-07-06. Do not add `manualTurnControl`, `endOfSpeechSilenceMs` or
 * `endOfSpeechSensitivity` here: a test fails if one appears.
 */
export const WEATHERBOT_LIVE_SESSION_OPTIONS = {
  liveModel: WEATHERBOT_LIVE_MODEL,
  thinkingLevel: WEATHERBOT_LIVE_THINKING_LEVEL,
  speechConfig: WEATHERBOT_SPEECH_CONFIG,
} as const;

export interface WeatherbotLiveConnectInputs {
  /** Output of `buildWeatherbotInstruction(now, 'voice')`. */
  systemInstruction: string;
  /** Output of `buildDeclarations(mcpTools).declarations` (no `endSession`). */
  tools: FunctionDeclaration[];
  /** Session-resumption handle from an earlier connection, if any. */
  resumptionHandle?: string | null;
}

/**
 * The exact parameters `useSession` passes to `buildLiveConnectConfig` for a
 * weatherbot session with this instruction and these tools. `endSession` is
 * appended by the builder, as in production.
 */
export function weatherbotLiveConnectParams(
  inputs: WeatherbotLiveConnectInputs,
): BuildLiveConnectConfigParams {
  return {
    model: WEATHERBOT_LIVE_SESSION_OPTIONS.liveModel,
    thinkingLevel: WEATHERBOT_LIVE_SESSION_OPTIONS.thinkingLevel,
    speechConfig: WEATHERBOT_LIVE_SESSION_OPTIONS.speechConfig,
    systemInstruction: inputs.systemInstruction,
    tools: inputs.tools,
    resumptionHandle: inputs.resumptionHandle ?? null,
  };
}
