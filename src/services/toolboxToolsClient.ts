// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// SPA-side tool registry: fetch the canonical MCP tool list through the
// Firebase transport, translate it via the agent core's buildDeclarations
// (MCP → Gemini, show_chart injection, client-side nl2time tools), cache
// the names for self-correction, and log the registry for debugging.
//
// The translation itself lives in src/agent/toolDeclarations.ts so the
// eval harness builds the IDENTICAL declaration array — the toolbox is
// the single source of truth for server tools, and the agent core is the
// single source of truth for how they're presented to Gemini.

import { FunctionDeclaration } from '@google/genai';
import { buildDeclarations, CHARTABLE_TOOLS } from '../agent/toolDeclarations';
import { firebaseTransport } from './firebaseTransport';

// Re-exported for SessionView (chart gating).
export { CHARTABLE_TOOLS };

/**
 * Module-level cache of the most-recently-fetched tool *names*. Used by
 * dispatchWeatherbotTool to construct a self-correcting error when the
 * model invents a name that doesn't exist (e.g. an outdated training
 * memory of `lookup_sensor`). The cache is refreshed on every
 * fetchWeatherbotTools() call.
 */
let lastFetchedToolNames: string[] = [];

export function getLastFetchedToolNames(): string[] {
  return lastFetchedToolNames;
}

/**
 * Fetch the canonical tool list from the toolbox (via the listTools Cloud
 * Function), translate MCP → Gemini, augment chartable tools with
 * `show_chart`, and return a ready-to-pass-to-Gemini array.
 *
 * Throws on network / auth / serialization errors. Caller is expected to
 * surface a useful error to the user since a missing tool list means the
 * session can't do anything.
 */
export async function fetchWeatherbotTools(): Promise<FunctionDeclaration[]> {
  const t0 = performance.now();
  const tools = await firebaseTransport.listTools();
  const fetchMs = (performance.now() - t0).toFixed(0);
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('listTools returned no tools — toolbox may be misconfigured.');
  }
  const { declarations, toolNames } = buildDeclarations(tools);
  lastFetchedToolNames = toolNames;
  // Tool-registry visibility log — answers "did the SPA actually hand
  // tools to Gemini at session start, and what shape did they have?".
  // Without this log we can't tell whether a "model didn't call any
  // tool" failure was the model being lazy or the tool list being empty.
  console.log(
    `[toolboxToolsClient] fetched ${tools.length} tools in ${fetchMs}ms: ` +
      lastFetchedToolNames.join(', '),
  );
  for (const d of declarations) {
    const paramKeys = d.parameters?.properties
      ? Object.keys(d.parameters.properties).join(', ') || '(none)'
      : '(none)';
    const required =
      Array.isArray(d.parameters?.required) && d.parameters!.required!.length > 0
        ? ` required=[${d.parameters!.required!.join(', ')}]`
        : '';
    console.log(`[toolboxToolsClient]   • ${d.name}(${paramKeys})${required}`);
  }
  return declarations;
}
