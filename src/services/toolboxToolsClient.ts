// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Live MCP tool registry: fetch the canonical tool list from the
// weatherbot-toolbox Cloud Run service via the `listTools` Cloud Function,
// translate each MCP descriptor into a Gemini `FunctionDeclaration`, and
// hand the result to `useSession` on session start.
//
// This replaces the previous hardcoded `weatherbotTools` array, which
// drifted every time `agent/toolbox.yaml` changed (e.g. when we renamed
// `lookup_sensor` → `list_sensors` during the narrow-schema migration).
// The toolbox is now the single source of truth.
//
// Two client-side concerns we still handle here:
//
//   1. UI-only parameters — `show_chart` is a SPA concept (the toolbox
//      doesn't know about charts), so we inject it into the chartable
//      tools after translation. `dispatchWeatherbotTool` strips it back
//      out before calling the toolbox.
//
//   2. Type translation — MCP's `inputSchema` uses lowercase JSON Schema
//      type strings ("string", "boolean"); Gemini's `Type` enum is
//      uppercase ("STRING", "BOOLEAN"). One-to-one mapping below.

import { Behavior, FunctionDeclaration, Type } from '@google/genai';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@andyfooblah/voice-common';

/** MCP tool descriptor shape (mirror of functions/src/listTools.ts McpTool). */
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface ListToolsResponse {
  tools: McpTool[];
}

/** Tools whose result the SPA can render as a chart. The agent opts-in
 * per call by passing `show_chart: true` (see instructionBuilder).
 * Single source of truth — SessionView imports this set. */
export const CHARTABLE_TOOLS = new Set<string>([
  'observations_in_range',
  'summarize_period',
  'ask_data',
]);

/**
 * Client-side time tools backed by nl2time (see nl2timeTools.ts). Not
 * toolbox/DB tools — pure deterministic datetime work answered in the
 * browser by dispatchWeatherbotTool with no network round-trip. Declared
 * here so Gemini sees them in its function schema like any other tool.
 * Both are intentionally BLOCKING (no NON_BLOCKING behavior): their
 * results feed the very next tool call or the sentence being spoken.
 */
const RESOLVE_TIME_DECL: FunctionDeclaration = {
  name: 'resolve_time',
  description:
    'Convert a natural-language time phrase the user said into an exact ' +
    'UTC range [start_utc, end_utc). ALWAYS use this for any temporal ' +
    'phrase — never compute UTC offsets, build day windows, or do any ' +
    'calendar math yourself. Pass the phrase as literally as possible: ' +
    '"yesterday", "3pm yesterday", "last week", "yesterday morning", ' +
    '"July 4", "9pm tonight", "in 2 hours".\n' +
    'Returns start_utc, end_utc, grain, and interpreted_as (a human echo ' +
    'of the interpretation you can use when confirming).\n' +
    '• Range tools: from_ts = start_utc and to_ts = end_utc, verbatim.\n' +
    '• A single moment (record_event.occurred_at): use start_utc.\n' +
    '• If `alternatives` is present the phrase was ambiguous — when they ' +
    'differ by a day or more, ask the user which they meant instead of ' +
    'guessing.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      when: {
        type: Type.STRING,
        description: "The user's temporal phrase, as literally as possible.",
      },
    },
    required: ['when'],
  },
};

const DESCRIBE_TIME_DECL: FunctionDeclaration = {
  name: 'describe_time',
  description:
    'Convert UTC timestamp(s) from tool results into natural spoken ' +
    'phrases in the user\'s local time ("9pm last night", "yesterday at ' +
    '3pm"). ALWAYS call this before speaking any timestamp you got from ' +
    'a tool (occurred_at, observed_at, or any other UTC field) — never ' +
    'read an ISO string aloud and never convert it or attach today/' +
    'yesterday labels yourself. Batch-friendly: pass every timestamp you ' +
    'need in ONE call via utc_isos. Speak the returned text verbatim.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      utc_isos: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'UTC ISO 8601 timestamps exactly as returned by other tools, ' +
          'e.g. ["2026-07-21T04:00:00Z"]. One or many.',
      },
    },
    required: ['utc_isos'],
  },
};

/** The `show_chart` parameter, injected client-side onto chartable tools. */
const SHOW_CHART_PARAM = {
  show_chart: {
    type: Type.BOOLEAN,
    description:
      'Set to true ONLY when the user explicitly asks for a chart, graph, plot, ' +
      'or visualization (e.g. "show me a chart of the pool temperature", ' +
      '"graph the rain last week"). Default false — most questions just want ' +
      'a spoken number. The audio answer is still the primary output either ' +
      'way; the chart just appears alongside it on the screen when this is true.',
  },
} as const;

/** Map a JSON Schema "type" string from MCP inputSchema → Gemini's Type enum. */
function jsonTypeToGeminiType(t: string | undefined): Type {
  switch ((t ?? '').toLowerCase()) {
    case 'string':  return Type.STRING;
    case 'boolean': return Type.BOOLEAN;
    case 'number':  return Type.NUMBER;
    case 'integer': return Type.INTEGER;
    case 'array':   return Type.ARRAY;
    case 'object':  return Type.OBJECT;
    default:        return Type.STRING;
  }
}

/** Translate a single MCP tool descriptor into a Gemini FunctionDeclaration. */
function mcpToFunctionDeclaration(tool: McpTool): FunctionDeclaration {
  const inputSchema = tool.inputSchema ?? { type: 'object' };
  const properties: Record<string, { type: Type; description?: string }> = {};
  for (const [k, v] of Object.entries(inputSchema.properties ?? {})) {
    properties[k] = {
      type: jsonTypeToGeminiType(v?.type),
      description: v?.description,
    };
  }

  // Inject show_chart on tools that support a chart rendering. The toolbox
  // never sees this parameter — dispatchWeatherbotTool strips it before
  // the MCP call leaves the browser.
  if (CHARTABLE_TOOLS.has(tool.name)) {
    Object.assign(properties, SHOW_CHART_PARAM);
  }

  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: {
      type: Type.OBJECT,
      properties,
      required: inputSchema.required ?? [],
    },
    // NON_BLOCKING tells Gemini Live that the model may keep generating
    // audio output AFTER emitting the function_call, in parallel with
    // the client running the tool. Without this, the model defaults to
    // BLOCKING: it emits the function_call and pauses until the response
    // returns — which is why the "let me check that for you" filler was
    // always landing AFTER the tool result instead of during the wait.
    // With NON_BLOCKING, the natural conversational pattern works:
    //   user asks → "one sec, let me check…" (spoken) ↘
    //                                                    tool runs
    //   tool result lands (scheduling=WHEN_IDLE)        ↗
    //   model finishes its current sentence, then       ↘
    //   produces the answer audio                        → "it's eighty-six"
    // Per @google/genai docs: behavior is only supported by Live (Bidi)
    // streaming, which is exactly what we use.
    behavior: Behavior.NON_BLOCKING,
  };
}

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
  const listToolsFn = httpsCallable<unknown, ListToolsResponse>(
    functions,
    'listTools',
  );
  const t0 = performance.now();
  const res = await listToolsFn({});
  const fetchMs = (performance.now() - t0).toFixed(0);
  const tools = res.data?.tools ?? [];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('listTools returned no tools — toolbox may be misconfigured.');
  }
  lastFetchedToolNames = tools.map((t) => t.name).filter(Boolean);
  const declarations = tools.map(mcpToFunctionDeclaration);
  // Append the client-side nl2time tools (handled in-browser by
  // dispatchWeatherbotTool, never forwarded to the toolbox). Add their
  // names to the registry so "tool does not exist" self-correction knows.
  declarations.push(RESOLVE_TIME_DECL, DESCRIBE_TIME_DECL);
  lastFetchedToolNames.push('resolve_time', 'describe_time');
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
