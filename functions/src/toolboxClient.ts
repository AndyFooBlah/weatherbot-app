// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Shared client for the weatherbot-toolbox Cloud Run service: URL param,
// OIDC token minting, and the MCP JSON-RPC POST. callTool and listTools
// both build on this so the two proxies can't drift apart.

import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { defineString } from 'firebase-functions/params';
import { GoogleAuth } from 'google-auth-library';

/**
 * Cloud Run URL of the deployed weatherbot-toolbox service. Set per
 * environment in functions/.env (see functions/.env.example) — the URL
 * embeds the backend project number, so it is configuration, not code.
 */
export const toolboxUrl = defineString('TOOLBOX_URL', {
  description:
    'Cloud Run URL of the weatherbot-toolbox MCP service (find it with ' +
    '`gcloud run services describe weatherbot-toolbox`)',
});

/** Reused across invocations of the same instance to avoid token re-fetch. */
const auth = new GoogleAuth();
let cachedIdTokenClient: Awaited<ReturnType<GoogleAuth['getIdTokenClient']>> | null = null;
let cachedForUrl: string | null = null;

async function getToolboxIdToken(url: string): Promise<string> {
  if (!cachedIdTokenClient || cachedForUrl !== url) {
    cachedIdTokenClient = await auth.getIdTokenClient(url);
    cachedForUrl = url;
  }
  return cachedIdTokenClient.idTokenProvider.fetchIdToken(url);
}

/**
 * POST one MCP JSON-RPC request to the toolbox and return its `result`.
 * Throws HttpsError with a caller-safe message on any failure; full detail
 * goes to the function logs under `label`.
 */
export async function postMcp<T>(
  label: string,
  body: { id: string; method: string; params?: Record<string, unknown> },
): Promise<T | null> {
  const url = toolboxUrl.value();

  let token: string;
  try {
    token = await getToolboxIdToken(url);
  } catch (err) {
    logger.error(`[${label}] failed to mint toolbox identity token`, err);
    throw new HttpsError('internal', 'Failed to authenticate to toolbox.');
  }

  let response: Response;
  try {
    response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    });
  } catch (err) {
    logger.error(`[${label}] network error reaching toolbox`, err);
    throw new HttpsError('unavailable', 'Toolbox unreachable.');
  }

  if (!response.ok) {
    const text = await response.text();
    logger.error(`[${label}] toolbox HTTP`, response.status, text.slice(0, 500));
    throw new HttpsError('internal', `Toolbox returned ${response.status}.`);
  }

  const json = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (json.error) {
    logger.error(`[${label}] JSON-RPC error`, json.error);
    throw new HttpsError('internal', `Tool error: ${json.error.message}`);
  }
  return json.result ?? null;
}
