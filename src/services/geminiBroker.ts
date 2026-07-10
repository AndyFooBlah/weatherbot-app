// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Client-side wrapper around the `mintGeminiLiveToken` Cloud Function.
// VoiceCommon's tokenProvider calls this before opening the Gemini Live
// WebSocket; the long-lived API key never reaches the browser.

import { httpsCallable } from 'firebase/functions';
import { functions } from '@andyfooblah/voice-common';

export interface MintGeminiLiveTokenResponse {
  token: string;
  expireTime: string;
}

export async function mintGeminiLiveToken(): Promise<MintGeminiLiveTokenResponse> {
  const fn = httpsCallable<void, MintGeminiLiveTokenResponse>(
    functions,
    'mintGeminiLiveToken',
  );
  const res = await fn();
  return res.data;
}
