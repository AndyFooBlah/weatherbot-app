// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// LIVE (Toolbox, not Gemini): the committed tool list still matches what the
// deployed Toolbox serves, so the declarations the other tests send are the
// real ones.
//
// Runs only via `npm run test:live` with TOOLBOX_URL set and an identity
// that may invoke the private Toolbox (see evals/toolboxTransport.ts). It
// makes no Gemini call and costs nothing.

import { describe, expect, it } from 'vitest';
import { normalizeMcpTools } from '../../evals/recordToolboxFixture';
import { createToolboxTransport } from '../../evals/toolboxTransport';
import { loadToolboxFixture } from '../support/productionInputs';

const toolboxUrl = process.env.TOOLBOX_URL ?? '';

describe.skipIf(!toolboxUrl)('live: Toolbox tool list', () => {
  it('evals/fixtures/toolbox-tools.json matches the deployed Toolbox', async () => {
    const live = normalizeMcpTools(await createToolboxTransport(toolboxUrl).listTools());
    expect(
      live,
      'The Toolbox tool list has changed. Refresh the fixture with ' +
        '`TOOLBOX_URL=... npx tsx evals/recordToolboxFixture.ts`, review the diff and commit it.',
    ).toEqual(loadToolboxFixture());
  });
});
