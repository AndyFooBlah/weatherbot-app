// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Exhaustive tests for the local natural-language time resolver.
// Reference instant for combined/relative cases: Monday, July 20 2026,
// 9:05pm PDT (America/Los_Angeles). July 2026 is PDT (UTC-7); January is
// PST (UTC-8), used to pin DST correctness.

import { describe, expect, it } from 'vitest';
import {
  parseRelativeOffset,
  parseTimeOfDay,
  resolveDateExpr,
  resolveTime,
  wallClockToUtc,
} from './timeResolver';

const TZ = 'America/Los_Angeles';
// Monday, July 20 2026, 21:05 local (PDT).
const NOW = new Date('2026-07-20T21:05:00-07:00');
const opts = { now: NOW, timeZone: TZ };

describe('parseTimeOfDay', () => {
  const cases: [string, number, number][] = [
    ['noon', 12, 0],
    ['midday', 12, 0],
    ['midnight', 0, 0],
    ['8am', 8, 0],
    ['8 am', 8, 0],
    ['8:30am', 8, 30],
    ['8:30 am', 8, 30],
    ['12pm', 12, 0],
    ['12am', 0, 0],
    ['12:30pm', 12, 30],
    ['9:05pm', 21, 5],
    ['9:05 p.m.', 21, 5],
    ['14:30', 14, 30],
    ['00:00', 0, 0],
    ['23:59', 23, 59],
    ['6', 6, 0], // bare 24h hour
  ];
  it.each(cases)('%s → %i:%i', (s, h, mi) => {
    expect(parseTimeOfDay(s)).toEqual({ h, mi });
  });

  it.each(['tomorrow', 'later', '25:00', '8:99', '13pm', 'half past'])(
    'rejects %s',
    (s) => expect(parseTimeOfDay(s)).toBeNull(),
  );
});

describe('parseRelativeOffset (ms)', () => {
  const H = 3_600_000, M = 60_000, D = 86_400_000, W = 604_800_000;
  const cases: [string, number][] = [
    ['in 2 hours', 2 * H],
    ['in 1 hour', H],
    ['in an hour', H],
    ['in half an hour', 0.5 * H],
    ['in 90 minutes', 90 * M],
    ['30 minutes ago', -30 * M],
    ['an hour ago', -H],
    ['2 days ago', -2 * D],
    ['in 3 days', 3 * D],
    ['a week ago', -W],
    ['in 1 week', W],
    ['5 hours from now', 5 * H],
  ];
  it.each(cases)('%s', (s, ms) => expect(parseRelativeOffset(s)).toBe(ms));

  it.each(['tomorrow', '8am', 'next friday', 'in the morning'])(
    'rejects %s',
    (s) => expect(parseRelativeOffset(s)).toBeNull(),
  );
});

describe('resolveDateExpr (ref: Mon 2026-07-20)', () => {
  // localParts-equivalent reference for a Monday, July 20 2026.
  const ref = { y: 2026, mo: 7, d: 20, weekday: 1 };
  const cases: [string, string][] = [
    ['today', '2026-7-20'],
    ['tonight', '2026-7-20'],
    ['this morning', '2026-7-20'],
    ['tomorrow', '2026-7-21'],
    ['yesterday', '2026-7-19'],
    // weekdays relative to Monday
    ['monday', '2026-7-20'], // today
    ['this monday', '2026-7-20'],
    ['tuesday', '2026-7-21'], // upcoming
    ['friday', '2026-7-24'], // this week's upcoming Friday
    ['this friday', '2026-7-24'],
    ['next friday', '2026-7-31'], // following week
    ['last friday', '2026-7-17'],
    ['next monday', '2026-7-27'],
    ['last monday', '2026-7-13'],
    ['sunday', '2026-7-26'],
    // explicit
    ['2026-07-04', '2026-7-4'],
    ['july 4', '2026-7-4'],
    ['jul 4 2026', '2026-7-4'],
    ['december 25, 2025', '2025-12-25'],
    ['7/4', '2026-7-4'],
    ['1/2/2027', '2027-1-2'],
    ['3/15/27', '2027-3-15'],
  ];
  it.each(cases)('%s → %s', (s, expected) => {
    const r = resolveDateExpr(s, ref)!;
    expect(`${r.y}-${r.mo}-${r.d}`).toBe(expected);
  });

  it.each(['gibberish', 'someday', 'the 4th'])('rejects %s', (s) =>
    expect(resolveDateExpr(s, ref)).toBeNull(),
  );
});

describe('wallClockToUtc — DST correctness', () => {
  it('summer PDT (UTC-7): Jul 20 21:00 → 04:00Z next day', () => {
    expect(wallClockToUtc(2026, 7, 20, 21, 0, TZ).toISOString()).toBe(
      '2026-07-21T04:00:00.000Z',
    );
  });
  it('winter PST (UTC-8): Jan 15 21:00 → 05:00Z next day', () => {
    expect(wallClockToUtc(2026, 1, 15, 21, 0, TZ).toISOString()).toBe(
      '2026-01-16T05:00:00.000Z',
    );
  });
  it('noon PDT → 19:00Z', () => {
    expect(wallClockToUtc(2026, 7, 20, 12, 0, TZ).toISOString()).toBe(
      '2026-07-20T19:00:00.000Z',
    );
  });
});

describe('resolveTime — combined phrases (ref: Mon Jul 20 2026, 9:05pm PDT)', () => {
  const cases: [string, string][] = [
    // The originally-botched case.
    ['9pm tonight', '2026-07-21T04:00:00Z'],
    ['tomorrow at 8am', '2026-07-21T15:00:00Z'],
    ['8am tomorrow', '2026-07-21T15:00:00Z'],
    ['tomorrow at 8:00', '2026-07-21T15:00:00Z'],
    ['3pm yesterday', '2026-07-19T22:00:00Z'],
    ['at 9pm yesterday', '2026-07-20T04:00:00Z'],
    ['this morning at 6am', '2026-07-20T13:00:00Z'],
    ['noon today', '2026-07-20T19:00:00Z'],
    ['next friday at noon', '2026-07-31T19:00:00Z'],
    ['last friday at 3pm', '2026-07-17T22:00:00Z'],
    ['july 4 at 10am', '2026-07-04T17:00:00Z'],
    ['2026-07-04 at 10:00', '2026-07-04T17:00:00Z'],
    ['midnight tomorrow', '2026-07-21T07:00:00Z'],
    ['tuesday at 8am', '2026-07-21T15:00:00Z'],
  ];
  it.each(cases)('%s → %s', (phrase, utc) => {
    expect(resolveTime(phrase, opts).utc_iso).toBe(utc);
  });

  it('resolved_local is human-readable', () => {
    expect(resolveTime('tomorrow at 8am', opts).resolved_local).toBe(
      '2026-07-21 08:00',
    );
  });
});

describe('resolveTime — relative offsets', () => {
  it('in 2 hours → 11:05pm PDT = 06:05Z next day', () => {
    expect(resolveTime('in 2 hours', opts).utc_iso).toBe('2026-07-21T06:05:00Z');
  });
  it('an hour ago → 8:05pm PDT = 03:05Z', () => {
    expect(resolveTime('an hour ago', opts).utc_iso).toBe('2026-07-21T03:05:00Z');
  });
  it('30 minutes ago', () => {
    expect(resolveTime('30 minutes ago', opts).utc_iso).toBe(
      '2026-07-21T03:35:00Z',
    );
  });
});

describe('resolveTime — defaults & edges', () => {
  it('time-only defaults date to today', () => {
    expect(resolveTime('at 3pm', opts).resolved_local).toBe('2026-07-20 15:00');
  });
  it('date-only defaults time to midnight', () => {
    expect(resolveTime('tomorrow', opts).resolved_local).toBe('2026-07-21 00:00');
  });
  it('month/year boundary: Dec 31 11pm → next year in UTC', () => {
    expect(resolveTime('2026-12-31 at 11pm', opts).utc_iso).toBe(
      '2027-01-01T07:00:00Z',
    );
  });
  it('throws on unparseable input', () => {
    expect(() => resolveTime('sometime nextish', opts)).toThrow();
  });
});

describe('regression: phrases the agent actually said (2026-07-20 session log)', () => {
  // These four FAILED in production and forced the model to improvise
  // windows (producing an off-by-one "yesterday"). All must parse now.
  it('"yesterday morning" → yesterday 06:00–12:00 window', () => {
    const r = resolveTime('yesterday morning', opts);
    expect(r.window_start_utc).toBe('2026-07-19T13:00:00Z'); // 6am PDT
    expect(r.window_end_utc).toBe('2026-07-19T19:00:00Z'); // noon PDT
  });
  it('"yesterday night" → yesterday 18:00–24:00 window', () => {
    const r = resolveTime('yesterday night', opts);
    expect(r.window_start_utc).toBe('2026-07-20T01:00:00Z'); // 6pm PDT Jul 19
    expect(r.window_end_utc).toBe('2026-07-20T07:00:00Z'); // midnight
  });
  it('"2026-07-19 00:00:00" (seconds) → exact instant', () => {
    expect(resolveTime('2026-07-19 00:00:00', opts).utc_iso).toBe(
      '2026-07-19T07:00:00Z',
    );
  });
  it('"midnight Monday July 20 2026" (leading weekday) → exact instant', () => {
    expect(resolveTime('midnight Monday July 20 2026', opts).utc_iso).toBe(
      '2026-07-20T07:00:00Z',
    );
  });
});

describe('day windows — the from_ts/to_ts fix', () => {
  it('"yesterday" → full local day window (midnight→midnight PDT)', () => {
    const r = resolveTime('yesterday', opts);
    expect(r.window_start_utc).toBe('2026-07-19T07:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-20T07:00:00Z');
    expect(r.window_label).toContain('full day');
  });
  it('"today" → full local day window', () => {
    const r = resolveTime('today', opts);
    expect(r.window_start_utc).toBe('2026-07-20T07:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-21T07:00:00Z');
  });
  it('"july 4" → that local day window', () => {
    const r = resolveTime('july 4', opts);
    expect(r.window_start_utc).toBe('2026-07-04T07:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-05T07:00:00Z');
  });
  it('"last friday" → that local day window', () => {
    const r = resolveTime('last friday', opts);
    expect(r.window_start_utc).toBe('2026-07-17T07:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-18T07:00:00Z');
  });
  it('"tomorrow afternoon" → 12:00–18:00 local window', () => {
    const r = resolveTime('tomorrow afternoon', opts);
    expect(r.window_start_utc).toBe('2026-07-21T19:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-22T01:00:00Z');
  });
  it('"last night" → yesterday evening window', () => {
    const r = resolveTime('last night', opts);
    expect(r.window_start_utc).toBe('2026-07-20T01:00:00Z');
    expect(r.window_end_utc).toBe('2026-07-20T07:00:00Z');
  });
  it('point-in-time inputs have NO window fields', () => {
    const r = resolveTime('tomorrow at 8am', opts);
    expect(r.window_start_utc).toBeUndefined();
    expect(r.utc_iso).toBe('2026-07-21T15:00:00Z');
  });
  it('winter day window is UTC-8 (DST)', () => {
    const r = resolveTime('2026-01-15', opts);
    expect(r.window_start_utc).toBe('2026-01-15T08:00:00Z');
    expect(r.window_end_utc).toBe('2026-01-16T08:00:00Z');
  });
});
