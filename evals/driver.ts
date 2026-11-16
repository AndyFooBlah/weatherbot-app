// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Headless conversation driver: runs the PRODUCTION weatherbot brain —
// same model, same (voice) system prompt, same tool declarations, same
// dispatcher, same Live connect config — over the Gemini Live API from
// Node, with text turns in and output transcription + a structured tool
// trace out.
//
// This is the "text-only mode" of the app: native-audio Live models only
// emit AUDIO, so the text we grade is the output transcription — which
// is exactly what production users hear, transcribed. The prompt stays
// modality 'voice' on purpose: the harness evaluates the production
// agent, not a text variant.
//
// ONE CONNECT CONFIG. The `config` sent to `ai.live.connect` comes from
// buildEvalLiveConnectConfig below: VoiceCommon's buildLiveConnectConfig
// (the function its useSession hook calls) fed with
// weatherbotLiveConnectParams (src/agent/liveConfig.ts), the same inputs the
// SPA passes. tests/liveConfig.test.ts proves it equals the production
// config, so an eval run exercises the setup message production sends:
// voice, server-VAD turn-taking defaults, input and output transcription,
// session resumption, context-window compression and the injected
// `endSession` tool.
//
// DELIBERATE DIFFERENCES from a production session, each covered by
// tests/evalDriver.test.ts:
//   1. User turns are TEXT, sent with sendClientContent. Production streams
//      microphone audio (and sends its opening cue as realtime text).
//   2. No opening greeting cue (AUTO_GREET_TEXT) is sent; the script's first
//      turn opens the conversation.
//   3. Auth is the long-lived GEMINI_API_KEY from the environment (Secret
//      Manager / shell env — never committed). Production connects with a
//      single-use ephemeral token minted by the mintGeminiLiveToken
//      callable. Both connect on the same API version (LIVE_API_VERSION).
//   4. `endSession` is acknowledged ('ok', as the hook answers it) and
//      recorded in the trace, but the driver keeps the socket open so the
//      rest of a scripted conversation still runs. Production stops the
//      session. `ConversationResult.endSessionRequested` reports it.
//   5. A fresh session per conversation: no resumption handle is passed.

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveConnectConfig,
  LiveServerMessage,
  Session,
} from '@google/genai';
// The Node-only entry: the same builder the hook uses, without loading React
// or Firebase.
import {
  END_SESSION_TOOL_NAME,
  LIVE_API_VERSION,
  buildLiveConnectConfig,
} from '@andyfooblah/voice-common/testing';
import { createDispatcher } from '../src/agent/dispatcher';
import {
  buildWeatherbotInstruction,
  captureNow,
  NowContext,
} from '../src/agent/instructionBuilder';
import { weatherbotLiveConnectParams } from '../src/agent/liveConfig';
import { buildDeclarations } from '../src/agent/toolDeclarations';
import { WEATHERBOT_LIVE_MODEL } from '../src/agent/liveModel';
import type { ToolTransport } from '../src/agent/types';

/**
 * Production Live model, re-exported from the agent core so the evals and the
 * SPA cannot drift. Thinking is resolved by VoiceCommon's registry inside
 * the builder; never add a `thinkingConfig` here by hand.
 */
export { WEATHERBOT_LIVE_MODEL };

/**
 * The Live connect config for an eval conversation: exactly what the SPA's
 * `useSession` call produces for the same instruction and tool declarations.
 */
export function buildEvalLiveConnectConfig(
  systemInstruction: string,
  declarations: FunctionDeclaration[],
): LiveConnectConfig {
  return buildLiveConnectConfig(
    weatherbotLiveConnectParams({ systemInstruction, tools: declarations }),
  );
}

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
  /** True when the model called `endSession` (production would have stopped
   * the session there; the driver acknowledges and carries on). */
  endSessionRequested: boolean;
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
  /** Max ms to wait for the server to accept the setup (default 30s). */
  connectTimeoutMs?: number;
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
  let closeInfo = '';
  let fatal: Error | null = null;
  let endSessionRequested = false;

  const flushBotText = () => {
    if (currentBotText.trim()) {
      events.push({ type: 'bot', text: currentBotText.trim() });
    }
    currentBotText = '';
  };

  // Same WebSocket API version as the hook, so the evals talk to the
  // endpoint production talks to.
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: LIVE_API_VERSION },
  });
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
        if (name === END_SESSION_TOOL_NAME) {
          // VoiceCommon's own tool, never dispatched to the app. Answer it
          // as the hook does; unlike the hook, keep the session open.
          endSessionRequested = true;
          events.push({ type: 'tool_result', name, result: 'ok' });
          session.sendToolResponse({
            functionResponses: [{ id: fc.id, name, response: { result: 'ok' } }],
          });
          continue;
        }
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

  // ai.live.connect() resolves only after the server's setupComplete. When
  // the server REJECTS the setup (a thinking level, voice or tool schema it
  // does not accept) it closes the socket instead and that promise never
  // settles, so race it against the close/error callbacks and a timeout.
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  let rejectSetup: (err: Error) => void = () => {};
  const setupFailed = new Promise<never>((_, reject) => {
    rejectSetup = reject;
  });
  const connectTimer = setTimeout(
    () => rejectSetup(new Error(`live setup timed out after ${connectTimeoutMs}ms`)),
    connectTimeoutMs,
  );
  let connected = false;
  const connecting = ai.live.connect({
    model,
    config: buildEvalLiveConnectConfig(systemInstruction, declarations),
    callbacks: {
      onopen: () => log('connected'),
      onmessage,
      onerror: (e: { message?: string }) => {
        fatal = new Error(`live error: ${e.message ?? 'unknown'}`);
        if (!connected) rejectSetup(fatal);
      },
      onclose: (e: { code?: number; reason?: string }) => {
        closed = true;
        closeInfo = `code=${e.code} reason=${e.reason || '(none)'}`;
        log(`closed ${closeInfo}`);
        if (!connected) {
          rejectSetup(new Error(`live setup rejected by the server: ${closeInfo} (model ${model})`));
        }
      },
    },
  });
  // If the setup is refused, `connecting` stays pending or rejects later; if
  // it resolves after this function has given up, close that session.
  let abandoned = false;
  connecting.then(
    (late) => {
      if (abandoned) late.close();
    },
    () => undefined,
  );
  try {
    session = await Promise.race([connecting, setupFailed]);
    connected = true;
  } catch (err) {
    abandoned = true;
    throw err;
  } finally {
    clearTimeout(connectTimer);
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const waitForSettle = async () => {
    const deadline = Date.now() + turnTimeoutMs;
    for (;;) {
      if (fatal) throw fatal;
      if (closed) throw new Error(`live session closed mid-turn (${closeInfo})`);
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

  return { events, answers, toolCalls, endSessionRequested };
}
