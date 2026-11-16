// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The Gemini Live model weatherbot runs on. THE ONE PLACE a Live model id is
// written in this repository: the SPA (src/hooks/useWeatherbotSession.ts), the
// headless eval driver (evals/driver.ts) and the live conformance suite
// (tests/live/) all read it from here, through src/agent/liveConfig.ts.
// tests/liveModelGuard.test.ts fails the build if a Live model id appears
// anywhere else under src/, functions/src/ or evals/.
//
// Lives under src/agent/ with the rest of the environment-independent agent
// definition: no browser, React, or Firebase imports, so Node can import it.

/**
 * Production Gemini Live model.
 *
 * `gemini-3.8-live` (stable, released 2026-09-15) is the newest Live model as
 * of 2026-11-15. Before changing it: check the provider's model and
 * deprecation pages, then run `npm run test:live` and `npm run eval:corpus`
 * (see TESTING.md). A model swap is never just this string.
 */
export const WEATHERBOT_LIVE_MODEL = 'gemini-3.8-live';

/**
 * VoiceCommon `thinkingLevel` for {@link WEATHERBOT_LIVE_MODEL}.
 *
 * `'auto'` lets VoiceCommon's model registry choose what the model accepts.
 * The Live models disagree: `gemini-3.8-live` rejects any `thinkingConfig`
 * (the WebSocket closes with 1007 during setup, which reads like a connection
 * fault), while `gemini-3.8-live-extended-thinking` requires one. For the
 * current model `'auto'` omits the field, exactly as the hand-set `'none'`
 * did before VoiceCommon 0.16.0; tests/liveConfig.test.ts proves the two give
 * the same connect config.
 */
export const WEATHERBOT_LIVE_THINKING_LEVEL = 'auto' as const;
