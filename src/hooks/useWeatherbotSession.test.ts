// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// What the SPA's session hook hands to VoiceCommon, and the Live connect
// config that results.
//
// VoiceCommon is NOT mocked wholesale: only `useSession` is replaced, with a
// recorder, so the hook can run without a browser. The assertions are made on
// the output of the real `buildLiveConnectConfig`, fed the way `useSession`
// feeds it, from the options and the startSession arguments the hook really
// passed. VoiceCommon's own tests prove `useSession` sends exactly the
// builder's output to `ai.live.connect`.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EndSensitivity, Modality, StartSensitivity } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import {
  END_SESSION_TOOL_NAME,
  buildLiveConnectConfig,
  resolveLiveModel,
} from '@andyfooblah/voice-common';
import type { UseSessionOptions } from '@andyfooblah/voice-common';
import { AUTO_GREET_TEXT } from '../agent/instructionBuilder';
import {
  WEATHERBOT_LIVE_SESSION_OPTIONS,
  WEATHERBOT_VOICE_NAME,
  weatherbotLiveConnectParams,
} from '../agent/liveConfig';
import { WEATHERBOT_LIVE_MODEL } from '../agent/liveModel';
import { buildDeclarations } from '../agent/toolDeclarations';
import type { McpTool } from '../agent/types';
import toolboxTools from '../../evals/fixtures/toolbox-tools.json';

const recorded = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  startSession: undefined as unknown,
}));

vi.mock('@andyfooblah/voice-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@andyfooblah/voice-common')>();
  return {
    ...actual,
    // The one replaced export: record the options, return a stand-in session.
    useSession: (options: Record<string, unknown>) => {
      recorded.options = options;
      return { startSession: recorded.startSession, stopSession: async () => {} };
    },
  };
});

// The SPA's tool plumbing talks to Firebase; give the hook the declarations
// the agent core builds from the committed Toolbox tool list instead.
const fixtureTools = toolboxTools as unknown as McpTool[];
const fixtureDeclarations = buildDeclarations(fixtureTools).declarations;
vi.mock('../services/toolboxToolsClient', () => ({
  fetchWeatherbotTools: async () => fixtureDeclarations,
}));
vi.mock('../services/weatherbotTools', () => ({
  dispatchWeatherbotTool: async () => 'stub',
}));

import { useWeatherbotSession } from './useWeatherbotSession';
import type { UseWeatherbotSessionReturn } from './useWeatherbotSession';

/** Run the hook once (server render: no DOM needed) and return what it gave back. */
function runHook(): { options: UseSessionOptions; session: UseWeatherbotSessionReturn } {
  let session: UseWeatherbotSessionReturn | undefined;
  function Probe() {
    session = useWeatherbotSession({ userId: 'test-user' });
    return null;
  }
  renderToString(createElement(Probe));
  if (!session || !recorded.options) throw new Error('the hook did not call useSession');
  return { options: recorded.options as unknown as UseSessionOptions, session };
}

/** The config `useSession` builds on connect, from its options and startSession arguments. */
function configAsUseSessionBuildsIt(
  options: UseSessionOptions,
  instruction: string,
  tools: FunctionDeclaration[],
) {
  return buildLiveConnectConfig({
    model: resolveLiveModel(options.liveModel),
    systemInstruction: instruction,
    tools,
    thinkingLevel: options.thinkingLevel ?? 'auto',
    speechConfig: options.speechConfig,
    manualTurnControl: options.manualTurnControl,
    endOfSpeechSilenceMs: options.endOfSpeechSilenceMs,
    endOfSpeechSensitivity: options.endOfSpeechSensitivity,
    resumptionHandle: null,
  });
}

describe('useWeatherbotSession → VoiceCommon useSession', () => {
  const baseStartSession = vi.fn(async (..._args: unknown[]) => {});

  beforeEach(() => {
    baseStartSession.mockClear();
    recorded.options = undefined;
    recorded.startSession = baseStartSession;
  });

  it('passes the one model constant, automatic thinking and the pinned voice', () => {
    const { options } = runHook();
    expect(options.liveModel).toBe(WEATHERBOT_LIVE_MODEL);
    expect(options.thinkingLevel).toBe('auto');
    expect(options.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: WEATHERBOT_VOICE_NAME } },
    });
    expect(WEATHERBOT_VOICE_NAME).toBe('Aoede');
    expect(options.autoGreetText).toBe(AUTO_GREET_TEXT);
    // The hook's Live options are the shared object, not a second copy.
    expect(options).toMatchObject(WEATHERBOT_LIVE_SESSION_OPTIONS);
  });

  it('leaves turn-taking at the server-VAD defaults (the owner rejected manual VAD for this app)', () => {
    const { options } = runHook();
    expect(options).not.toHaveProperty('manualTurnControl');
    expect(options).not.toHaveProperty('endOfSpeechSilenceMs');
    expect(options).not.toHaveProperty('endOfSpeechSensitivity');
    // And it does not move the Live API version off VoiceCommon's pin.
    expect(options).not.toHaveProperty('liveApiVersion');
  });

  it('starts each session with a fresh instruction and the fetched tool declarations', async () => {
    const { session } = runHook();
    await session.startSession();
    expect(baseStartSession).toHaveBeenCalledTimes(1);
    const [instruction, greeting, tools] = baseStartSession.mock.calls[0];
    expect(typeof instruction).toBe('string');
    expect(instruction).toContain('You are weatherbot');
    expect(instruction).toContain('TWO TIME LAWS');
    expect(instruction).toContain("You're talking to him over voice"); // voice modality
    expect(greeting).toBeUndefined(); // falls back to options.autoGreetText
    expect(tools).toBe(fixtureDeclarations);
  });

  it('results in the expected Live connect config, identical to the shared builder route', async () => {
    const { options, session } = runHook();
    await session.startSession();
    const [instruction, , tools] = baseStartSession.mock.calls[0] as [
      string,
      undefined,
      FunctionDeclaration[],
    ];

    const config = configAsUseSessionBuildsIt(options, instruction, tools);

    // The route the eval driver and the live suite take gives the same object.
    expect(config).toEqual(
      buildLiveConnectConfig(weatherbotLiveConnectParams({ systemInstruction: instruction, tools })),
    );

    // And it is the config this app is meant to send.
    expect(config.systemInstruction).toEqual({ parts: [{ text: instruction }] });
    expect(config.responseModalities).toEqual([Modality.AUDIO]);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    // The current model rejects any thinkingConfig (close 1007 at setup).
    expect(config).not.toHaveProperty('thinkingConfig');
    expect(config.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
    });
    // Server VAD on, VoiceCommon's default sensitivities, server-default silence.
    expect(config.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
      },
    });
    expect(config.sessionResumption).toEqual({});
    expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
    // Nine Toolbox tools, two client-side time tools, VoiceCommon's endSession.
    const names = config.tools?.flatMap((t) =>
      'functionDeclarations' in t ? (t.functionDeclarations ?? []).map((d) => d.name) : [],
    );
    expect(names).toEqual([
      ...fixtureTools.map((t) => t.name),
      'resolve_time',
      'describe_time',
      END_SESSION_TOOL_NAME,
    ]);
  });
});
