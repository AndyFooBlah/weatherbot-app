// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Tool dispatch for the weatherbot agent — part of the agent core (see
// types.ts): no browser/React/Firebase imports.
//
// One dispatcher serves both runtimes: the SPA passes its Cloud-Function
// transport, the eval harness passes a direct-toolbox transport. All the
// behavior that protects the Gemini Live session — client-side nl2time
// tools, UI-arg stripping, chart row capping, result-size capping, and
// invalid-tool-name self-correction — lives here so production and evals
// exercise the identical code path.

import { describeTimeTool, resolveTimeTool } from './nl2timeTools';
import type { ToolTransport } from './types';

/** Argument keys that are UI-only (added by toolDeclarations onto chartable
 * tools' FunctionDeclarations) and must be stripped before the call is
 * forwarded to the toolbox — the toolbox doesn't declare these and would
 * reject them as unknown parameters. */
const UI_ONLY_ARG_KEYS = new Set(['show_chart']);

/**
 * Maximum characters of tool result text handed back to Gemini Live in a
 * single tool response. Gemini's WebSocket frame limit empirically sits
 * around ~1 MB; oversized payloads close the socket with code 1007
 * ("data inconsistent with message format"), which then triggers the
 * reconnect loop, which then re-issues the same broken tool call against
 * a fresh socket — eventually exhausting reconnect attempts and ending the
 * session.
 *
 * 256 KB is well below the empirical threshold and is much larger than any
 * legitimate curated-tool result (a week of one sensor's 5-min readings is
 * ~50 KB). When a result exceeds the cap we replace it with a short
 * structured message telling the model *why* and asking for a more
 * specific filter — that nudges the next turn toward
 * (location, measurement_type) instead of silently retrying.
 */
const MAX_TOOL_RESULT_CHARS = 256 * 1024;

/**
 * When the agent requests a chart on observations_in_range, cap the row
 * count so the result fits comfortably inside Gemini Live's WebSocket
 * frame budget. The chart decimates to 500 points before rendering
 * anyway, so anything beyond that is wasted bandwidth.
 *
 * Without this guard a "chart of the pool temperature for the last two
 * weeks" call returns ~4000 rows ≈ 800 KB, our 256 KB safety cap kicks
 * in, the data gets replaced with a guidance string, and the chart
 * silently can't parse rows.
 */
const CHART_ROW_LIMIT = 500;

export interface DispatcherOptions {
  /** Supplier of the currently-known tool names, used to build the
   * self-correcting "tool does not exist" message. */
  getKnownToolNames: () => string[];
}

/**
 * Create the tool dispatcher. Always resolves to a string — even on
 * error — because Gemini Live expects a tool response per call.
 */
export function createDispatcher(
  transport: ToolTransport,
  opts: DispatcherOptions,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // Client-side nl2time tools: pure deterministic datetime work — no
    // toolbox, no DB round-trip. Answer locally and return.
    if (name === 'resolve_time') {
      try {
        return JSON.stringify(resolveTimeTool(String(args.when ?? '')));
      } catch (err) {
        return `resolve_time couldn't interpret "${String(args.when ?? '')}": ` +
          `${(err as Error).message}`;
      }
    }
    if (name === 'describe_time') {
      try {
        const input = Array.isArray(args.utc_isos)
          ? (args.utc_isos as string[])
          : [String(args.utc_isos ?? args.utc_iso ?? '')];
        return JSON.stringify(describeTimeTool(input));
      } catch (err) {
        return `describe_time failed: ${(err as Error).message}. Pass UTC ` +
          `ISO 8601 timestamps exactly as returned by other tools.`;
      }
    }

    // Strip UI-only args (e.g. show_chart) — the toolbox would reject them
    // as unknown parameters. The original `args` object is still attached
    // to the in-memory tool Message so the UI can read it back.
    let toolboxArgs = Object.fromEntries(
      Object.entries(args).filter(([k]) => !UI_ONLY_ARG_KEYS.has(k)),
    );

    // Chart-aware row capping for observations_in_range.
    if (name === 'observations_in_range' && args.show_chart === true) {
      const existing =
        typeof toolboxArgs.row_limit === 'number' ? toolboxArgs.row_limit : null;
      toolboxArgs = {
        ...toolboxArgs,
        row_limit: existing !== null ? Math.min(existing, CHART_ROW_LIMIT) : CHART_ROW_LIMIT,
      };
    }
    try {
      const result = await transport.callTool(name, toolboxArgs);
      if (result.isError) {
        return `Tool "${name}" returned an error: ${result.content?.[0]?.text ?? 'unknown'}`;
      }
      // MCP convention: result.content is an array of { type, text }. For our
      // postgres-sql tools the text is a JSON-string of the row(s). Concatenate
      // all text parts and hand back to Gemini as-is.
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (!text) return '(empty result)';

      if (text.length > MAX_TOOL_RESULT_CHARS) {
        console.warn(
          `[dispatcher] ${name} result is ${text.length} chars; ` +
            `capping at ${MAX_TOOL_RESULT_CHARS} to protect the Live WebSocket. ` +
            `Args were: ${JSON.stringify(toolboxArgs).slice(0, 200)}`,
        );
        // Show the model the very first chunk (so it still has *some* signal
        // about the shape of the data) plus an explicit guidance line. We
        // intentionally don't truncate to JSON; the model handles a system
        // hint better than a half-parsed object.
        const sample = text.slice(0, 4000);
        return [
          `[Tool "${name}" returned ${text.length.toLocaleString()} characters, ` +
            `which is larger than the conversation transport can carry. ` +
            `Re-call the tool with a tighter filter — typically by adding ` +
            `location and measurement_type (or a sensor_id from list_sensors) ` +
            `so only ONE sensor's readings come back. ` +
            `Below is a short sample of the first few rows for context.]`,
          '',
          sample,
        ].join('\n');
      }
      return text;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[dispatcher] ${name} failed`, err);
      // When the model invents a tool name (e.g. a stale memory like
      // "lookup_sensor"), the toolbox chain returns
      // "invalid tool name: tool with name '<X>' does not exist".
      // Surface the *actual* available tool names back to the model so
      // it can self-correct in the same turn instead of looping on the
      // bad name. Without this, Gemini happily retries the same wrong
      // call ("Let me try again.") and burns the conversation.
      if (/invalid tool name|does not exist/i.test(msg)) {
        const available = opts.getKnownToolNames();
        const availStr = available.length > 0 ? available.join(', ') : '(unknown)';
        return (
          `Tool "${name}" does not exist. ` +
          `The available tools right now are: ${availStr}. ` +
          `Pick the closest match by intent — do NOT retry "${name}". ` +
          `For finding the current value at a location, use latest_observation ` +
          `with location + measurement_type filters directly.`
        );
      }
      return `Tool "${name}" failed: ${msg}`;
    }
  };
}
