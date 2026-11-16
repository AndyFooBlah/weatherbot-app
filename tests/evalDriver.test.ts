// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The headless eval driver (evals/driver.ts) against a scripted fake of the
// Gemini SDK: what it connects with, and each way it deliberately differs
// from a production session (see the header of evals/driver.ts). No network.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveServerMessage } from '@google/genai';
import {
  END_SESSION_TOOL_NAME,
  LIVE_API_VERSION,
  buildLiveConnectConfig,
} from '@andyfooblah/voice-common/testing';
import { weatherbotLiveConnectParams } from '../src/agent/liveConfig';
import { WEATHERBOT_LIVE_MODEL } from '../src/agent/liveModel';
import type { CallToolResult, ToolTransport } from '../src/agent/types';
import {
  FIXED_NOW,
  loadToolboxFixture,
  productionDeclarations,
  productionInstruction,
} from './support/productionInputs';

interface ConnectParams {
  model: string;
  config: unknown;
  callbacks: {
    onopen?: () => void;
    onmessage: (msg: LiveServerMessage) => void;
    onerror?: (e: { message?: string }) => void;
    onclose?: (e: { code?: number; reason?: string }) => void;
  };
}

interface FakeSession {
  sendClientContent: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  connects: [] as unknown[],
  connect: undefined as undefined | ((params: unknown) => Promise<unknown>),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    live = {
      connect: (params: unknown) => {
        sdk.connects.push(params);
        return sdk.connect!(params);
      },
    };
    constructor(options: unknown) {
      sdk.clientOptions.push(options);
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

import { runConversation } from '../evals/driver';

const say = (text: string): LiveServerMessage =>
  ({ serverContent: { outputTranscription: { text } } }) as LiveServerMessage;
const turnComplete = (): LiveServerMessage =>
  ({ serverContent: { turnComplete: true } }) as LiveServerMessage;
const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): LiveServerMessage =>
  ({ toolCall: { functionCalls: [{ id, name, args }] } }) as LiveServerMessage;

/** A transport that serves the committed tool list and canned results. */
function stubTransport(results: Record<string, string> = {}) {
  const callTool = vi.fn(async (name: string): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: results[name] ?? '[]' }],
  }));
  const transport: ToolTransport = { listTools: async () => loadToolboxFixture(), callTool };
  return { transport, callTool };
}

/**
 * A fake Live session. `onUserTurn` is called for each text turn the driver
 * sends and `onToolResponse` for each tool response, with an `emit` that
 * delivers server messages to the driver.
 */
function scriptSession(script: {
  onUserTurn: (text: string, emit: (msg: LiveServerMessage) => void) => void;
  onToolResponse?: (response: unknown, emit: (msg: LiveServerMessage) => void) => void;
}): FakeSession {
  let emit: (msg: LiveServerMessage) => void = () => {};
  const session: FakeSession = {
    sendClientContent: vi.fn((content: { turns: Array<{ parts: Array<{ text: string }> }> }) => {
      const text = content.turns[0].parts[0].text;
      setTimeout(() => script.onUserTurn(text, emit), 0);
    }),
    sendToolResponse: vi.fn((response: unknown) => {
      setTimeout(() => script.onToolResponse?.(response, emit), 0);
    }),
    sendRealtimeInput: vi.fn(),
    close: vi.fn(),
  };
  sdk.connect = async (params) => {
    const { callbacks } = params as ConnectParams;
    emit = (msg) => void callbacks.onmessage(msg);
    callbacks.onopen?.();
    return session;
  };
  return session;
}

const FAST = { apiKey: 'test-key', now: FIXED_NOW, settleMs: 20, turnTimeoutMs: 5_000 };

describe('eval driver', () => {
  beforeEach(() => {
    sdk.clientOptions.length = 0;
    sdk.connects.length = 0;
    sdk.connect = undefined;
  });

  it('connects with the one model constant, the production connect config and the hook API version', async () => {
    scriptSession({
      onUserTurn: (_text, emit) => {
        emit(say('Hello.'));
        emit(turnComplete());
      },
    });
    const { transport } = stubTransport();
    await runConversation(['Hi'], { ...FAST, transport });

    expect(sdk.clientOptions).toEqual([
      { apiKey: 'test-key', httpOptions: { apiVersion: LIVE_API_VERSION } },
    ]);
    expect(sdk.connects).toHaveLength(1);
    const params = sdk.connects[0] as ConnectParams;
    expect(params.model).toBe(WEATHERBOT_LIVE_MODEL);
    expect(params.config).toEqual(
      buildLiveConnectConfig(
        weatherbotLiveConnectParams({
          systemInstruction: productionInstruction(FIXED_NOW),
          tools: productionDeclarations(),
        }),
      ),
    );
  });

  it('difference 1 and 2: sends each scripted turn as text with sendClientContent, and no greeting cue', async () => {
    const session = scriptSession({
      onUserTurn: (text, emit) => {
        emit(say(`You said: ${text}`));
        emit(turnComplete());
      },
    });
    const { transport } = stubTransport();
    const result = await runConversation(['First question', 'Second question'], { ...FAST, transport });

    expect(session.sendClientContent.mock.calls.map((c) => c[0])).toEqual([
      { turns: [{ role: 'user', parts: [{ text: 'First question' }] }], turnComplete: true },
      { turns: [{ role: 'user', parts: [{ text: 'Second question' }] }], turnComplete: true },
    ]);
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
    expect(result.answers).toEqual(['You said: First question', 'You said: Second question']);
    expect(result.endSessionRequested).toBe(false);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('runs tool calls through the production dispatcher and waits for the reply that follows the tool result', async () => {
    const session = scriptSession({
      onUserTurn: (_text, emit) => {
        // Asynchronous function calling: the calling turn completes at once.
        emit(toolCall('call_1', 'latest_observation', { location: 'Garage', show_chart: false }));
        emit(turnComplete());
      },
      onToolResponse: (_response, emit) => {
        emit(say("It's seventy-one degrees in the garage."));
        emit(turnComplete());
      },
    });
    const { transport, callTool } = stubTransport({ latest_observation: '[{"value":71.3}]' });
    const result = await runConversation(['What is the garage temperature?'], { ...FAST, transport });

    // The dispatcher strips the UI-only show_chart argument before the Toolbox sees it.
    expect(callTool).toHaveBeenCalledWith('latest_observation', { location: 'Garage' });
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        { id: 'call_1', name: 'latest_observation', response: { result: '[{"value":71.3}]' } },
      ],
    });
    expect(result.toolCalls).toEqual([
      { name: 'latest_observation', args: { location: 'Garage', show_chart: false } },
    ]);
    expect(result.answers).toEqual(["It's seventy-one degrees in the garage."]);
  });

  it('difference 4: acknowledges endSession like the hook, records it, and keeps the conversation going', async () => {
    const session = scriptSession({
      onUserTurn: (text, emit) => {
        if (text === 'Goodbye') {
          emit(say('Bye!'));
          emit(toolCall('call_end', END_SESSION_TOOL_NAME));
          emit(turnComplete());
        } else {
          emit(say('Still here.'));
          emit(turnComplete());
        }
      },
    });
    const { transport, callTool } = stubTransport();
    const result = await runConversation(['Goodbye', 'One more thing'], { ...FAST, transport });

    // Never forwarded to the Toolbox: it is VoiceCommon's own tool.
    expect(callTool).not.toHaveBeenCalled();
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: 'call_end', name: END_SESSION_TOOL_NAME, response: { result: 'ok' } }],
    });
    expect(result.endSessionRequested).toBe(true);
    expect(result.toolCalls.map((c) => c.name)).toEqual([END_SESSION_TOOL_NAME]);
    expect(result.answers).toEqual(['Bye!', 'Still here.']);
  });

  it('fails fast with the close code and reason when the server rejects the setup', async () => {
    // The SDK's connect() never settles on a rejected setup; the server just closes.
    sdk.connect = (params) => {
      const { callbacks } = params as ConnectParams;
      setTimeout(
        () => callbacks.onclose?.({ code: 1007, reason: 'Thinking level is not supported for this model.' }),
        0,
      );
      return new Promise(() => {});
    };
    const { transport } = stubTransport();
    const started = Date.now();
    await expect(runConversation(['Hi'], { ...FAST, transport })).rejects.toThrow(
      /setup rejected by the server: code=1007 reason=Thinking level is not supported/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up when the server neither accepts nor rejects the setup, and closes a session that arrives late', async () => {
    const late = { close: vi.fn() };
    let resolveLate: (session: unknown) => void = () => {};
    sdk.connect = () => new Promise((resolve) => (resolveLate = resolve));
    const { transport } = stubTransport();
    await expect(
      runConversation(['Hi'], { ...FAST, transport, connectTimeoutMs: 50 }),
    ).rejects.toThrow(/live setup timed out after 50ms/);
    resolveLate(late);
    await new Promise((r) => setTimeout(r, 0));
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it('difference 3: needs a long-lived key from the environment or the options', async () => {
    const { transport } = stubTransport();
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(runConversation(['Hi'], { transport })).rejects.toThrow(/GEMINI_API_KEY is required/);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
    expect(sdk.connects).toHaveLength(0);
  });
});
