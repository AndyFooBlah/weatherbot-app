// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// LIVE: the second Live path, the headless eval driver (evals/driver.ts).
//
// First the kit's checks against the exact connect config the driver builds
// (passed as `profile.connectConfig`), then one real conversation through the
// driver itself, with a stub Toolbox, so its text-turn mechanics, tool loop
// and settle logic are exercised without Toolbox credentials.
//
// Runs only via `npm run test:live` with GEMINI_API_KEY set.

import { expect, it } from 'vitest';
import type { LiveAppProfile } from '@andyfooblah/voice-common/testing';
import { buildEvalLiveConnectConfig, runConversation, WEATHERBOT_LIVE_MODEL } from '../../evals/driver';
import { createStubToolboxTransport, mentionsStubTemperature } from '../support/liveProfile';
import { productionDeclarations, productionInstruction } from '../support/productionInputs';
import { LIVE_API_KEY, describeLive, recordCustom, runCheck } from './liveEnv';

describeLive('live: eval driver path', () => {
  const instruction = productionInstruction();
  const profile: LiveAppProfile = {
    name: 'weatherbot-app',
    model: WEATHERBOT_LIVE_MODEL,
    systemInstruction: instruction,
    // Used as is: the config object the driver hands to ai.live.connect.
    connectConfig: buildEvalLiveConnectConfig(instruction, productionDeclarations()),
  };
  const label = `${profile.name} / eval-driver`;

  it("the driver's connect config is accepted", async () => {
    await runCheck(profile, 'setup', {}, label);
  });

  it("the driver's tool declarations are accepted", async () => {
    await runCheck(profile, 'tool-declarations', {}, label);
  });

  it('a conversation through the driver: text in, tool call, dispatcher, spoken answer transcribed', async () => {
    const startedAt = Date.now();
    const transport = createStubToolboxTransport();
    const result = await runConversation(['What is the current garage temperature?'], {
      transport,
      apiKey: LIVE_API_KEY,
    });
    const answer = result.answers[0] ?? '';
    const calledTool = result.toolCalls.some((c) => c.name === 'latest_observation');
    const ok = calledTool && transport.calls.includes('latest_observation') && mentionsStubTemperature(answer);
    recordCustom(label, 'driver-conversation', startedAt, {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `latest_observation called and answered: "${answer.slice(0, 60)}"`
        : `expected a latest_observation call and the stub reading in the answer; tools: ` +
          `${result.toolCalls.map((c) => c.name).join(', ') || 'none'}; answer: "${answer.slice(0, 80)}"`,
      metrics: { toolCalls: result.toolCalls.map((c) => c.name).join(','), answerChars: answer.length },
    });
    expect(result.toolCalls.map((c) => c.name)).toContain('latest_observation');
    expect(transport.calls).toContain('latest_observation');
    expect(mentionsStubTemperature(answer), `answer: "${answer}"`).toBe(true);
    expect(result.endSessionRequested).toBe(false);
  });
});
