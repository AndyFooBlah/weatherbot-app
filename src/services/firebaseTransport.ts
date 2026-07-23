// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// SPA implementation of the agent core's ToolTransport: reaches the
// weatherbot-toolbox through the listTools/callTool Cloud Functions
// (Firebase-authenticated), so the long-lived toolbox credentials never
// reach the browser. The eval harness uses a direct-toolbox transport
// instead (evals/toolboxTransport.ts) — same interface, same dispatcher.

import { httpsCallable } from 'firebase/functions';
import { functions } from '@andyfooblah/voice-common';
import type { CallToolResult, McpTool, ToolTransport } from '../agent/types';

interface ListToolsResponse {
  tools: McpTool[];
}

export const firebaseTransport: ToolTransport = {
  async listTools(): Promise<McpTool[]> {
    const listToolsFn = httpsCallable<unknown, ListToolsResponse>(
      functions,
      'listTools',
    );
    const res = await listToolsFn({});
    return res.data?.tools ?? [];
  },

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const callToolFn = httpsCallable<
      { name: string; arguments: Record<string, unknown> },
      CallToolResult
    >(functions, 'callTool');
    const res = await callToolFn({ name, arguments: args });
    return res.data;
  },
};
