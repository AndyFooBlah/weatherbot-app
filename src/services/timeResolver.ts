// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Natural-language → point-in-time resolution, computed entirely locally
// (no network, no database). Maps a phrase like "tomorrow at 8am" plus a
// reference instant and IANA timezone to an exact UTC instant.
//
// Why local: this is pure datetime arithmetic with no dependency on stored
// data, and LLMs get timezone/relative-date math wrong (weatherbot's agent
// once turned "9pm tonight" into the wrong day). The voice agent calls the
// `resolve_local_time` tool, which the SPA answers in-browser via this
// module — deterministic and instant.
//
// Design: a small set of pure, independently-testable functions
// (parseTimeOfDay, parseRelativeOffset, resolveDateExpr, wallClockToUtc)
// composed by resolveTime(). The grammar is intentionally bounded and each
// branch is pinned by tests (timeResolver.test.ts) — this is not an
// open-ended NL date parser, it's a robust resolver for the expressions a
// person actually says to a home-weather assistant.
//
// This module is self-contained and dependency-free so it can be lifted
// into a shared library (e.g. KnowledgeCommon) unchanged.

export interface ResolvedTime {
  /** The input phrase, echoed for traceability. */
  input: string;
  /** IANA timezone used for resolution. */
  timezone: string;
  /** Resolved LOCAL wall-clock, "YYYY-MM-DD HH:MM". */
  resolved_local: string;
  /** The exact instant as UTC ISO 8601, e.g. "2026-07-21T15:00:00Z". */
  utc_iso: string;
}

export interface ResolveOpts {
  now?: Date;
  timeZone?: string;
}

interface YMD {
  y: number;
  mo: number; // 1-12
  d: number;
}
interface HM {
  h: number; // 0-23
  mi: number; // 0-59
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

// ─── Timezone core (DST-correct) ────────────────────────────────────────

/** Offset (ms) that `timeZone` is ahead of UTC at the given UTC instant. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asIfUtc = Date.UTC(
    +p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second,
  );
  return asIfUtc - utcMs;
}

/** Interpret (y, mo 1-12, d, h, mi) as a wall-clock in `timeZone` → UTC Date. */
export function wallClockToUtc(
  y: number, mo: number, d: number, h: number, mi: number, timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2; // DST boundary re-check
  return new Date(utc);
}

/** Local calendar parts (in `timeZone`) of a UTC instant, incl. weekday 0-6. */
function localParts(now: Date, timeZone: string): YMD & { weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    weekday: WEEKDAYS[p.weekday.toLowerCase()] ?? 0,
  };
}

/** Add `days` to a calendar date (safe across month/year via UTC carrier). */
function addDays(ymd: YMD, days: number): YMD {
  const b = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d));
  b.setUTCDate(b.getUTCDate() + days);
  return { y: b.getUTCFullYear(), mo: b.getUTCMonth() + 1, d: b.getUTCDate() };
}

// ─── Parsers (return null on no-match) ──────────────────────────────────

/**
 * Parse a time-of-day: "8am", "8:30 am", "noon", "midnight", "9:05pm",
 * "14:30", "8 am", "12pm" (→12:00), "12am" (→00:00). Returns {h, mi} 24-hour.
 */
export function parseTimeOfDay(input: string): HM | null {
  const s = input.trim().toLowerCase();
  if (s === 'noon' || s === 'midday') return { h: 12, mi: 0 };
  if (s === 'midnight') return { h: 0, mi: 0 };

  // H[:MM] with optional am/pm
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  const mer = m[3]?.replace(/\./g, '');
  if (mi > 59) return null;

  if (mer === 'am') {
    if (h < 1 || h > 12) return null;
    h = h === 12 ? 0 : h;
  } else if (mer === 'pm') {
    if (h < 1 || h > 12) return null;
    h = h === 12 ? 12 : h + 12;
  } else {
    // No meridiem → 24-hour clock.
    if (h > 23) return null;
  }
  return { h, mi };
}

/**
 * Parse a relative offset from "now": "in 2 hours", "30 minutes ago",
 * "an hour ago", "in half an hour", "in 90 minutes", "a week ago".
 * Returns offset in milliseconds (signed) or null.
 */
export function parseRelativeOffset(input: string): number | null {
  const s = input.trim().toLowerCase();
  const unitMs: Record<string, number> = {
    minute: 60_000, min: 60_000, minutes: 60_000, mins: 60_000,
    hour: 3_600_000, hr: 3_600_000, hours: 3_600_000, hrs: 3_600_000,
    day: 86_400_000, days: 86_400_000,
    week: 604_800_000, weeks: 604_800_000,
  };
  // quantity: number, "a"/"an" → 1, "half an" → 0.5
  const qtyRe = '(\\d+(?:\\.\\d+)?|an?|half an|half a)';
  const unitRe = '(minutes?|mins?|hours?|hrs?|days?|weeks?)';

  let m = new RegExp(`^in ${qtyRe} ${unitRe}$`).exec(s)
    || new RegExp(`^${qtyRe} ${unitRe} from now$`).exec(s);
  if (m) return qtyToNum(m[1]) * unitMs[m[2]];

  m = new RegExp(`^${qtyRe} ${unitRe} ago$`).exec(s);
  if (m) return -qtyToNum(m[1]) * unitMs[m[2]];

  return null;
}

function qtyToNum(q: string): number {
  if (q === 'a' || q === 'an') return 1;
  if (q === 'half an' || q === 'half a') return 0.5;
  return parseFloat(q);
}

/**
 * Resolve a date expression to a calendar date, relative to `refLocal`
 * (today's local Y/M/D + weekday). Handles:
 *   today / tomorrow / yesterday / tonight / this morning|afternoon|evening
 *   <weekday>, this <weekday>, next <weekday>, last <weekday>
 *   YYYY-MM-DD
 *   <month> <day>[, <year>]   (e.g. "July 4", "Jul 4 2026")
 *   M/D[/Y]
 */
export function resolveDateExpr(
  input: string,
  refLocal: YMD & { weekday: number },
): YMD | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const today: YMD = { y: refLocal.y, mo: refLocal.mo, d: refLocal.d };

  if (s === 'today' || s === 'tonight' || s === 'this morning'
      || s === 'this afternoon' || s === 'this evening') return today;
  if (s === 'tomorrow' || s === 'tmrw') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);

  // Weekday, optionally qualified with this/next/last.
  let m = /^(this|next|last)?\s*([a-z]+)$/.exec(s);
  if (m && WEEKDAYS[m[2]] !== undefined) {
    const target = WEEKDAYS[m[2]];
    const qualifier = m[1];
    // Days until the next occurrence including today (0..6).
    let delta = (target - refLocal.weekday + 7) % 7;
    if (qualifier === 'last') {
      // Most recent past occurrence, strictly before today.
      delta = delta === 0 ? -7 : delta - 7;
    } else if (qualifier === 'next') {
      // The occurrence in the following week (skip this week's).
      delta = delta === 0 ? 7 : delta + 7;
    }
    // bare / "this" → nearest upcoming incl. today (delta as-is)
    return addDays(today, delta);
  }

  // ISO date.
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };

  // "<month> <day>[, <year>]"
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m && MONTHS[m[1]] !== undefined) {
    return { y: m[3] ? +m[3] : refLocal.y, mo: MONTHS[m[1]], d: +m[2] };
  }

  // "M/D[/Y]"
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) {
    let yr = m[3] ? +m[3] : refLocal.y;
    if (yr < 100) yr += 2000;
    return { y: yr, mo: +m[1], d: +m[2] };
  }

  return null;
}

// ─── Top-level resolver ─────────────────────────────────────────────────

/**
 * Resolve a natural-language time phrase to an exact instant.
 *
 * Handles combined phrases: "tomorrow at 8am", "3pm yesterday",
 * "next Friday at noon", "July 4 at 10am", "in 2 hours", "9:05pm tonight".
 * A pure relative offset ("in 2 hours", "30 minutes ago") is resolved
 * against `now` directly. Otherwise the phrase is split into a date part
 * and a time part; a missing date defaults to today, a missing time to
 * 00:00 (midnight).
 *
 * @throws if neither a date nor a time nor an offset can be parsed.
 */
export function resolveTime(when: string, opts: ResolveOpts = {}): ResolvedTime {
  const now = opts.now ?? new Date();
  const timeZone =
    opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const raw = when.trim();
  const s = raw.toLowerCase().replace(/\s+/g, ' ');

  // 1. Pure relative offset.
  const offset = parseRelativeOffset(s);
  if (offset !== null) {
    const inst = new Date(now.getTime() + offset);
    return finalize(raw, timeZone, inst);
  }

  const ref = localParts(now, timeZone);

  // 2. Split "<date> at <time>" / "<time> <date>" / date-only / time-only.
  //    Strip a leading/inner "at"/"on" connector between the two parts.
  let datePart: string | null = null;
  let timePart: string | null = null;

  // Try "<date> at <time>"
  let m = /^(.*?)\s+at\s+(.+)$/.exec(s);
  if (m && parseTimeOfDay(m[2])) {
    datePart = m[1];
    timePart = m[2];
  } else {
    // Scan tokens: find the first token-run that parses as a time; the
    // remainder (sans "at"/"on"/commas) is the date.
    const tokens = s.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      for (let j = tokens.length; j > i; j--) {
        const cand = tokens.slice(i, j).join(' ');
        if (parseTimeOfDay(cand)) {
          timePart = cand;
          const rest = [...tokens.slice(0, i), ...tokens.slice(j)]
            .filter((t) => t !== 'at' && t !== 'on')
            .join(' ')
            .replace(/,/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          datePart = rest || null;
          break;
        }
      }
      if (timePart) break;
    }
    if (!timePart) datePart = s; // maybe date-only
  }

  const time: HM = timePart ? parseTimeOfDay(timePart)! : { h: 0, mi: 0 };
  let ymd: YMD | null;
  if (datePart && datePart.length) {
    ymd = resolveDateExpr(datePart, ref);
    if (!ymd) {
      throw new Error(
        `Could not understand the date in "${raw}". Try today/tomorrow/` +
          `yesterday, a weekday, or a date like 2026-07-04.`,
      );
    }
  } else {
    ymd = { y: ref.y, mo: ref.mo, d: ref.d }; // default: today
  }

  if (!timePart && !datePart) {
    throw new Error(`Could not understand the time "${raw}".`);
  }

  const inst = wallClockToUtc(ymd.y, ymd.mo, ymd.d, time.h, time.mi, timeZone);
  return finalize(raw, timeZone, inst, { ...ymd, ...time });
}

function finalize(
  input: string,
  timeZone: string,
  instant: Date,
  known?: YMD & HM,
): ResolvedTime {
  let y: number, mo: number, d: number, h: number, mi: number;
  if (known) {
    ({ y, mo, d, h, mi } = known);
  } else {
    // Derive local wall-clock of the instant (offset-based results).
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      })
        .formatToParts(instant)
        .map((x) => [x.type, x.value]),
    ) as Record<string, string>;
    y = +p.year; mo = +p.month; d = +p.day; h = +p.hour; mi = +p.minute;
  }
  return {
    input,
    timezone: timeZone,
    resolved_local: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`,
    utc_iso: instant.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
