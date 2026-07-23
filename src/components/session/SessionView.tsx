// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The voice session view. Mobile-first portrait layout: header at the top,
// transcript feed in the middle (auto-scrolls to bottom), big tap-to-start
// (or stop) button pinned to the bottom safe area.

import { useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth, ConnectionStatus } from '@andyfooblah/voice-common';
import type { User } from 'firebase/auth';
import type { Message as VcMessage } from '@andyfooblah/voice-common';
import { useWeatherbotSession } from '../../hooks/useWeatherbotSession';
import { ToolResultChart } from './ToolResultChart';
// A chart renders ONLY when (a) the tool is in CHARTABLE_TOOLS AND (b) the
// agent passed `show_chart: true` in the tool args. The agent decides per
// prompt — see instructionBuilder's "Charts and visualizations" section.
// This is an audio-first app; most calls just want the spoken number.
import { CHARTABLE_TOOLS } from '../../services/toolboxToolsClient';

interface SessionViewProps {
  user: User;
}

export function SessionView({ user }: SessionViewProps) {
  const [botSpeaking, setBotSpeaking] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    connectionStatus,
    startSession,
    stopSession,
    isRecording,
    error,
    isWaitingForTool,
  } = useWeatherbotSession({
    userId: user.uid,
    onBotSpeaking: setBotSpeaking,
  });

  // VoiceCommon@5be6606 (#9) added `Message.toolResult` so the in-memory
  // Message now carries the dispatcher's return value directly. We
  // pre-format each tool message's result so the render is cheap.
  const formattedByMessageId = useMemo(() => {
    const map = new Map<string, FormattedToolResult>();
    for (const m of messages) {
      if (m.role === 'tool') {
        map.set(m.id, formatToolResult(m.toolResult ?? ''));
      }
    }
    return map;
  }, [messages]);

  // Auto-scroll transcript to bottom whenever a new message lands.
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages]);

  // voice-common reports CONNECTING for both the initial connect and
  // session-resumption reconnects; there is no separate RECONNECTING state.
  const isConnecting = connectionStatus === ConnectionStatus.CONNECTING;

  const handleToggle = async () => {
    if (isRecording) {
      await stopSession();
    } else {
      await startSession();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 bg-white border-b border-slate-200">
        <div>
          <h1 className="text-base font-semibold text-slate-900">WeatherBot</h1>
          <p className="text-xs text-slate-500">{user.email}</p>
        </div>
        <button
          onClick={() => signOut(auth)}
          className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
        >
          Sign out
        </button>
      </header>

      {/* Transcript */}
      <main
        ref={transcriptRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {messages.length === 0 && !isRecording && (
          <div className="text-center text-slate-400 text-sm mt-12 max-w-xs mx-auto">
            Tap the mic to start a voice session. Try
            <em> "What's the temperature in the bedroom?" </em>
            or
            <em> "How much rain fell last week?" </em>
          </div>
        )}
        {messages.map((m, idx) => {
          // Latency since the previous message of any role. Discreet —
          // shown right-aligned in a small slate-400 text below the
          // bubble. We render only when the gap is non-trivial
          // (>200ms) to avoid noise.
          const prev = idx > 0 ? messages[idx - 1] : null;
          const sincePrevMs = prev
            ? m.timestamp.getTime() - prev.timestamp.getTime()
            : null;
          const sincePrev =
            sincePrevMs !== null && sincePrevMs > 200
              ? formatMs(sincePrevMs)
              : null;

          if (m.role === 'tool') {
            return (
              <ToolCardWithLatency
                key={m.id}
                m={m}
                formatted={
                  formattedByMessageId.get(m.id) ?? { body: '(no result captured)' }
                }
                sincePrev={sincePrev}
              />
            );
          }
          return (
            <div key={m.id}>
              <div
                className={
                  m.role === 'user'
                    ? 'ml-12 px-4 py-2 rounded-2xl bg-sky-500 text-white text-sm whitespace-pre-wrap'
                    : 'mr-12 px-4 py-2 rounded-2xl bg-white border border-slate-200 text-slate-800 text-sm whitespace-pre-wrap'
                }
              >
                {m.text}
              </div>
              {sincePrev && (
                <div
                  className={`mt-0.5 text-[10px] text-slate-400 ${
                    m.role === 'user' ? 'text-right pr-2' : 'pl-2'
                  }`}
                  title={`${sincePrevMs}ms since previous message`}
                >
                  +{sincePrev}
                </div>
              )}
            </div>
          );
        })}
        {isWaitingForTool && (
          <div
            className="mr-12 px-4 py-3 rounded-2xl bg-white border border-slate-200 inline-flex items-center gap-1.5"
            aria-label="waiting for database"
            role="status"
          >
            <span className="block w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="block w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="block w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
        )}
        {botSpeaking && (
          <div className="mr-12 px-4 py-2 rounded-2xl bg-white border border-slate-200 text-slate-400 text-sm italic">
            …speaking
          </div>
        )}
        {error && (
          <div className="px-4 py-2 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            {error}
          </div>
        )}
      </main>

      {/* Bottom action bar */}
      <div className="bg-white border-t border-slate-200 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          onClick={handleToggle}
          disabled={isConnecting}
          className={[
            'w-full py-4 rounded-2xl text-base font-medium transition',
            'disabled:opacity-60',
            isRecording
              ? 'bg-rose-500 hover:bg-rose-600 text-white'
              : 'bg-sky-500 hover:bg-sky-600 text-white',
          ].join(' ')}
        >
          {isConnecting
            ? 'Connecting…'
            : isRecording
              ? 'Tap to stop'
              : 'Tap to talk'}
        </button>
        <div className="mt-2 text-center text-xs text-slate-400">
          {connectionStatusLabel(connectionStatus)}
        </div>
      </div>
    </div>
  );
}

/** Maximum lines of pretty-printed result to render before truncating. */
const TOOL_RESULT_MAX_LINES = 15;

/** Maximum array elements to pretty-print before truncating. */
const TOOL_RESULT_MAX_ITEMS = 10;

interface FormattedToolResult {
  /** Pretty-printed body to render inside the <pre> block. */
  body: string;
  /** Optional small caption above the body, e.g. "(48 rows)". */
  summary?: string;
  /** Parsed rows when the result was JSON, for chart rendering. */
  data?: unknown[];
}

/**
 * Pretty-print a captured tool result. Strategy:
 *   1. Try JSON.parse — handles single objects and JSON arrays.
 *   2. Try NDJSON (one JSON value per line) — postgres-sql MCP tools
 *      often emit one row per content part, which our dispatcher joins
 *      with newlines.
 *   3. Fall back to raw text with line-based truncation (covers
 *      ask_data's natural-language responses).
 */
function formatToolResult(raw: string): FormattedToolResult {
  if (!raw) return { body: '(no result captured)' };

  // 1. Single JSON value.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ...formatArray(parsed), data: parsed };
    }
    // Single object or scalar — pretty-print whole thing, truncate by line.
    // Wrap in a single-item array so chart logic can introspect rows uniformly.
    return {
      body: clipLines(JSON.stringify(parsed, null, 2)),
      data: typeof parsed === 'object' && parsed !== null ? [parsed] : undefined,
    };
  } catch {
    // fall through
  }

  // 2. NDJSON — try parsing each non-empty line.
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length > 0) {
    const parsedAll: unknown[] = [];
    let allValid = true;
    for (const line of lines) {
      try {
        parsedAll.push(JSON.parse(line));
      } catch {
        allValid = false;
        break;
      }
    }
    if (allValid && parsedAll.length > 0) {
      return { ...formatArray(parsedAll), data: parsedAll };
    }
  }

  // 3. Raw text fallback.
  return { body: clipLines(raw) };
}

function formatArray(arr: unknown[]): Pick<FormattedToolResult, 'body' | 'summary'> {
  if (arr.length === 0) return { body: '[]', summary: '(0 rows)' };
  const head = arr.slice(0, TOOL_RESULT_MAX_ITEMS);
  const body = clipLines(JSON.stringify(head, null, 2));
  const summary = `(${arr.length} ${arr.length === 1 ? 'row' : 'rows'}${
    arr.length > TOOL_RESULT_MAX_ITEMS
      ? `, showing first ${TOOL_RESULT_MAX_ITEMS}`
      : ''
  })`;
  return { body, summary };
}

function clipLines(s: string): string {
  const lines = s.split('\n');
  if (lines.length <= TOOL_RESULT_MAX_LINES) return s;
  return (
    `${lines.slice(0, TOOL_RESULT_MAX_LINES).join('\n')}\n… (${
      lines.length - TOOL_RESULT_MAX_LINES
    } more lines)`
  );
}

/**
 * Format a millisecond duration as a short, glanceable string.
 *   123   → "0.1s"
 *   1234  → "1.2s"
 *   12345 → "12s"
 */
function formatMs(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Human-readable byte count for the JSON-result size badge. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Why a chart did or did NOT render — surfaced in the UI as a tiny note
 *  AND logged to the console so a missing chart is debuggable.  */
function decideChart(m: VcMessage, formatted: FormattedToolResult): {
  show: boolean;
  reason: string;
} {
  if (!m.toolName) return { show: false, reason: 'no toolName on message' };
  if (!CHARTABLE_TOOLS.has(m.toolName)) {
    return { show: false, reason: `${m.toolName} is not chartable` };
  }
  if (m.toolArgs?.show_chart !== true) {
    return { show: false, reason: 'show_chart was not true on the call' };
  }
  if (formatted.data === undefined) {
    return { show: false, reason: 'tool result was not parseable as JSON rows' };
  }
  if (Array.isArray(formatted.data) && formatted.data.length === 0) {
    return { show: false, reason: 'tool result was an empty array (no data)' };
  }
  return { show: true, reason: 'rendering' };
}

interface ToolCardProps {
  m: VcMessage;
  formatted: FormattedToolResult;
  sincePrev: string | null;
}

/**
 * One tool-call card. Shows the call (toolName + args), result summary,
 * chart (when warranted), collapsed raw JSON, and a discreet latency
 * footer with both the tool dispatch time and the gap since the
 * previous message. Also logs the chart decision so a "why didn't the
 * chart render?" question is answerable from the console.
 */
function ToolCardWithLatency({ m, formatted, sincePrev }: ToolCardProps) {
  const argsStr =
    m.toolArgs && Object.keys(m.toolArgs).length > 0
      ? JSON.stringify(m.toolArgs)
      : '';

  const { show: showChart, reason: chartReason } = decideChart(m, formatted);

  useEffect(() => {
    console.log(
      `[SessionView] tool=${m.toolName} chart=${
        showChart ? 'YES' : 'no'
      } reason=${JSON.stringify(chartReason)} ` +
        `bytes=${m.toolResultBytes ?? '?'} ` +
        `tookMs=${m.toolDurationMs ?? '?'} ` +
        `args=${argsStr}`,
    );
  }, [m.id, m.toolName, showChart, chartReason, argsStr, m.toolResultBytes, m.toolDurationMs]);

  const toolMs = m.toolDurationMs;
  const bytes = m.toolResultBytes;

  return (
    <div>
      <div className="bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-mono text-[11px] leading-snug overflow-hidden">
        <div className="text-slate-600 font-semibold break-all">
          {m.toolName ?? 'tool'}({argsStr})
        </div>
        {formatted.summary && (
          <div className="text-slate-500 text-[10px] mt-0.5">{formatted.summary}</div>
        )}

        {showChart && (
          <ToolResultChart toolName={m.toolName} data={formatted.data} />
        )}

        {/* When the agent set show_chart=true but we couldn't render, surface
            why so the user isn't left wondering. Discreet — small slate
            text below the row count.  */}
        {!showChart && m.toolArgs?.show_chart === true && (
          <div className="text-amber-700 text-[10px] mt-1">
            chart not rendered: {chartReason}
          </div>
        )}

        {/* JSON raw result is collapsed by default — tap to expand. */}
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-[10px] text-slate-500 hover:text-slate-700 list-none flex items-center gap-1">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span>
            <span>raw JSON</span>
            {bytes !== undefined && bytes > 0 && (
              <span className="text-slate-400">· {formatBytes(bytes)}</span>
            )}
          </summary>
          <pre className="mt-1 text-slate-700 whitespace-pre-wrap break-words text-[10px]">
            {formatted.body}
          </pre>
        </details>
      </div>

      {/* Discreet latency footer — tool dispatch time and gap since the
          previous message of any role. Right-aligned in slate-400 so it
          doesn't fight for attention with the bubble content. */}
      <div
        className="mt-0.5 pr-2 text-right text-[10px] text-slate-400"
        title={
          (toolMs !== undefined ? `tool took ${toolMs}ms` : '') +
          (sincePrev ? ` · ${sincePrev} since previous` : '')
        }
      >
        {toolMs !== undefined && <span>took {formatMs(toolMs)}</span>}
        {toolMs !== undefined && sincePrev && <span> · </span>}
        {sincePrev && <span>+{sincePrev}</span>}
      </div>
    </div>
  );
}

function connectionStatusLabel(s: ConnectionStatus): string {
  switch (s) {
    case ConnectionStatus.CONNECTED:
      return 'Connected';
    case ConnectionStatus.CONNECTING:
      return 'Connecting…';
    case ConnectionStatus.DISCONNECTED:
      return 'Disconnected';
    default:
      return '';
  }
}
