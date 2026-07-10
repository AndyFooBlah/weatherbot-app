// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// Inline chart that renders for the two tools where a glanceable
// visualization beats reading the JSON: observations_in_range (line)
// and summarize_period (bar). Returns null otherwise so the caller
// can keep the JSON inline.

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const PRIMARY = '#0ea5e9'; // Tailwind sky-500, matches the Tap-to-talk button
const AXIS = '#94a3b8'; // Tailwind slate-400

// Tools post-narrow-schema (`observations_in_range`, `summarize_period`)
// return rows in a uniform shape:
//   { observed_at, sensor_id, display_name, physical_location,
//     measurement_type, unit, value }    ← observations_in_range
//   { sensor_id, display_name, physical_location, measurement_type, unit,
//     observation_count, min_value, max_value, avg_value, total_value }
//                                        ← summarize_period
// So chart code reads `value` (time series) or `{min,avg,max}_value`
// (aggregate), and pulls the label from `display_name` directly.

/** Numeric-y type guard that accepts both `number` and numeric strings
 * (the latter shows up because Postgres numeric() round-trips as a string
 * through the JSON serializer in the toolbox). */
function isFiniteNum(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n);
  }
  return false;
}

/** Subsample to keep render cheap on a 2000-row week-long query. */
function decimate<T>(arr: T[], maxPoints = 500): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/** First non-null value of a key across rows — used to read the row-level
 * label and unit since they're constant within a single sensor's series. */
function firstNonNull(
  rows: Record<string, unknown>[],
  key: string,
): unknown {
  for (const r of rows) {
    if (r[key] != null) return r[key];
  }
  return null;
}

const TIMESTAMP_KEYS = new Set([
  'observed_at',
  'timestamp',
  'time',
  'date',
  'datetime',
  'created_at',
  'updated_at',
  'event_time',
]);

/**
 * Flatten Gemini Data Analytics QueryData rows. Its native shape is:
 *
 *   {
 *     query_result: {
 *       columns: [{name: "night_date", type: "DATE"}, {name: "min_temp", type: "FLOAT"}],
 *       rows:    [{values: [{value: "2026-06-01"}, {value: "55.2"}]}, ...]
 *     }
 *   }
 *
 * Each row has the literal key `values` holding parallel arrays — not the
 * flat {column_name: value} shape the chart layer expects. detectTimeSeries
 * sees a row with a single key `values` (whose value is an array) and bails,
 * so the chart silently fails to render. This function rebuilds each row as
 * a flat object using the column names, with numeric strings coerced to
 * numbers (everything from QueryData comes back as a string).
 */
function flattenQueryDataRows(parsed: unknown): Record<string, unknown>[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const qr =
    (obj['query_result'] as Record<string, unknown> | undefined) ??
    (obj['queryResult'] as Record<string, unknown> | undefined);
  if (!qr || typeof qr !== 'object') return null;
  const columns = qr['columns'];
  const rows = qr['rows'];
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;

  const colNames = (columns as Array<{ name?: string }>).map((c, i) => c?.name ?? `col_${i}`);
  return (rows as Array<{ values?: Array<{ value?: unknown }> }>).map((row) => {
    const vals = row?.values ?? [];
    const out: Record<string, unknown> = {};
    colNames.forEach((name, idx) => {
      const raw = vals[idx]?.value;
      if (raw === undefined || raw === null) {
        out[name] = null;
        return;
      }
      // QueryData returns every value as a string. Coerce numeric-looking
      // strings to numbers so detectTimeSeries / Recharts can plot them.
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed !== '') {
          const num = Number(trimmed);
          out[name] = Number.isFinite(num) ? num : raw;
          return;
        }
      }
      out[name] = raw;
    });
    return out;
  });
}

/**
 * Walk a parsed JSON value looking for an array of row objects. Handles the
 * shapes ask_data (Gemini Data Analytics QueryData) returns: top-level array,
 * `rows`, `data`, `result`, `queryResult`, and one level of nesting under
 * each. The QueryData-native shape is handled by flattenQueryDataRows above;
 * everything else falls through to the generic walk.
 */
function extractRows(parsed: unknown): Record<string, unknown>[] | null {
  // QueryData (Gemini Data Analytics) shape — flatten first.
  const flattened = flattenQueryDataRows(parsed);
  if (flattened && flattened.length > 0) return flattened;

  if (Array.isArray(parsed)) {
    if (
      parsed.length > 0 &&
      parsed.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))
    ) {
      return parsed as Record<string, unknown>[];
    }
    return null;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    for (const k of ['rows', 'data', 'result', 'queryResult', 'query_result']) {
      if (obj[k] !== undefined) {
        const nested = extractRows(obj[k]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

interface DetectedSeries {
  xField: string;
  yField: string;
}

/**
 * Heuristic time-series detection for ask_data results:
 *  - xField: a value parseable as an ISO timestamp OR a key whose name
 *    matches a known timestamp convention.
 *  - yField: a numeric field whose values vary across rows (≥2 distinct).
 *
 * Returns null when either can't be found, in which case no chart renders.
 */
function detectTimeSeries(rows: Record<string, unknown>[]): DetectedSeries | null {
  if (rows.length < 2) return null;
  const first = rows[0];
  const keys = Object.keys(first);

  let xField: string | null = null;
  for (const k of keys) {
    if (TIMESTAMP_KEYS.has(k.toLowerCase())) {
      xField = k;
      break;
    }
    const v = first[k];
    if (typeof v === 'string' && !Number.isNaN(new Date(v).getTime())) {
      xField = k;
      break;
    }
  }
  if (!xField) return null;

  let yField: string | null = null;
  for (const k of keys) {
    if (k === xField) continue;
    const v = first[k];
    if (typeof v !== 'number') continue;
    const distinct = new Set<number>();
    for (const r of rows) {
      const rv = r[k];
      if (typeof rv === 'number') distinct.add(rv);
      if (distinct.size > 1) break;
    }
    if (distinct.size > 1) {
      yField = k;
      break;
    }
  }
  if (!yField) return null;

  return { xField, yField };
}

function makeTimeFormatter(spanMs: number): (t: number) => string {
  const oneDay = 24 * 60 * 60 * 1000;
  if (spanMs < oneDay) {
    // Hour:minute
    return (t) =>
      new Date(t).toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
  }
  // Month-day
  return (t) =>
    new Date(t).toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
    });
}

interface ToolResultChartProps {
  toolName: string | undefined;
  data: unknown[] | undefined;
}

export function ToolResultChart({ toolName, data }: ToolResultChartProps) {
  if (!toolName || !data || data.length === 0) return null;

  const rows = data as Record<string, unknown>[];

  if (toolName === 'observations_in_range') {
    // Narrow shape: every row has {observed_at, value, display_name, unit}.
    return (
      <TimeSeriesChart
        data={rows}
        forcedMetric={{ xField: 'observed_at', yField: 'value' }}
        labelOverride={chartLabel(rows)}
      />
    );
  }

  if (toolName === 'summarize_period') {
    return <AggregateChart data={rows} />;
  }

  // ask_data: heuristic time-series detection on whatever shape came back.
  // Walks one level of nesting to find a rows array, then looks for a
  // timestamp + varying-numeric pair.
  if (toolName === 'ask_data') {
    const inner = extractRows(data.length === 1 ? data[0] : data);
    if (!inner) {
      console.warn(
        '[ToolResultChart] ask_data: extractRows returned null. ' +
          'The result didn\'t contain a recognisable rows array or QueryData ' +
          'query_result.{columns,rows} shape.',
      );
      return null;
    }
    const series = detectTimeSeries(inner);
    if (!series) {
      console.warn(
        '[ToolResultChart] ask_data: detectTimeSeries found no chartable ' +
          'series in the extracted rows. ' +
          `First row keys: ${Object.keys(inner[0] ?? {}).join(', ')}. ` +
          'Need both a timestamp-shaped field and a numeric field that varies ' +
          'across rows.',
      );
      return null;
    }
    return (
      <TimeSeriesChart
        data={inner}
        forcedMetric={series}
        labelOverride={prettyFieldName(series.yField)}
      />
    );
  }

  return null;
}

/** Build the chart label from the new narrow-shape rows. Falls back
 * gracefully when display_name / unit aren't present. */
function chartLabel(rows: Record<string, unknown>[]): string {
  const name = firstNonNull(rows, 'display_name');
  const unit = firstNonNull(rows, 'unit');
  if (typeof name === 'string' && typeof unit === 'string') {
    return `${name} (${unit})`;
  }
  if (typeof name === 'string') return name;
  return 'Value';
}

function prettyFieldName(field: string): string {
  return field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface TimeSeriesChartProps {
  data: Record<string, unknown>[];
  /** When non-null, use this {x,y} pair instead of the priority-list pick. */
  forcedMetric: DetectedSeries | null;
  /** Override the label shown above the chart. */
  labelOverride?: string;
}

function TimeSeriesChart({ data, forcedMetric, labelOverride }: TimeSeriesChartProps) {
  const xField = forcedMetric?.xField ?? 'observed_at';
  const yField = forcedMetric?.yField ?? 'value';
  if (!yField) return null;

  const points = decimate(
    data
      .map((row) => {
        const x = row[xField];
        const y = row[yField];
        return {
          t: typeof x === 'string' ? new Date(x).getTime() : NaN,
          v: typeof y === 'number' ? y : null,
        };
      })
      .filter((p) => Number.isFinite(p.t) && p.v != null) as Array<{
      t: number;
      v: number;
    }>,
  );

  if (points.length < 2) return null;

  const spanMs = points[points.length - 1].t - points[0].t;
  const tickFormatter = makeTimeFormatter(spanMs);
  const label = labelOverride ?? yField;

  return (
    <div className="mt-2">
      <div className="text-[10px] text-slate-500 mb-1">{label}</div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart
          data={points}
          margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        >
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={tickFormatter}
            interval="preserveStartEnd"
            stroke={AXIS}
            fontSize={10}
            tickLine={false}
          />
          <YAxis
            stroke={AXIS}
            fontSize={10}
            width={32}
            tickLine={false}
            domain={['auto', 'auto']}
          />
          <Tooltip
            labelFormatter={(t) =>
              new Date(t as number).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            }
            formatter={(value) => [value, label]}
            contentStyle={{
              fontSize: '11px',
              borderRadius: '6px',
              border: '1px solid #e2e8f0',
            }}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke={PRIMARY}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AggregateChart({ data }: { data: Record<string, unknown>[] }) {
  if (data.length === 0) return null;
  // Narrow shape: each row already is one sensor's summary with
  // {display_name, unit, min_value, avg_value, max_value}. If the result
  // has more than one sensor we just chart the first; the agent is
  // expected to filter to a single sensor when asking for a chart.
  const row = data[0];
  const min = row.min_value;
  const avg = row.avg_value;
  const max = row.max_value;
  if (
    !isFiniteNum(min) || !isFiniteNum(avg) || !isFiniteNum(max)
  ) {
    return null;
  }

  const displayName = typeof row.display_name === 'string' ? row.display_name : 'Value';
  const unit = typeof row.unit === 'string' ? row.unit : '';

  const bars = [
    { metric: 'min', value: Number(min) },
    { metric: 'avg', value: Number(avg) },
    { metric: 'max', value: Number(max) },
  ];

  return (
    <div className="mt-2">
      <div className="text-[10px] text-slate-500 mb-1">
        {displayName}{unit ? ` (${unit})` : ''} — min / avg / max
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart
          data={bars}
          margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        >
          <XAxis
            dataKey="metric"
            stroke={AXIS}
            fontSize={11}
            tickLine={false}
          />
          <YAxis
            stroke={AXIS}
            fontSize={10}
            width={32}
            tickLine={false}
          />
          <Tooltip
            formatter={(value) => [`${value}${unit ? ' ' + unit : ''}`, '']}
            cursor={{ fill: '#f1f5f9' }}
            contentStyle={{
              fontSize: '11px',
              borderRadius: '6px',
              border: '1px solid #e2e8f0',
            }}
          />
          <Bar
            dataKey="value"
            fill={PRIMARY}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
