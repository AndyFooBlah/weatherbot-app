// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// listTools — fetch the canonical tool list from the weatherbot-toolbox
// Cloud Run service. Lets the SPA stop hardcoding tool declarations and
// instead source them live from the toolbox (single source of truth).
//
// Auth: same model as callTool — Firebase Auth ID token verified by onCall,
// service-to-service OIDC token minted from the function's runtime SA for
// the toolbox audience.

import { CallableRequest } from 'firebase-functions/v2/https';
import { requireAllowed } from './auth';
import { postMcp } from './toolboxClient';

/** MCP tool descriptor as returned by tools/list. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

export interface ListToolsResponse {
  /** Verbatim MCP tools array from the toolbox. */
  tools: McpTool[];
}

export async function listToolsHandler(
  request: CallableRequest<unknown>,
): Promise<ListToolsResponse> {
  const { uid } = await requireAllowed(request);

  const result = await postMcp<{ tools?: McpTool[] }>('listTools', {
    id: `${uid}-${Date.now()}`,
    method: 'tools/list',
  });

  return { tools: result?.tools ?? [] };
}
