// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Eval-harness implementation of the agent core's ToolTransport: direct
// MCP JSON-RPC to the weatherbot-toolbox Cloud Run service, with an
// identity token minted from Application Default Credentials (same auth
// pattern as weatherbot/scripts/invoke-tool.sh). No Firebase involved —
// the harness runs headless in Node.
//
// The toolbox speaks streamable-HTTP MCP: a POST to /mcp may answer as
// plain JSON or as an SSE stream; parseMcpBody handles both.

import { execFileSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';
import type { CallToolResult, McpTool, ToolTransport } from '../src/agent/types';

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

function parseMcpBody(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // SSE framing: take the last `data:` line.
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) {
    throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

export function createToolboxTransport(toolboxUrl: string): ToolTransport {
  const auth = new GoogleAuth();
  let rpcId = 0;
  let cachedGcloudToken: { token: string; mintedAt: number } | null = null;

  // Identity token for the Cloud Run audience. Service-account ADC (CI)
  // can mint one via getIdTokenClient; user ADC (a developer laptop)
  // cannot — it either throws or yields a token Cloud Run rejects — so
  // on failure OR a 401/403 we fall back (stickily) to
  // `gcloud auth print-identity-token`, the same pattern as
  // weatherbot/scripts/invoke-tool.sh. Tokens live ~1h; cache 30 min.
  let useGcloudFallback = false;

  function gcloudAuthHeader(): Record<string, string> {
    if (
      !cachedGcloudToken ||
      Date.now() - cachedGcloudToken.mintedAt > 30 * 60_000
    ) {
      const token = execFileSync('gcloud', ['auth', 'print-identity-token'], {
        encoding: 'utf8',
      }).trim();
      cachedGcloudToken = { token, mintedAt: Date.now() };
    }
    return { Authorization: `Bearer ${cachedGcloudToken.token}` };
  }

  async function libraryAuthHeader(): Promise<Record<string, string> | null> {
    try {
      const client = await auth.getIdTokenClient(toolboxUrl);
      const headers = await client.getRequestHeaders(toolboxUrl);
      const entries = Object.fromEntries(Object.entries(headers)) as Record<
        string,
        string
      >;
      return entries.Authorization ? entries : null;
    } catch {
      return null;
    }
  }

  async function doFetch(
    method: string,
    params: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${toolboxUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  }

  async function rpc(method: string, params: unknown): Promise<unknown> {
    let res: Response;
    if (useGcloudFallback) {
      res = await doFetch(method, params, gcloudAuthHeader());
    } else {
      const libHeaders = await libraryAuthHeader();
      res = libHeaders
        ? await doFetch(method, params, libHeaders)
        : new Response(null, { status: 401 });
      if (res.status === 401 || res.status === 403) {
        useGcloudFallback = true;
        res = await doFetch(method, params, gcloudAuthHeader());
      }
    }
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`toolbox ${method} HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const parsed = parseMcpBody(body);
    if (parsed.error) {
      throw new Error(`toolbox ${method} error: ${parsed.error.message ?? 'unknown'}`);
    }
    return parsed.result;
  }

  return {
    async listTools(): Promise<McpTool[]> {
      const result = (await rpc('tools/list', {})) as { tools?: McpTool[] };
      return result?.tools ?? [];
    },
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> {
      return (await rpc('tools/call', { name, arguments: args })) as CallToolResult;
    },
  };
}
