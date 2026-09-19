// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The Gemini Live model weatherbot runs on — one definition shared by the
// SPA (src/hooks/useWeatherbotSession.ts) and the headless eval driver
// (evals/driver.ts), so the evals always measure what production runs.
//
// Lives under src/agent/ with the rest of the environment-independent agent
// definition: no browser, React, or Firebase imports, so Node can import it.

/**
 * Production Gemini Live model.
 *
 * `gemini-3.8-live` (stable, released 2026-09-15) replaced
 * `gemini-3.1-flash-live-preview` (preview) at identical pricing.
 *
 * This model REJECTS `thinkingConfig` — sending it closes the WebSocket with
 * 1007 before the session starts, which presents as a connection failure
 * rather than a config error. Callers must pass VoiceCommon's
 * `thinkingLevel: 'none'` (see {@link WEATHERBOT_LIVE_THINKING_LEVEL}), or
 * omit the field entirely on a direct ai.live.connect() call.
 */
export const WEATHERBOT_LIVE_MODEL = 'gemini-3.8-live';

/** VoiceCommon `thinkingLevel` matching {@link WEATHERBOT_LIVE_MODEL}. */
export const WEATHERBOT_LIVE_THINKING_LEVEL = 'none' as const;
