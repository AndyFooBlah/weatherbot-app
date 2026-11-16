// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The shared Live configuration (src/agent/liveModel.ts, liveConfig.ts): the
// model is one the registry vouches for, automatic thinking gives the config
// the hand-set value used to, the real tool declarations are valid for the
// model, and the eval driver sends what production sends.

import { describe, expect, it } from 'vitest';
import { Behavior } from '@google/genai';
import {
  DEFAULT_LIVE_MODEL,
  END_SESSION_TOOL_NAME,
  LIVE_MODELS,
  buildLiveConnectConfig,
  buildProfileConnectConfig,
  getLiveModelInfo,
  resolveThinkingConfig,
} from '@andyfooblah/voice-common/testing';
import { buildEvalLiveConnectConfig, WEATHERBOT_LIVE_MODEL as DRIVER_MODEL } from '../evals/driver';
import {
  WEATHERBOT_LIVE_SESSION_OPTIONS,
  weatherbotLiveConnectParams,
} from '../src/agent/liveConfig';
import { WEATHERBOT_LIVE_MODEL, WEATHERBOT_LIVE_THINKING_LEVEL } from '../src/agent/liveModel';
import {
  CHARTABLE_TOOLS,
  CLIENT_SIDE_TOOL_NAMES,
  buildDeclarations,
} from '../src/agent/toolDeclarations';
import { weatherbotLiveProfile } from './support/liveProfile';
import {
  FIXED_NOW,
  loadToolboxFixture,
  productionDeclarations,
  productionInstruction,
} from './support/productionInputs';

const instruction = productionInstruction(FIXED_NOW);
const declarations = productionDeclarations();

function declaredNames(config: ReturnType<typeof buildLiveConnectConfig>): string[] {
  return (config.tools ?? []).flatMap((tool) =>
    'functionDeclarations' in tool
      ? (tool.functionDeclarations ?? []).map((d) => d.name ?? '')
      : [],
  );
}

describe('the Live model constant', () => {
  it('is a model the VoiceCommon registry lists as current', () => {
    const info = getLiveModelInfo(WEATHERBOT_LIVE_MODEL);
    expect(
      info,
      `'${WEATHERBOT_LIVE_MODEL}' is not in VoiceCommon's Live model registry. ` +
        'Add and verify it there first (its live suite measures the thinking and tool contract), then bump the dependency.',
    ).toBeDefined();
    expect(
      info?.status,
      `'${WEATHERBOT_LIVE_MODEL}' is marked ${info?.status} by the registry` +
        (info?.replacement ? `; the provider names '${info.replacement}' as its replacement` : '') +
        '. See TESTING.md, "Changing the Live model".',
    ).toBe('current');
  });

  it("is the model VoiceCommon defaults to (fails when VoiceCommon moves to a newer one)", () => {
    expect(
      WEATHERBOT_LIVE_MODEL,
      `VoiceCommon now defaults to '${DEFAULT_LIVE_MODEL}'. Decide deliberately whether weatherbot follows: ` +
        'change src/agent/liveModel.ts, then run `npm run test:live` and `npm run eval:corpus` before shipping ' +
        '(TESTING.md, "Changing the Live model"). Do not edit this test to make it pass.',
    ).toBe(DEFAULT_LIVE_MODEL);
  });

  it('is the model every path uses', () => {
    expect(WEATHERBOT_LIVE_SESSION_OPTIONS.liveModel).toBe(WEATHERBOT_LIVE_MODEL);
    expect(DRIVER_MODEL).toBe(WEATHERBOT_LIVE_MODEL);
    expect(weatherbotLiveConnectParams({ systemInstruction: 'x', tools: [] }).model).toBe(
      WEATHERBOT_LIVE_MODEL,
    );
  });
});

describe('thinking', () => {
  it("resolves through 'auto'", () => {
    expect(WEATHERBOT_LIVE_THINKING_LEVEL).toBe('auto');
    expect(WEATHERBOT_LIVE_SESSION_OPTIONS.thinkingLevel).toBe('auto');
  });

  it("'auto' gives the same connect config as the hand-set 'none' it replaced", () => {
    const params = weatherbotLiveConnectParams({ systemInstruction: instruction, tools: declarations });
    const auto = buildLiveConnectConfig(params);
    const none = buildLiveConnectConfig({ ...params, thinkingLevel: 'none' });
    expect(auto).toEqual(none);
    expect(auto).not.toHaveProperty('thinkingConfig');
    expect(resolveThinkingConfig(WEATHERBOT_LIVE_MODEL, 'auto')).toBeUndefined();
  });

  it('an explicit level the model rejects fails before connecting, not as a closed socket', () => {
    const info = getLiveModelInfo(WEATHERBOT_LIVE_MODEL);
    // Only meaningful while the model rejects thinkingConfig (true today).
    if (info?.thinking.support !== 'rejected') return;
    const params = weatherbotLiveConnectParams({ systemInstruction: instruction, tools: declarations });
    expect(() => buildLiveConnectConfig({ ...params, thinkingLevel: 'MINIMAL' as never })).toThrow(
      /thinking/i,
    );
  });
});

describe('tool declarations built from the committed Toolbox tool list', () => {
  const fixture = loadToolboxFixture();

  it('the fixture holds the Toolbox tools, sorted, with names and schemas only', () => {
    expect(fixture.length).toBeGreaterThanOrEqual(9);
    expect(fixture.map((t) => t.name)).toEqual([...fixture.map((t) => t.name)].sort());
    for (const tool of fixture) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name']);
      expect(tool.inputSchema?.type).toBe('object');
    }
    // The tools the prompt and the eval corpus rely on.
    expect(fixture.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'ask_data',
        'latest_observation',
        'list_events',
        'list_sensors',
        'observations_in_range',
        'record_event',
        'summarize_period',
      ]),
    );
  });

  it('declares every Toolbox tool plus the two client-side time tools', () => {
    const { declarations: built, toolNames } = buildDeclarations(fixture);
    expect(built.map((d) => d.name)).toEqual([...fixture.map((t) => t.name), ...CLIENT_SIDE_TOOL_NAMES]);
    expect(toolNames).toEqual(built.map((d) => d.name));
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it('uses names and schemas the Live API accepts in shape', () => {
    for (const d of declarations) {
      // Gemini function names: a letter or underscore, then up to 63 of [A-Za-z0-9_.-].
      expect(d.name).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
      expect(d.description?.length ?? 0).toBeGreaterThan(0);
      expect(d.parameters?.type).toBe('OBJECT');
      const properties = Object.keys(d.parameters?.properties ?? {});
      for (const required of d.parameters?.required ?? []) {
        expect(properties, `${d.name}: required '${required}' is not a declared property`).toContain(required);
      }
    }
  });

  it('adds show_chart to the chartable tools only, and it is never required', () => {
    for (const d of declarations) {
      const properties = d.parameters?.properties ?? {};
      expect('show_chart' in properties, d.name).toBe(CHARTABLE_TOOLS.has(d.name ?? ''));
      expect(d.parameters?.required ?? []).not.toContain('show_chart');
    }
    // Every chartable tool exists in the Toolbox.
    for (const name of CHARTABLE_TOOLS) expect(fixture.map((t) => t.name)).toContain(name);
  });

  it('marks Toolbox tools NON_BLOCKING and leaves the client-side time tools blocking', () => {
    const clientSide = new Set<string>(CLIENT_SIDE_TOOL_NAMES);
    for (const d of declarations) {
      if (clientSide.has(d.name ?? '')) expect(d.behavior, d.name).toBeUndefined();
      else expect(d.behavior, d.name).toBe(Behavior.NON_BLOCKING);
    }
  });

  it('is accepted by the connect-config builder for the production model, with endSession appended once', () => {
    const config = buildLiveConnectConfig(
      weatherbotLiveConnectParams({ systemInstruction: instruction, tools: declarations }),
    );
    const names = declaredNames(config);
    expect(names).toEqual([...declarations.map((d) => d.name), END_SESSION_TOOL_NAME]);
    expect(names.filter((n) => n === END_SESSION_TOOL_NAME)).toHaveLength(1);
    // No Toolbox or client-side tool may shadow VoiceCommon's own tool.
    expect(declarations.map((d) => d.name)).not.toContain(END_SESSION_TOOL_NAME);
  });

  it('builds for every current Live model in the registry', () => {
    // A model that only runs tools asynchronously rejects a `behavior: BLOCKING`
    // declaration at setup. This app never sets BLOCKING explicitly, so its
    // declarations must build for every current model: a swap to another
    // current model must not be blocked by a tool schema.
    for (const info of Object.values(LIVE_MODELS).filter((m) => m.status === 'current')) {
      expect(
        () => buildLiveConnectConfig({ model: info.id, systemInstruction: instruction, tools: declarations }),
        info.id,
      ).not.toThrow();
    }
  });
});

describe('the eval driver (evals/driver.ts), the second Live path', () => {
  it('sends exactly the production connect config for the same instruction and tools', () => {
    const production = buildLiveConnectConfig({
      // What useSession passes to the builder for the hook's options
      // (see src/hooks/useWeatherbotSession.test.ts).
      model: WEATHERBOT_LIVE_SESSION_OPTIONS.liveModel,
      thinkingLevel: WEATHERBOT_LIVE_SESSION_OPTIONS.thinkingLevel,
      speechConfig: WEATHERBOT_LIVE_SESSION_OPTIONS.speechConfig,
      systemInstruction: instruction,
      tools: declarations,
      manualTurnControl: undefined,
      endOfSpeechSilenceMs: undefined,
      endOfSpeechSensitivity: undefined,
      resumptionHandle: null,
    });
    expect(buildEvalLiveConnectConfig(instruction, declarations)).toEqual(production);
  });

  it('therefore carries everything the old hand-built driver config left out', () => {
    const config = buildEvalLiveConnectConfig(instruction, declarations);
    expect(config.realtimeInputConfig?.automaticActivityDetection?.disabled).toBeUndefined();
    expect(config.realtimeInputConfig?.automaticActivityDetection).toHaveProperty('startOfSpeechSensitivity');
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.speechConfig).toEqual(WEATHERBOT_LIVE_SESSION_OPTIONS.speechConfig);
    expect(config.sessionResumption).toEqual({});
    expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(declaredNames(config)).toContain(END_SESSION_TOOL_NAME);
  });
});

describe('the live conformance profile (tests/support/liveProfile.ts)', () => {
  it('resolves to the production model and connect config, so the live suite tests what ships', () => {
    const { model, config } = buildProfileConnectConfig(weatherbotLiveProfile(FIXED_NOW));
    expect(model).toBe(WEATHERBOT_LIVE_MODEL);
    expect(config).toEqual(
      buildLiveConnectConfig(
        weatherbotLiveConnectParams({ systemInstruction: instruction, tools: declarations }),
      ),
    );
  });

  it('leaves turn-taking unset: server VAD with default settings', () => {
    const profile = weatherbotLiveProfile(FIXED_NOW);
    expect(profile).not.toHaveProperty('manualTurnControl');
    expect(profile).not.toHaveProperty('endOfSpeechSilenceMs');
    expect(profile).not.toHaveProperty('endOfSpeechSensitivity');
    expect(profile).not.toHaveProperty('connectConfig');
  });
});
