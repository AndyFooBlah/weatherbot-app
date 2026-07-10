// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// callTool — proxy a single MCP `tools/call` to the weatherbot-toolbox
// Cloud Run service (in the weatherbot backend project) on behalf of a
// signed-in user.
//
// Auth: Firebase Auth ID token verified by onCall + service-to-service
// OIDC token minted from the function's runtime SA, audience = the
// toolbox URL. The runtime SA must have roles/run.invoker on the
// toolbox service in the backend project (cross-project IAM grant — see
// the Phase 3 setup notes in README.md).

import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { requireAllowed } from './auth';
import { postMcp } from './toolboxClient';

// Previously: a hardcoded ALLOWED_TOOLS whitelist. Removed once the SPA
// began sourcing the canonical tool list directly from the toolbox via
// `listTools`. The toolbox itself is now the authoritative security
// boundary: any tool it exposes is one the SPA is permitted to invoke.
// Maintaining the whitelist here in parallel just guaranteed drift bugs
// (a fresh tool added to toolbox.yaml would be unreachable until someone
// updated this file separately). Tool names are still validated to be
// strings, and the toolbox's own Cloud Run IAM still gates who can
// invoke its tools/call endpoint at all.

export interface CallToolRequest {
  /** MCP tool name — any tool the toolbox exposes (see note above). */
  name: string;
  /** Tool-specific arguments. Forwarded verbatim. */
  arguments: Record<string, unknown>;
}

export async function callToolHandler(
  request: CallableRequest<CallToolRequest>,
): Promise<unknown> {
  const { uid } = await requireAllowed(request);

  const { name, arguments: args } = request.data || ({} as CallToolRequest);
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpsError('invalid-argument', 'tool name is required');
  }
  if (args && typeof args !== 'object') {
    throw new HttpsError('invalid-argument', 'arguments must be an object');
  }

  return postMcp<unknown>('callTool', {
    id: `${uid}-${Date.now()}`,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  });
}
