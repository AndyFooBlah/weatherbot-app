// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The weatherbot production profile for VoiceCommon's live conformance kit,
// and a stub Toolbox for tool tests. Built only from the app's own modules:
// the model constant, the voice, the instruction builder, the declaration
// builder and the dispatcher.

import type { LiveAppProfile } from '@andyfooblah/voice-common/testing';
import { createDispatcher } from '../../src/agent/dispatcher';
import type { NowContext } from '../../src/agent/instructionBuilder';
import { WEATHERBOT_LIVE_SESSION_OPTIONS } from '../../src/agent/liveConfig';
import { buildDeclarations } from '../../src/agent/toolDeclarations';
import type { CallToolResult, ToolTransport } from '../../src/agent/types';
import {
  loadToolboxFixture,
  productionDeclarations,
  productionInstruction,
} from './productionInputs';

/**
 * What production sends, described the way `useSession` is configured: the
 * kit turns this into a connect config with the same `buildLiveConnectConfig`
 * the hook calls. Turn-taking fields are absent on purpose (server-VAD
 * defaults, the production setting). tests/liveConfig.test.ts proves this
 * profile yields the production config.
 */
export function weatherbotLiveProfile(now?: NowContext): LiveAppProfile {
  return {
    name: 'weatherbot-app',
    model: WEATHERBOT_LIVE_SESSION_OPTIONS.liveModel,
    thinkingLevel: WEATHERBOT_LIVE_SESSION_OPTIONS.thinkingLevel,
    speechConfig: WEATHERBOT_LIVE_SESSION_OPTIONS.speechConfig,
    systemInstruction: productionInstruction(now),
    tools: productionDeclarations(),
  };
}

/** Synthetic reading used by the tool tests. Not real station data. */
export const STUB_GARAGE_TEMPERATURE_F = 71;

/**
 * A Toolbox stand-in: serves the committed tool list and answers
 * `latest_observation` with one synthetic garage reading, in the row shape
 * the real tool returns. Every other tool answers with an empty result.
 */
export function createStubToolboxTransport(): ToolTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTools: async () => loadToolboxFixture(),
    callTool: async (name: string): Promise<CallToolResult> => {
      calls.push(name);
      if (name !== 'latest_observation') return { content: [{ type: 'text', text: '[]' }] };
      const row = {
        display_name: 'Garage Temperature',
        physical_location: 'Garage',
        measurement_type: 'temperature',
        unit: '°F',
        value: STUB_GARAGE_TEMPERATURE_F,
        observed_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        sensor_id: 'AA:BB:CC:DD:EE:FF:temp2f',
        station_id: 'AA:BB:CC:DD:EE:FF',
        reliable: true,
        notes: null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    },
  };
}

/** The app's real dispatcher, bound to the stub Toolbox. */
export function createStubDispatcher() {
  const transport = createStubToolboxTransport();
  const { toolNames } = buildDeclarations(loadToolboxFixture());
  return createDispatcher(transport, { getKnownToolNames: () => toolNames });
}

/** True when a spoken or transcribed reply states the stub reading. */
export function mentionsStubTemperature(reply: string): boolean {
  return /\b71\b|seventy[\s-]?one/i.test(reply);
}
