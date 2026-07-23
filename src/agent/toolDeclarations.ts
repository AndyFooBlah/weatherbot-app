// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Tool declarations for the weatherbot agent — part of the agent core
// (see types.ts): no browser/React/Firebase imports.
//
// Translates MCP tool descriptors (fetched by a ToolTransport) into
// Gemini FunctionDeclarations, injects UI-only parameters onto chartable
// tools, and appends the client-side nl2time tool declarations. Both the
// SPA and the eval harness build their Gemini tool list through
// buildDeclarations(), so the schema the model sees is identical in
// production and under test.

import { Behavior, FunctionDeclaration, Type } from '@google/genai';
import type { McpTool } from './types';

/** Tools whose result the SPA can render as a chart. The agent opts-in
 * per call by passing `show_chart: true` (see instructionBuilder).
 * Single source of truth — SessionView imports this set. */
export const CHARTABLE_TOOLS = new Set<string>([
  'observations_in_range',
  'summarize_period',
  'ask_data',
]);

/** Names of the client-side tools answered locally (never forwarded to
 * the toolbox). Single source of truth for dispatcher + registries. */
export const CLIENT_SIDE_TOOL_NAMES = ['resolve_time', 'describe_time'] as const;

/**
 * Client-side time tools backed by nl2time (see nl2timeTools.ts). Not
 * toolbox/DB tools — pure deterministic datetime work answered locally
 * by the dispatcher with no network round-trip. Declared here so Gemini
 * sees them in its function schema like any other tool.
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
  // never sees this parameter — the dispatcher strips it before the MCP
  // call goes out.
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

export interface BuiltDeclarations {
  declarations: FunctionDeclaration[];
  /** Every callable tool name (toolbox + client-side), for the
   * "tool does not exist" self-correction message. */
  toolNames: string[];
}

/**
 * Translate the fetched MCP tool list into the full Gemini declaration
 * array: MCP → Gemini translation, `show_chart` on chartable tools, plus
 * the client-side nl2time tools appended.
 */
export function buildDeclarations(tools: McpTool[]): BuiltDeclarations {
  const declarations = tools.map(mcpToFunctionDeclaration);
  declarations.push(RESOLVE_TIME_DECL, DESCRIBE_TIME_DECL);
  const toolNames = [
    ...tools.map((t) => t.name).filter(Boolean),
    ...CLIENT_SIDE_TOOL_NAMES,
  ];
  return { declarations, toolNames };
}
