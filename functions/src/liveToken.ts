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

/** How long the minted token is valid before Gemini rejects it. */
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** How long after minting the token may be used to open a new session. */
const NEW_SESSION_WINDOW_MS = 60 * 1000; // 1 minute

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

    const now = Date.now();
    const expireTime = new Date(now + TOKEN_TTL_MS).toISOString();
    const newSessionExpireTime = new Date(now + NEW_SESSION_WINDOW_MS).toISOString();

    // authTokens.create is exposed only on the v1alpha endpoint; the SDK
    // defaults to v1, which returns 404 for this method. Pin v1alpha here.
    // https://ai.google.dev/gemini-api/docs/ephemeral-tokens
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    try {
      const token = await ai.authTokens.create({
        config: {
          uses: 1,
          expireTime,
          newSessionExpireTime,
        },
      });
      if (!token?.name) {
        throw new Error('authTokens.create returned empty token');
      }
      return { token: token.name, expireTime };
    } catch (err) {
      logger.error('[mintGeminiLiveToken] Failed to mint token', err);
      throw new HttpsError('internal', 'Failed to mint Gemini Live token.');
    }
  };
}
