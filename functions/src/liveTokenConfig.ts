// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// What the mintGeminiLiveToken broker asks Gemini for, as pure data: no
// imports, so the app's test suite can import this file without the
// functions' dependencies (tests/liveTokenBroker.test.ts, and the live
// suite's ephemeral-token test, which mints a token exactly this way).

/**
 * API version the broker mints on. `authTokens.create` is not served on the
 * SDK's default (v1); see https://ai.google.dev/gemini-api/docs/ephemeral-tokens.
 * The browser opens the Live WebSocket on VoiceCommon's `LIVE_API_VERSION`;
 * the two are asserted equal in tests/liveTokenBroker.test.ts.
 */
export const LIVE_TOKEN_API_VERSION = 'v1alpha';

/** How long the minted token is valid before Gemini rejects it. */
export const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** How long after minting the token may be used to open a new session. */
export const NEW_SESSION_WINDOW_MS = 60 * 1000; // 1 minute

export interface LiveTokenRequestConfig {
  /** One Live session per token. */
  uses: number;
  /** ISO timestamp after which Gemini rejects the token. */
  expireTime: string;
  /** ISO timestamp after which the token can no longer open a session. */
  newSessionExpireTime: string;
}

/**
 * The `config` passed to `ai.authTokens.create`.
 *
 * It carries NO `liveConnectConstraints`: the token does not pin a Live model
 * or a connect config. The model is therefore named in exactly one place, on
 * the client (src/agent/liveModel.ts), and client and broker cannot disagree
 * about it. If a model constraint is ever added here it must be that same
 * model; tests/liveTokenBroker.test.ts fails otherwise.
 */
export function buildLiveTokenRequestConfig(nowMs: number): LiveTokenRequestConfig {
  return {
    uses: 1,
    expireTime: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
    newSessionExpireTime: new Date(nowMs + NEW_SESSION_WINDOW_MS).toISOString(),
  };
}
