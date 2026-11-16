// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// mintGeminiLiveToken — server-side minting of short-lived Gemini Live tokens.
//
// Clients must never see the real GEMINI_API_KEY. Before opening a Gemini
// Live WebSocket, signed-in users call this callable to obtain an ephemeral
// token scoped to a single Live session with a ~30 minute expiry. Once the
// session is opened (or the token expires), the token is useless.
//
// Pattern mirrors CarBot's functions/src/liveToken.ts.

import { GoogleGenAI } from '@google/genai';
import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { requireAllowed } from './auth';
import {
  LIVE_TOKEN_API_VERSION,
  buildLiveTokenRequestConfig,
} from './liveTokenConfig';

export interface MintGeminiLiveTokenResponse {
  /** Ephemeral token string — pass as the `apiKey` field on the Live connect. */
  token: string;
  /** ISO timestamp when the Live session expires. Clients should reconnect before this. */
  expireTime: string;
}

export function buildMintGeminiLiveTokenHandler(deps: {
  apiKey: () => string;
}) {
  return async (request: CallableRequest): Promise<MintGeminiLiveTokenResponse> => {
    await requireAllowed(request);

    const apiKey = deps.apiKey();
    if (!apiKey) {
      throw new HttpsError(
        'internal',
        'GEMINI_API_KEY is not configured on this server.',
      );
    }

    // The request itself (single use, 30-minute expiry, 1-minute window to
    // open the session, no model constraint) is built in liveTokenConfig.ts,
    // where the app's tests can read it.
    const config = buildLiveTokenRequestConfig(Date.now());

    // authTokens.create is not served on the SDK's default endpoint (v1,
    // which returns 404 for this method), so the version is pinned.
    // https://ai.google.dev/gemini-api/docs/ephemeral-tokens
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: LIVE_TOKEN_API_VERSION },
    });

    try {
      const token = await ai.authTokens.create({ config });
      if (!token?.name) {
        throw new Error('authTokens.create returned empty token');
      }
      return { token: token.name, expireTime: config.expireTime };
    } catch (err) {
      logger.error('[mintGeminiLiveToken] Failed to mint token', err);
      throw new HttpsError('internal', 'Failed to mint Gemini Live token.');
    }
  };
}
