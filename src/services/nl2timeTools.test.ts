// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Integration tests for the nl2time-backed tool wrappers. nl2time has its
// own conformance corpus; these tests pin OUR wrapper behavior and every
// historical time regression weatherbot has actually shipped, so a library
// upgrade or wrapper change that would re-break production fails here.
//
// TZ is forced to America/Los_Angeles (set in vitest.config.ts env) so
// makeContext()'s browser-tz lookup is deterministic in CI.

import { describe, expect, it } from 'vitest';
import { describeTimeTool, resolveTimeTool } from './nl2timeTools';

// Monday, July 20 2026, 9:05pm PDT — the reference used across weatherbot's
// time-bug history.
const NOW = new Date('2026-07-20T21:05:00-07:00');

describe('resolve_time — historical regressions', () => {
  it('"9pm tonight" — the original botched record_event case', () => {
    const r = resolveTimeTool('9pm tonight', NOW);
    expect(r.start_utc).toBe('2026-07-21T04:00:00Z');
  });

  it('"yesterday" — full LOCAL day window (the off-by-one-day case)', () => {
    const r = resolveTimeTool('yesterday', NOW);
    expect(r.start_utc).toBe('2026-07-19T07:00:00Z');
    expect(r.end_utc).toBe('2026-07-20T07:00:00Z');
    expect(r.grain).toBe('day');
  });

  it('"yesterday morning" — rejected by the old parser, forced improvisation', () => {
    const r = resolveTimeTool('yesterday morning', NOW);
    expect(r.start_utc).toBe('2026-07-19T13:00:00Z'); // 6am PDT
    expect(r.end_utc).toBe('2026-07-19T19:00:00Z'); // noon PDT
  });

  it('"3pm yesterday" — hour-grain interval, start is the instant', () => {
    const r = resolveTimeTool('3pm yesterday', NOW);
    expect(r.start_utc).toBe('2026-07-19T22:00:00Z');
  });

  it('"tomorrow at 8am"', () => {
    const r = resolveTimeTool('tomorrow at 8am', NOW);
    expect(r.start_utc).toBe('2026-07-21T15:00:00Z');
  });

  it('"july 4" — bare digit is a date, not 4am (old tokenizer bug)', () => {
    const r = resolveTimeTool('july 4', NOW);
    expect(r.start_utc).toBe('2026-07-04T07:00:00Z');
    expect(r.end_utc).toBe('2026-07-05T07:00:00Z');
  });

  it('"last week" — calendar week, en-US Sunday start', () => {
    const r = resolveTimeTool('last week', NOW);
    expect(r.start_utc).toBe('2026-07-12T07:00:00Z');
    expect(r.end_utc).toBe('2026-07-19T07:00:00Z');
    expect(r.grain).toBe('week');
  });

  it('winter date resolves at UTC-8, not UTC-7 (DST)', () => {
    const r = resolveTimeTool('january 15', NOW);
    expect(r.start_utc).toBe('2026-01-15T08:00:00Z');
  });

  it('bias past: bare "friday" is the most recent Friday', () => {
    const r = resolveTimeTool('friday', NOW);
    expect(r.start_utc).toBe('2026-07-17T07:00:00Z'); // Fri Jul 17, not Jul 24
  });

  it('offers alternatives only when candidates materially differ', () => {
    const unambiguous = resolveTimeTool('yesterday', NOW);
    expect(unambiguous.alternatives).toBeUndefined();
  });

  it('throws a helpful error on non-temporal text', () => {
    expect(() => resolveTimeTool('the pool temperature', NOW)).toThrow(
      /no temporal expression/,
    );
  });

  it('interpreted_as is present for agent echo-back', () => {
    expect(resolveTimeTool('yesterday', NOW).interpreted_as).toBeTruthy();
  });
});

describe('describe_time — historical regressions', () => {
  it('the bird-feeder case: 04:00Z spoken as 9pm TONIGHT (not yesterday)', () => {
    // Event at 2026-07-21T04:00Z = 9:00pm PDT Jul 20; "now" is 9:05pm Jul 20.
    const [d] = describeTimeTool('2026-07-21T04:00:00Z', NOW);
    expect(d.text.toLowerCase()).toContain('9pm');
    expect(d.text.toLowerCase()).not.toContain('yesterday');
  });

  it('a timestamp from actual-yesterday says yesterday/last night', () => {
    // 2026-07-19 10:00am PDT = 17:00Z
    const [d] = describeTimeTool('2026-07-19T17:00:00Z', NOW);
    expect(d.text.toLowerCase()).toMatch(/yesterday/);
  });

  it('batch form: one call, many timestamps, order preserved', () => {
    const out = describeTimeTool(
      ['2026-07-21T04:00:00Z', '2026-07-19T17:00:00Z', '2026-07-04T19:00:00Z'],
      NOW,
    );
    expect(out).toHaveLength(3);
    expect(out[0].utc_iso).toBe('2026-07-21T04:00:00Z');
    expect(out.every((o) => o.text.length > 0)).toBe(true);
  });

  it('AM/PM never flips: 9pm-local timestamps never render as AM', () => {
    const [d] = describeTimeTool('2026-07-21T04:00:00Z', NOW); // 9pm PDT
    expect(d.text.toLowerCase()).not.toMatch(/\b9\s*am\b|9:00 am/);
  });
});

describe('round trip: resolve → describe stays consistent', () => {
  it('"3pm yesterday" resolved then described mentions yesterday/3pm', () => {
    const r = resolveTimeTool('3pm yesterday', NOW);
    const [d] = describeTimeTool(r.start_utc, NOW);
    expect(d.text.toLowerCase()).toMatch(/3\s*pm|3:00/);
  });
});
