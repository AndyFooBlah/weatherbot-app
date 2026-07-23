// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Headless conversation driver: runs the PRODUCTION weatherbot brain —
// same model, same (voice) system prompt, same tool declarations, same
// dispatcher — over the Gemini Live API from Node, with text turns in
// and output transcription + a structured tool trace out.
//
// This is the "text-only mode" of the app: native-audio Live models only
// emit AUDIO, so the text we grade is the output transcription — which
// is exactly what production users hear, transcribed. The prompt stays
// modality 'voice' on purpose: the harness evaluates the production
// agent, not a text variant.
//
// Auth: GEMINI_API_KEY env var (Secret Manager / shell env — never
// committed). No ephemeral-token broker needed server-side.

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
} from '@google/genai';
import { createDispatcher } from '../src/agent/dispatcher';
import {
  buildWeatherbotInstruction,
  captureNow,
  NowContext,
} from '../src/agent/instructionBuilder';
import { buildDeclarations } from '../src/agent/toolDeclarations';
import type { ToolTransport } from '../src/agent/types';

/** Production Live model — must match voicecommon's default. */
export const WEATHERBOT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export type TraceEvent =
  | { type: 'user'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'bot'; text: string };

export interface ConversationResult {
  /** Full ordered trace of the conversation. */
  events: TraceEvent[];
  /** Per user turn: all bot transcription emitted before the next user turn. */
  answers: string[];
  /** Tool calls in order (convenience view over events). */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface DriverOptions {
  transport: ToolTransport;
  apiKey?: string;
  model?: string;
  /** Frozen "now" for reproducible prompts; defaults to real time. */
  now?: NowContext;
  /** Max ms to wait for a turn to settle (default 90s — ask_data is slow). */
  turnTimeoutMs?: number;
  /** Quiet period after the last activity before a turn counts as settled
   * (default 3s — NON_BLOCKING tools produce a second generation after the
   * tool result lands). */
  settleMs?: number;
  /** Log the live exchange to stderr. */
  debug?: boolean;
}

/**
 * Run a scripted multi-turn conversation against the production agent
 * config. Each string in `turns` is one user message; the driver waits
 * for the agent (including any tool round-trips) to settle before
 * sending the next.
 */
export async function runConversation(
  turns: string[],
  opts: DriverOptions,
): Promise<ConversationResult> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required (env or opts.apiKey)');
  const model = opts.model ?? WEATHERBOT_LIVE_MODEL;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 90_000;
  const settleMs = opts.settleMs ?? 3_000;
  const debug = opts.debug ?? false;
  const log = (m: string) => debug && console.error(`[driver] ${m}`);

  // Assemble the production brain.
  const mcpTools = await opts.transport.listTools();
  if (mcpTools.length === 0) throw new Error('toolbox returned no tools');
  const { declarations, toolNames } = buildDeclarations(mcpTools);
  const dispatch = createDispatcher(opts.transport, {
    getKnownToolNames: () => toolNames,
  });
  const systemInstruction = buildWeatherbotInstruction(
    opts.now ?? captureNow(),
    'voice',
  );

  const events: TraceEvent[] = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  // Turn-settlement machinery: a turn is done when we've seen at least one
  // turnComplete, no tool responses are in flight, and the wire has been
  // quiet for settleMs.
  let lastActivity = Date.now();
  let turnCompletes = 0;
  let pendingTools = 0;
  let currentBotText = '';
  let closed = false;
  let fatal: Error | null = null;

  const flushBotText = () => {
    if (currentBotText.trim()) {
      events.push({ type: 'bot', text: currentBotText.trim() });
    }
    currentBotText = '';
  };

  const ai = new GoogleGenAI({ apiKey });
  let session: Session;

  const onmessage = async (msg: LiveServerMessage) => {
    lastActivity = Date.now();
    const sc = msg.serverContent;
    if (sc?.outputTranscription?.text) {
      currentBotText += sc.outputTranscription.text;
    }
    if (sc?.turnComplete) {
      turnCompletes += 1;
      log(`turnComplete #${turnCompletes}`);
    }
    if (msg.toolCall?.functionCalls?.length) {
      for (const fc of msg.toolCall.functionCalls) {
        const name = fc.name ?? '(unnamed)';
        const args = (fc.args ?? {}) as Record<string, unknown>;
        events.push({ type: 'tool_call', name, args });
        toolCalls.push({ name, args });
        log(`tool_call ${name} ${JSON.stringify(args).slice(0, 200)}`);
        pendingTools += 1;
        // Dispatch async; Live handles interleaving.
        (async () => {
          try {
            const result = await dispatch(name, args);
            events.push({ type: 'tool_result', name, result });
            log(`tool_result ${name} ${result.slice(0, 150)}`);
            session.sendToolResponse({
              functionResponses: [
                { id: fc.id, name, response: { result } },
              ],
            });
          } catch (err) {
            const emsg = (err as Error).message;
            events.push({ type: 'tool_result', name, result: `ERROR: ${emsg}` });
            session.sendToolResponse({
              functionResponses: [
                { id: fc.id, name, response: { result: `ERROR: ${emsg}` } },
              ],
            });
          } finally {
            pendingTools -= 1;
            lastActivity = Date.now();
          }
        })();
      }
    }
  };

  session = await ai.live.connect({
    model,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: declarations as FunctionDeclaration[] }],
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => log('connected'),
      onmessage,
      onerror: (e: { message?: string }) => {
        fatal = new Error(`live error: ${e.message ?? 'unknown'}`);
      },
      onclose: (e: { code?: number; reason?: string }) => {
        closed = true;
        log(`closed code=${e.code} reason=${e.reason}`);
      },
    },
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const waitForSettle = async () => {
    const deadline = Date.now() + turnTimeoutMs;
    for (;;) {
      if (fatal) throw fatal;
      if (closed) throw new Error('live session closed mid-turn');
      const quiet = Date.now() - lastActivity;
      if (turnCompletes > 0 && pendingTools === 0 && quiet >= settleMs) return;
      if (Date.now() > deadline) {
        throw new Error(
          `turn timed out after ${turnTimeoutMs}ms ` +
            `(turnCompletes=${turnCompletes} pendingTools=${pendingTools})`,
        );
      }
      await sleep(150);
    }
  };

  const answers: string[] = [];
  try {
    for (const turn of turns) {
      events.push({ type: 'user', text: turn });
      log(`user: ${turn}`);
      turnCompletes = 0;
      lastActivity = Date.now();
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: turn }] }],
        turnComplete: true,
      });
      await waitForSettle();
      flushBotText();
      // Everything the bot said since the user turn = this turn's answer.
      const lastUserIdx = events.map((e) => e.type).lastIndexOf('user');
      const answer = events
        .slice(lastUserIdx + 1)
        .filter((e): e is Extract<TraceEvent, { type: 'bot' }> => e.type === 'bot')
        .map((e) => e.text)
        .join(' ');
      answers.push(answer);
      log(`answer: ${answer.slice(0, 200)}`);
    }
  } finally {
    try {
      session.close();
    } catch {
      /* already closed */
    }
  }

  return { events, answers, toolCalls };
}
