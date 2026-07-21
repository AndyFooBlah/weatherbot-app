// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Deterministic local-wall-clock → UTC conversion, computed entirely in the
// browser. The voice agent must never do timezone offset math itself (it
// gets it wrong — e.g. "9pm tonight" once became the wrong day), so it calls
// the `resolve_local_time` tool; this module is what answers that call.
//
// No network, no database: the timezone is the user's IANA zone and "now" is
// read fresh at call time, so today/tomorrow/yesterday are always current.
//
// The one fiddly part is interpreting a wall-clock AS being in a given IANA
// zone and getting the UTC instant (JS Date parses only in the runtime zone
// or UTC). We use the standard offset trick: format a guessed UTC instant
// back into the target zone to discover that zone's offset, then correct —
// re-checking once so DST boundaries resolve. This is DST-correct except for
// the ~1hr/year ambiguous fall-back window, which doesn't matter here.

export interface ResolvedTime {
  resolved_local_date: string; // YYYY-MM-DD (local)
  local_time: string; // HH:MM (echoed back)
  timezone: string; // IANA zone used
  utc_iso: string; // e.g. 2026-07-21T04:00:00Z
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Offset (ms) that `timeZone` is ahead of UTC at the given UTC instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asIfUtc = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour,
    +p.minute,
    +p.second,
  );
  return asIfUtc - utcMs;
}

/** Interpret (y, mo1-12, d, h, mi) as a wall-clock in `timeZone` → UTC Date. */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

/** Current local calendar date (in `timeZone`) as [y, mo1-12, d]. */
function todayInZone(now: Date, timeZone: string): [number, number, number] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return [+p.year, +p.month, +p.day];
}

/**
 * Resolve a local date + time to the exact UTC instant.
 *
 * @param localDate 'today' | 'tomorrow' | 'yesterday' | 'YYYY-MM-DD'
 * @param localTime 'HH:MM' (24-hour, local)
 * @param timeZone  IANA zone; defaults to the browser's resolved zone
 * @param now       reference instant; defaults to Date.now() (injectable for tests)
 */
export function resolveLocalTime(
  localDate: string,
  localTime: string,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now: Date = new Date(),
): ResolvedTime {
  const m = /^(\d{1,2}):(\d{2})$/.exec(localTime.trim());
  if (!m) throw new Error(`local_time must be HH:MM, got "${localTime}"`);
  const [h, mi] = [+m[1], +m[2]];

  let y: number, mo: number, d: number;
  const kw = localDate.trim().toLowerCase();
  if (kw === 'today' || kw === 'tomorrow' || kw === 'yesterday') {
    const [ty, tmo, td] = todayInZone(now, timeZone);
    // Day arithmetic on the calendar date only (UTC midnight is a safe
    // carrier — we never treat it as an instant).
    const base = new Date(Date.UTC(ty, tmo - 1, td));
    base.setUTCDate(
      base.getUTCDate() + (kw === 'tomorrow' ? 1 : kw === 'yesterday' ? -1 : 0),
    );
    y = base.getUTCFullYear();
    mo = base.getUTCMonth() + 1;
    d = base.getUTCDate();
  } else {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(kw);
    if (!dm)
      throw new Error(
        `local_date must be today/tomorrow/yesterday or YYYY-MM-DD, got "${localDate}"`,
      );
    [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
  }

  const utc = wallClockToUtc(y, mo, d, h, mi, timeZone);
  return {
    resolved_local_date: `${y}-${pad(mo)}-${pad(d)}`,
    local_time: `${pad(h)}:${pad(mi)}`,
    timezone: timeZone,
    utc_iso: utc.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
