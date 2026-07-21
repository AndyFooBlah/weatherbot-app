// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Natural-language → point-in-time (and day-window) resolution, computed
// entirely locally (no network, no database). Maps phrases like "tomorrow
// at 8am", "yesterday", "yesterday morning" plus a reference instant and
// IANA timezone to exact UTC instants.
//
// Why local: pure datetime arithmetic with no dependency on stored data,
// and LLMs get timezone/relative-date math wrong (weatherbot's agent once
// turned "9pm tonight" into the wrong day, and later built a "yesterday"
// window that was actually today). The voice agent calls the
// `resolve_local_time` tool; this module answers it in-browser.
//
// KEY DESIGN POINT — windows, not just instants: when the input has no
// specific clock time ("yesterday", "July 4", "yesterday morning"), the
// result includes window_start_utc / window_end_utc for the local
// midnight-to-midnight day (or the day-part range). Callers building
// from_ts/to_ts MUST use those fields; assembling windows from separate
// midnight lookups is exactly how the agent produced off-by-one days.
//
// Self-contained and dependency-free so it can be lifted into a shared
// library (e.g. KnowledgeCommon) unchanged. Grammar is bounded and pinned
// by tests (timeResolver.test.ts).

export interface ResolvedTime {
  /** The input phrase, echoed for traceability. */
  input: string;
  /** IANA timezone used for resolution. */
  timezone: string;
  /** Resolved LOCAL wall-clock of utc_iso, "YYYY-MM-DD HH:MM". */
  resolved_local: string;
  /** The exact instant as UTC ISO 8601. For date-only / day-part inputs
   *  this is the START of the window. */
  utc_iso: string;
  /** Present when the input named a day or day-part rather than a specific
   *  clock time: the [start, end) of that local window in UTC. Use these
   *  directly as from_ts / to_ts. */
  window_start_utc?: string;
  window_end_utc?: string;
  /** What the window covers, e.g. "full day", "morning (06:00–12:00)". */
  window_label?: string;
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

/** Day-part → [startHour, endHour) local. "night" ≈ evening for windowing. */
const DAY_PARTS: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 24],
  night: [18, 24],
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
 * "14:30", "00:00:00" (seconds accepted, ignored), "12pm" (→12:00),
 * "12am" (→00:00). Returns {h, mi} 24-hour.
 */
export function parseTimeOfDay(input: string): HM | null {
  const s = input.trim().toLowerCase();
  if (s === 'noon' || s === 'midday') return { h: 12, mi: 0 };
  if (s === 'midnight') return { h: 0, mi: 0 };

  // H[:MM[:SS]] with optional am/pm (seconds accepted and ignored).
  const m = /^(\d{1,2})(?::(\d{2})(?::\d{2})?)?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
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
    if (h > 23) return null; // 24-hour clock
  }
  return { h, mi };
}

/**
 * Parse a relative offset from "now": "in 2 hours", "30 minutes ago",
 * "an hour ago", "in half an hour", "a week ago", "5 hours from now".
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
 * Resolve a date expression to a calendar date, relative to `refLocal`.
 * Handles: today/tomorrow/yesterday/tonight, "last night" (→ yesterday),
 * this/next/last <weekday>, bare <weekday>, optional leading weekday before
 * an explicit date ("Monday July 20 2026"), trailing day-part words
 * (stripped: "yesterday morning" → yesterday), YYYY-MM-DD,
 * "<month> <day>[, <year>]", M/D[/Y].
 */
export function resolveDateExpr(
  input: string,
  refLocal: YMD & { weekday: number },
): YMD | null {
  let s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const today: YMD = { y: refLocal.y, mo: refLocal.mo, d: refLocal.d };

  // Literals (before day-part stripping — "this morning" means today).
  if (s === 'today' || s === 'tonight' || s === 'this morning'
      || s === 'this afternoon' || s === 'this evening' || s === 'this') {
    return today;
  }
  if (s === 'last night') return addDays(today, -1);
  if (s === 'tomorrow' || s === 'tmrw') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);

  // Strip a trailing day-part word: "yesterday morning" → "yesterday",
  // "tomorrow afternoon" → "tomorrow", "monday evening" → "monday".
  const stripped = s.replace(/\s+(morning|afternoon|evening|night)$/, '');
  if (stripped !== s) {
    s = stripped;
    if (s === 'yesterday') return addDays(today, -1);
    if (s === 'tomorrow' || s === 'tmrw') return addDays(today, 1);
    if (s === 'today' || s === 'this') return today;
    if (s === 'last') return addDays(today, -1); // "last night" variants
  }

  // this/next/last <weekday>, or bare <weekday>.
  let m = /^(this|next|last)?\s*([a-z]+)$/.exec(s);
  if (m && WEEKDAYS[m[2]] !== undefined) {
    const target = WEEKDAYS[m[2]];
    const qualifier = m[1];
    let delta = (target - refLocal.weekday + 7) % 7;
    if (qualifier === 'last') {
      delta = delta === 0 ? -7 : delta - 7; // most recent past, before today
    } else if (qualifier === 'next') {
      delta = delta === 0 ? 7 : delta + 7; // the following week's
    }
    return addDays(today, delta);
  }

  // Optional leading weekday before an explicit date: "monday july 20 2026".
  const wdLead = /^([a-z]+),?\s+(.+)$/.exec(s);
  if (wdLead && WEEKDAYS[wdLead[1]] !== undefined) {
    const rest = resolveDateExpr(wdLead[2], refLocal);
    if (rest) return rest; // (weekday name is not validated against the date)
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
 * Resolve a natural-language time phrase.
 *
 * Point-in-time inputs ("tomorrow at 8am", "9:05pm tonight", "in 2 hours")
 * → exact utc_iso. Day / day-part inputs ("yesterday", "July 4",
 * "yesterday morning", "last night") → utc_iso = window start PLUS
 * window_start_utc / window_end_utc covering the local midnight-to-midnight
 * day or the day-part range. Use the window fields as from_ts / to_ts.
 *
 * @throws if nothing parseable is found.
 */
export function resolveTime(when: string, opts: ResolveOpts = {}): ResolvedTime {
  const now = opts.now ?? new Date();
  const timeZone =
    opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const raw = when.trim();
  const s = raw.toLowerCase().replace(/\s+/g, ' ');

  // 1. Pure relative offset → exact instant, no window.
  const offset = parseRelativeOffset(s);
  if (offset !== null) {
    const inst = new Date(now.getTime() + offset);
    return finish(raw, timeZone, inst, null, null);
  }

  const ref = localParts(now, timeZone);

  // 2. Extract an explicit clock time if present.
  let datePart: string | null = null;
  let timePart: string | null = null;

  let m = /^(.*?)\s+at\s+(.+)$/.exec(s);
  if (m && parseTimeOfDay(m[2])) {
    datePart = m[1];
    timePart = m[2];
  } else {
    const tokens = s.split(' ');
    outer: for (let i = 0; i < tokens.length; i++) {
      for (let j = tokens.length; j > i; j--) {
        const cand = tokens.slice(i, j).join(' ');
        // A bare number ("4" in "july 4") is ambiguous with a date day —
        // only treat it as a time after an explicit "at" (handled above).
        if (/^\d{1,2}$/.test(cand)) continue;
        if (parseTimeOfDay(cand)) {
          timePart = cand;
          const rest = [...tokens.slice(0, i), ...tokens.slice(j)]
            .filter((t) => t !== 'at' && t !== 'on')
            .join(' ')
            .replace(/,/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          datePart = rest || null;
          break outer;
        }
      }
    }
    if (!timePart) datePart = s;
  }

  // 3. Detect a day-part word when there's no explicit clock time.
  let dayPart: string | null = null;
  if (!timePart && datePart) {
    const dp = /\b(morning|afternoon|evening|night)\b/.exec(datePart);
    if (dp) dayPart = dp[1];
  }

  // 4. Resolve the calendar date.
  let ymd: YMD;
  if (datePart && datePart.length) {
    const r = resolveDateExpr(datePart, ref);
    if (!r) {
      throw new Error(
        `Could not understand the date in "${raw}". Try today / tomorrow / ` +
          `yesterday, a weekday, "July 4", or 2026-07-04.`,
      );
    }
    ymd = r;
  } else {
    ymd = { y: ref.y, mo: ref.mo, d: ref.d };
  }

  if (!timePart && !datePart) {
    throw new Error(`Could not understand the time "${raw}".`);
  }

  // 5a. Explicit clock time → point in time, no window.
  if (timePart) {
    const t = parseTimeOfDay(timePart)!;
    const inst = wallClockToUtc(ymd.y, ymd.mo, ymd.d, t.h, t.mi, timeZone);
    return finish(raw, timeZone, inst, { ...ymd, ...t }, null);
  }

  // 5b. Day or day-part → window.
  const [startH, endH] = dayPart ? DAY_PARTS[dayPart] : [0, 24];
  const start = wallClockToUtc(ymd.y, ymd.mo, ymd.d, startH, 0, timeZone);
  const endYmd = endH === 24 ? addDays(ymd, 1) : ymd;
  const endHClamped = endH === 24 ? 0 : endH;
  const end = wallClockToUtc(endYmd.y, endYmd.mo, endYmd.d, endHClamped, 0, timeZone);
  const label = dayPart
    ? `${dayPart} (${pad(startH)}:00–${endH === 24 ? '24' : pad(endH)}:00 local)`
    : 'full day (00:00–24:00 local)';
  return finish(raw, timeZone, start, { ...ymd, h: startH, mi: 0 }, {
    start, end, label,
  });
}

function finish(
  input: string,
  timeZone: string,
  instant: Date,
  known: (YMD & HM) | null,
  window: { start: Date; end: Date; label: string } | null,
): ResolvedTime {
  let y: number, mo: number, d: number, h: number, mi: number;
  if (known) {
    ({ y, mo, d, h, mi } = known);
  } else {
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
  const iso = (dt: Date) => dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out: ResolvedTime = {
    input,
    timezone: timeZone,
    resolved_local: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`,
    utc_iso: iso(instant),
  };
  if (window) {
    out.window_start_utc = iso(window.start);
    out.window_end_utc = iso(window.end);
    out.window_label = window.label;
  }
  return out;
}
