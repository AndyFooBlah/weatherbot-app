// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Shared types for the weatherbot agent core.
//
// Everything under src/agent/ is the environment-independent definition of
// what the agent IS — prompt, tool declarations, client-side tools, and
// dispatch logic. It must stay free of browser, React, and Firebase
// imports so the SPA (voice) and the eval harness (headless text) consume
// the exact same brain and cannot drift. Environment-specific concerns
// (how to reach the toolbox, how to talk to Gemini) plug in through the
// ToolTransport interface below.

/** MCP tool descriptor (mirror of functions/src/listTools.ts McpTool). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/** MCP tools/call result content. */
export interface CallToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * How the agent reaches its server-side (toolbox) tools. Two
 * implementations:
 *   - SPA: via the listTools/callTool Cloud Functions (Firebase auth).
 *   - Eval harness: direct MCP JSON-RPC to the toolbox Cloud Run URL
 *     (identity token from ADC).
 */
export interface ToolTransport {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}
