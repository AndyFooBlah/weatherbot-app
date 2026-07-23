// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// SPA tool dispatch: the onToolCall callback Gemini Live invokes when the
// model wants to run a tool. All dispatch behavior (client-side nl2time
// tools, UI-arg stripping, chart row capping, result-size capping,
// invalid-tool-name self-correction) lives in the agent core
// (src/agent/dispatcher.ts) so the eval harness runs the identical code
// path; this module just binds it to the Firebase transport and the
// SPA's tool-name cache.

import { createDispatcher } from '../agent/dispatcher';
import { firebaseTransport } from './firebaseTransport';
import { getLastFetchedToolNames } from './toolboxToolsClient';

export const dispatchWeatherbotTool = createDispatcher(firebaseTransport, {
  getKnownToolNames: getLastFetchedToolNames,
});
