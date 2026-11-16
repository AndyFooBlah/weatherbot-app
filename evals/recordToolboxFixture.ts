// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Refreshes evals/fixtures/toolbox-tools.json: the MCP `tools/list` answer of
// the weatherbot Toolbox, reduced to what the agent core reads (name,
// description, inputSchema). Tool names and schemas only; no weather data.
//
// The offline tests build the production tool declarations from this file,
// and the live suite sends them to the Live API, so it must match what the
// deployed Toolbox serves. `npm run test:live` with TOOLBOX_URL set fails when
// it does not. Refresh after any change to the Toolbox's tools:
//
//   TOOLBOX_URL=https://weatherbot-toolbox-....run.app \
//     npx tsx evals/recordToolboxFixture.ts
//
// Needs an identity that may invoke the private Toolbox (see
// evals/toolboxTransport.ts). Review the diff before committing: the
// repository is public.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpTool } from '../src/agent/types';
import { createToolboxTransport } from './toolboxTransport';

const here = dirname(fileURLToPath(import.meta.url));
export const TOOLBOX_FIXTURE_PATH = join(here, 'fixtures', 'toolbox-tools.json');

/**
 * Keep only the fields the agent core reads, in a stable key order, sorted by
 * tool name: the Toolbox lists its tools in a different order on every call.
 */
export function normalizeMcpTools(tools: McpTool[]): McpTool[] {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema
      ? {
          inputSchema: {
            ...(tool.inputSchema.type !== undefined ? { type: tool.inputSchema.type } : {}),
            properties: Object.fromEntries(
              Object.entries(tool.inputSchema.properties ?? {}).map(([key, value]) => [
                key,
                {
                  ...(value?.type !== undefined ? { type: value.type } : {}),
                  ...(value?.description !== undefined ? { description: value.description } : {}),
                },
              ]),
            ),
            required: [...(tool.inputSchema.required ?? [])],
          },
        }
      : {}),
  }));
}

// Only record when executed directly, not when imported by a test.
if (process.argv[1]?.endsWith('recordToolboxFixture.ts')) {
  const url = process.env.TOOLBOX_URL;
  if (!url) throw new Error('TOOLBOX_URL is required');
  const tools = normalizeMcpTools(await createToolboxTransport(url).listTools());
  if (tools.length === 0) throw new Error('the Toolbox returned no tools');
  writeFileSync(TOOLBOX_FIXTURE_PATH, JSON.stringify(tools, null, 2) + '\n');
  console.log(`recorded ${tools.length} tools to ${TOOLBOX_FIXTURE_PATH}: ${tools.map((t) => t.name).join(', ')}`);
}
