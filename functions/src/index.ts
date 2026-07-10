// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// weatherbot-app Cloud Functions entry point.
//
// Exports:
//   mintGeminiLiveToken (callable)  — ephemeral Gemini Live tokens
//   callTool            (callable)  — MCP tools/call proxy to weatherbot-toolbox
//   listTools           (callable)  — MCP tools/list proxy (canonical tool registry)

import { initializeApp } from 'firebase-admin/app';
import { onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { buildMintGeminiLiveTokenHandler } from './liveToken';
import { callToolHandler } from './callTool';
import { listToolsHandler } from './listTools';

initializeApp();

const geminiApiKey = defineSecret('GEMINI_API_KEY');

export const mintGeminiLiveToken = onCall(
  {
    secrets: [geminiApiKey],
    timeoutSeconds: 30,
    region: 'us-central1',
  },
  buildMintGeminiLiveTokenHandler({
    apiKey: () => geminiApiKey.value(),
  }),
);

export const callTool = onCall(
  {
    timeoutSeconds: 60,
    region: 'us-central1',
  },
  callToolHandler,
);

export const listTools = onCall(
  {
    timeoutSeconds: 15,
    region: 'us-central1',
  },
  listToolsHandler,
);
