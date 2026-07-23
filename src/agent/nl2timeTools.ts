// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Client-side time tools built on nl2time — the bidirectional NL ⇄ UTC
// boundary between the voice agent and everything timestamped.
//
// Direction 1 (resolve_time): the agent passes the user's literal temporal
// phrase ("3pm yesterday", "last week"); nl2time's rule parser emits
// symbolic IR and the engine resolves it deterministically against a fresh
// TimeContext. The agent gets [start_utc, end_utc) + grain back and uses
// them verbatim as tool arguments.
//
// Direction 2 (describe_time): any UTC timestamp the agent wants to SPEAK
// goes through nl2time's describe() and comes back as voice-ready prose
// ("9pm last night"). The agent never verbalizes raw ISO strings and never
// does calendar math in its head — both directions are deterministic here.
//
// This replaces the earlier hand-rolled timeResolver.ts (see git history);
// nl2time is the same idea grown into a real library: IR-centered, DST/
// locale-correct, with a published golden corpus for both directions.
// Reference: nl2time docs/agents.md patterns 2 (analytics) and 4
// (timestamps → prose).

import {
  TimeContext,
  Temporal,
  describe,
  parse,
  resolve,
  type TimeValue,
} from 'nl2time';

/** Fresh per-call context: browser timezone, fresh "now", weatherbot's
 * policy knobs. bias:'past' — weatherbot overwhelmingly queries history
 * and records things that already happened, so a bare "Friday" means the
 * most recent one. */
export function makeContext(now?: Date): TimeContext {
  return TimeContext.make({
    ...(now ? { now: now.toISOString() } : {}),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale:
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language
        : 'en-US',
    bias: 'past',
  });
}

const isoZ = (i: Temporal.Instant) =>
  i.toString({ smallestUnit: 'second' }).replace(/\+00:00$/, 'Z');

interface ResolvedRange {
  start_utc: string;
  end_utc: string;
  grain: string;
  /** Human-readable echo of how the phrase was interpreted — the agent can
   * surface this when confirming ("last week, July 12th through 18th"). */
  interpreted_as: string;
}

/**
 * resolve_time implementation. Returns the best candidate plus up to two
 * materially-different alternatives (different start or end), per the
 * nl2time guidance to never silently discard ambiguity.
 */
export function resolveTimeTool(
  when: string,
  now?: Date,
): {
  start_utc: string;
  end_utc: string;
  grain: string;
  interpreted_as: string;
  alternatives?: ResolvedRange[];
} {
  const ctx = makeContext(now);
  const { matches } = parse(when, ctx);
  if (!matches.length) {
    throw new Error(
      `no temporal expression recognized in "${when}" — try phrasing like ` +
        `"yesterday", "3pm yesterday", "last week", "July 4", "in 2 hours"`,
    );
  }
  const { candidates } = resolve(matches[0].expr, ctx);
  if (!candidates.length) {
    throw new Error(`"${when}" doesn't correspond to any real time range`);
  }

  const toRange = (v: TimeValue): ResolvedRange => {
    if (v.kind !== 'interval') {
      throw new Error(`"${when}" is a duration, not a point or range of time`);
    }
    return {
      start_utc: isoZ(v.start),
      end_utc: isoZ(v.end),
      grain: v.grain,
      interpreted_as: describe(v, ctx).text,
    };
  };

  const primary = toRange(candidates[0]);
  const alternatives = candidates
    .slice(1, 3)
    .map(toRange)
    .filter(
      (a) => a.start_utc !== primary.start_utc || a.end_utc !== primary.end_utc,
    );

  return alternatives.length ? { ...primary, alternatives } : primary;
}

/**
 * describe_time implementation. Accepts one UTC ISO timestamp or an array
 * (batch — a list_events result costs one call). style:'casual' renders
 * voice-friendly phrasing ("9pm last night" over "yesterday at 9:00 PM").
 */
export function describeTimeTool(
  utcIso: string | string[],
  now?: Date,
): Array<{ utc_iso: string; text: string }> {
  const ctx = makeContext(now);
  const list = Array.isArray(utcIso) ? utcIso : [utcIso];
  return list.map((iso) => {
    const instant = Temporal.Instant.from(iso);
    return {
      utc_iso: iso,
      text: describe(instant, ctx, { style: 'casual' }).text,
    };
  });
}
