// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Thin wrapper around VoiceCommon's useSession that wires up the weatherbot
// system instruction, FunctionDeclarations, dispatcher, pinned voice, and
// the endSession plumbing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@andyfooblah/voice-common';
import type { UseSessionReturn } from '@andyfooblah/voice-common';
import { dispatchWeatherbotTool } from '../services/weatherbotTools';
import { fetchWeatherbotTools } from '../services/toolboxToolsClient';
import {
  AUTO_GREET_TEXT,
  WEATHERBOT_SYSTEM_INSTRUCTION_PLACEHOLDER,
  buildWeatherbotInstruction,
} from '../services/instructionBuilder';

/**
 * Pinned Gemini Live prebuilt voice. Aoede = warm, friendly, mid-pitch — fits
 * weatherbot's "calm helpful assistant" persona. Eventually expose as a user
 * preference; for now hardcoded so the bot sounds the same every session.
 */
const VOICE_NAME = 'Aoede';

export interface UseWeatherbotSessionOptions {
  userId: string;
  onBotSpeaking?: (speaking: boolean) => void;
  onSessionEnd?: () => void;
}

/**
 * Extends VoiceCommon's UseSessionReturn with an "in-flight" flag the UI
 * uses to render a waiting indicator while a tool dispatch is pending.
 *
 * The previous version also surfaced `toolResults: string[]` because
 * VoiceCommon's in-memory Message used to drop the result string. Fixed
 * upstream in VoiceCommon@5be6606 (#9): Message now carries the result
 * directly via `m.toolResult`, so the local capture wrapper is no longer
 * needed and the UI reads `m.toolResult` directly.
 */
export interface UseWeatherbotSessionReturn extends UseSessionReturn {
  /** True when at least one tool dispatch is awaiting a response. */
  isWaitingForTool: boolean;
}

export function useWeatherbotSession(
  options: UseWeatherbotSessionOptions,
): UseWeatherbotSessionReturn {
  // When the model decides the conversation is over and calls the built-in
  // `endSession` tool, VoiceCommon fires `onSessionEndRequest`. We need to
  // actually call stopSession here — otherwise the session document stays
  // 'active' forever and the audio archive never finalizes. The ref breaks
  // the circular dependency (stopSession is created by the same useSession
  // call that consumes the callback).
  const stopSessionRef = useRef<(() => Promise<void>) | null>(null);

  // Count of tool dispatches currently awaiting a response. Counter (not bool)
  // so chained or parallel calls keep the indicator on across the whole run.
  const [pendingToolCount, setPendingToolCount] = useState(0);

  // Wrap the dispatcher so we can drive the typing indicator. The result
  // itself flows through VoiceCommon back into `m.toolResult` (since
  // VoiceCommon@5be6606) — we don't need to capture it ourselves.
  const trackingDispatch = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<string> => {
      setPendingToolCount((c) => c + 1);
      try {
        return await dispatchWeatherbotTool(name, args);
      } finally {
        setPendingToolCount((c) => c - 1);
      }
    },
    [],
  );

  const session = useSession({
    userId: options.userId,
    // Real instruction AND the tool list are computed fresh on each
    // startSession via the override parameter — instruction keeps the
    // time anchor current, tools are fetched live from the toolbox so
    // the SPA can't drift out of sync with toolbox.yaml. The empty
    // array here is a load-time placeholder.
    systemInstruction: WEATHERBOT_SYSTEM_INSTRUCTION_PLACEHOLDER,
    tools: [],
    autoGreetText: AUTO_GREET_TEXT,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
    },
    onBotSpeaking: options.onBotSpeaking,
    onSessionEnd: options.onSessionEnd,
    onSessionEndRequest: async () => {
      try {
        await stopSessionRef.current?.();
      } catch (err) {
        console.error(
          '[useWeatherbotSession] stopSession failed during onSessionEndRequest',
          err,
        );
      }
    },
    onToolCall: trackingDispatch,
  });

  useEffect(() => {
    stopSessionRef.current = session.stopSession;
  }, [session.stopSession]);

  // Override startSession so the session opens with (a) a fresh
  // buildWeatherbotInstruction() containing current local time + tz, and
  // (b) a fresh tool list pulled live from the toolbox via the listTools
  // Cloud Function. The pending counter is also reset so a leftover from
  // a previous session doesn't keep the typing indicator on.
  //
  // We fetch tools BEFORE calling session.startSession (rather than during)
  // so the model is configured with the right tools from message #1 — no
  // race where Gemini sees an empty tool list briefly and refuses to call
  // anything. ~500ms added to the connection latency; acceptable.
  const { startSession: baseStartSession } = session;
  const startSession = useCallback(async () => {
    setPendingToolCount(0);
    const tools = await fetchWeatherbotTools();
    await baseStartSession(
      buildWeatherbotInstruction(),
      undefined, // autoGreetText: use the default
      tools,
    );
  }, [baseStartSession]);

  return {
    ...session,
    startSession,
    isWaitingForTool: pendingToolCount > 0,
  };
}
