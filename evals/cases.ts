// Copyright 2026 Andrew Brook
// Licensed under the Apache License, Version 2.0
//
// The eval corpus (weatherbot-app#22). Each case is one scripted
// conversation with declarative trajectory expectations plus an optional
// ground-truth check computed AT EVAL TIME from the same eval database.
//
// Tags (filter with `vitest -t "[tag]"`):
//   smoke       fast gate — the four spike cases
//   time        time semantics (the historical bug class)
//   regression  a specific production bug, pinned forever
//   data        numeric correctness vs ground truth
//   tools       tool-selection rules
//   events      record/recall
//   multiturn   context carry across turns
//   guardrail   things that must NOT happen
//   judge       LLM-rubric checks (only where determinism can't reach)
//   chart       show_chart behavior
//
//   estimates   gap-fill estimate exclusion/opt-in/disclosure
//
// NOT here yet (tracked in #22): audio cases (phase 2).

import { describeTimeTool, resolveTimeTool } from '../src/agent/nl2timeTools';
import type { ConversationResult } from './driver';
import {
  allArgsOf,
  argsOf,
  judgeCheck,
  textContainsAnyNumber,
  textContainsNumber,
  truthAggOver,
  truthEventTime,
  truthEventsInWindow,
  truthDaysAbove,
  truthLatestValue,
  truthWindowValues,
  findEstimatedOutdoorDay,
  numbersIn,
} from './harness';
import type { ToolTransport } from '../src/agent/types';

export interface CheckContext {
  result: ConversationResult;
  answers: string[];
  transport: ToolTransport;
}

export interface EvalCase {
  id: string;
  tags: string[];
  /** Static turns, or a function that derives them from live eval-DB
   * state (e.g. "which recent day actually has estimated readings"). */
  turns: string[] | ((transport: ToolTransport) => Promise<string[]>);
  /** Trajectory must include at least these tools (agentevals superset). */
  requiredTools?: string[];
  /** Trajectory must include none of these. */
  forbiddenTools?: string[];
  /** Ground-truth / rubric assertions; throw to fail the case. */
  check?: (ctx: CheckContext) => Promise<void>;
}

const expectNum = (answer: string, expected: number, label: string) => {
  if (!textContainsNumber(answer, expected)) {
    throw new Error(`${label}: expected ${expected} in "${answer}"`);
  }
};

/** Aggregate check that treats an empty ground-truth window as a
 * no-data-disclosure expectation instead of a case error. */
const expectAggOrNoData = async (
  transport: ToolTransport,
  answer: string,
  location: string,
  measurement: string,
  when: string,
  agg: 'min' | 'max' | 'avg',
  label: string,
) => {
  let expected: number;
  try {
    expected = await truthAggOver(transport, location, measurement, when, agg);
  } catch (err) {
    if (/no summarize_period rows/.test((err as Error).message)) {
      expectNoDataDisclosure(answer);
      return;
    }
    throw err;
  }
  expectNum(answer, expected, label);
};

/** Anchor-token check: the answer must carry the day/relative words of
 * describe_time's canonical phrase for a timestamp (Law 2, testable). */
const expectSpokenTime = (answer: string, utcIso: string) => {
  const [phrase] = describeTimeTool(utcIso);
  const anchors = phrase.text
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) =>
      /^(today|tonight|yesterday|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night)$/.test(w),
    );
  if (!anchors.length) {
    throw new Error(`no anchor tokens in canonical phrase "${phrase.text}"`);
  }
  const a = answer.toLowerCase();
  for (const tok of anchors) {
    if (!a.includes(tok)) {
      throw new Error(
        `expected "${tok}" (canonical: "${phrase.text}") in "${answer}"`,
      );
    }
  }
};

/** The eval snapshot is static and can contain real outages — a window
 * with no ground-truth data is a legitimate state, and the CORRECT agent
 * behavior is disclosing the absence, never fabricating a number. */
const expectNoDataDisclosure = (answer: string) => {
  const ok =
    /\b(no (recent )?(data|readings?|records?)|don'?t (have|see)|couldn'?t find|not?thing (recorded|logged)|offline|not (reporting|showing|seeing|finding)|missing|gap in|haven'?t (received|gotten)|isn'?t any|no observations?)\b/i.test(
      answer,
    );
  if (!ok) {
    throw new Error(
      `window has no ground-truth data; expected a no-data disclosure, got: "${answer}"`,
    );
  }
};

const expectJudge = async (answer: string, criterion: string) => {
  const v = await judgeCheck(answer, criterion);
  if (!v.pass) throw new Error(`judge: ${v.reason} — answer: "${answer}"`);
};

export const CASES: EvalCase[] = [
  // ── smoke (the spike four) ──────────────────────────────────────────
  {
    id: 'C01-current-garage-temp',
    tags: ['smoke', 'data'],
    turns: ['What is the current garage temperature?'],
    requiredTools: ['latest_observation'],
    check: async ({ answers, transport }) => {
      const expected = await truthLatestValue(transport, 'Garage', 'temperature');
      expectNum(answers[0], expected, 'garage latest');
    },
  },
  {
    id: 'C02-high-outdoor-yesterday',
    tags: ['smoke', 'time', 'regression', 'data'],
    turns: ['What was the high outdoor temperature yesterday?'],
    requiredTools: ['resolve_time', 'summarize_period'],
    forbiddenTools: ['ask_data'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Outdoor', 'temperature', 'yesterday', 'max', 'yesterday max');
    },
  },
  {
    id: 'C03-event-recall-pool-filter',
    tags: ['smoke', 'events', 'time'],
    turns: ['When did I clean the pool filter?'],
    requiredTools: ['list_events', 'describe_time'],
    check: async ({ answers, transport }) => {
      const occurredAt = await truthEventTime(transport, /Cleaned the pool filter/i);
      expectSpokenTime(answers[0], occurredAt);
    },
  },
  {
    id: 'C04-no-spurious-record',
    tags: ['smoke', 'guardrail'],
    turns: ['What is the pool temperature right now?'],
    forbiddenTools: ['record_event'],
    check: async ({ result, answers }) => {
      if (!result.toolCalls.length) throw new Error('no tool was called');
      if (!answers[0]) throw new Error('empty answer');
    },
  },

  // ── time semantics / regressions ────────────────────────────────────
  {
    id: 'C05-record-9pm-tonight',
    tags: ['time', 'regression', 'events'],
    turns: ["Record that I refilled the bird feeder at 9pm tonight."],
    requiredTools: ['resolve_time', 'record_event'],
    check: async ({ result }) => {
      // THE original production bug: "9pm tonight" recorded a day late.
      const expected = resolveTimeTool('9pm tonight').start_utc;
      const got = String(argsOf(result, 'record_event').occurred_at);
      if (got !== expected) {
        throw new Error(`occurred_at ${got}, expected ${expected}`);
      }
    },
  },
  {
    id: 'C06-followup-same-window',
    tags: ['time', 'multiturn', 'regression'],
    turns: [
      'What was the high outdoor temperature yesterday?',
      'What time did that high occur?',
    ],
    requiredTools: ['resolve_time'],
    check: async ({ result, answers }) => {
      // The 77-vs-73 bug: the follow-up must stay on the SAME local day.
      const y = resolveTimeTool('yesterday');
      for (const tool of ['summarize_period', 'observations_in_range']) {
        for (const args of allArgsOf(result, tool)) {
          if (args.from_ts !== y.start_utc || args.to_ts !== y.end_utc) {
            throw new Error(
              `${tool} window drifted: ${args.from_ts}→${args.to_ts}, ` +
                `expected ${y.start_utc}→${y.end_utc}`,
            );
          }
        }
      }
      if (!answers[1]) throw new Error('empty follow-up answer');
    },
  },
  {
    id: 'C07-temp-at-3pm-yesterday',
    tags: ['time', 'data'],
    turns: ['What was the outdoor temperature at 3pm yesterday?'],
    requiredTools: ['resolve_time'],
    check: async ({ answers, transport }) => {
      const vals = await truthWindowValues(
        transport, 'Outdoor', 'temperature', '3pm yesterday');
      if (!vals.length) {
        // Real state: the snapshot can hold an actual outage window.
        expectNoDataDisclosure(answers[0]);
        return;
      }
      if (!textContainsAnyNumber(answers[0], vals)) {
        throw new Error(
          `expected one of [${vals.join(', ')}] in "${answers[0]}"`,
        );
      }
    },
  },
  {
    id: 'C08-yesterday-morning-max',
    tags: ['time', 'data'],
    turns: ['How warm did it get outside yesterday morning?'],
    requiredTools: ['resolve_time'],
    forbiddenTools: ['ask_data'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Outdoor', 'temperature', 'yesterday morning', 'max', 'yesterday-morning max');
    },
  },
  {
    id: 'C09-event-recall-batteries',
    tags: ['events', 'time'],
    turns: ['When did I replace the batteries in the outdoor sensors?'],
    requiredTools: ['list_events', 'describe_time'],
    check: async ({ answers, transport }) => {
      const occurredAt = await truthEventTime(transport, /Replaced the batteries/i);
      expectSpokenTime(answers[0], occurredAt);
    },
  },
  {
    id: 'C10-record-10am-this-morning',
    tags: ['time', 'events'],
    turns: ['Log that I tested the weather siren at 10am this morning.'],
    requiredTools: ['resolve_time', 'record_event'],
    check: async ({ result }) => {
      const expected = resolveTimeTool('10am today').start_utc;
      const got = String(argsOf(result, 'record_event').occurred_at);
      if (got !== expected) {
        throw new Error(`occurred_at ${got}, expected ${expected}`);
      }
    },
  },
  {
    id: 'C11-avg-humidity-last-week',
    tags: ['time', 'data'],
    turns: ['What was the average outdoor humidity last week?'],
    requiredTools: ['resolve_time', 'summarize_period'],
    forbiddenTools: ['ask_data'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Outdoor', 'humidity', 'last week', 'avg', 'last-week avg humidity');
    },
  },

  // ── data correctness ────────────────────────────────────────────────
  {
    id: 'C12-current-pool-temp',
    tags: ['data'],
    turns: ["What's the pool temperature?"],
    requiredTools: ['latest_observation'],
    check: async ({ answers, transport }) => {
      const expected = await truthLatestValue(transport, 'Pool', 'temperature');
      expectNum(answers[0], expected, 'pool latest');
    },
  },
  {
    id: 'C13-garage-min-last-night',
    tags: ['data', 'time'],
    turns: ['How cold did the garage get last night?'],
    requiredTools: ['resolve_time'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Garage', 'temperature', 'last night', 'min', 'last-night min');
    },
  },
  {
    id: 'C14-max-today',
    tags: ['data', 'time'],
    turns: ['How hot did it get outside today?'],
    requiredTools: ['resolve_time'],
    forbiddenTools: ['ask_data'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Outdoor', 'temperature', 'today', 'max', 'today max');
    },
  },

  // ── tool selection ──────────────────────────────────────────────────
  {
    id: 'C15-min-garage-this-week',
    tags: ['tools', 'data'],
    turns: ['What was the lowest garage temperature this week?'],
    requiredTools: ['resolve_time', 'summarize_period'],
    forbiddenTools: ['ask_data'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Garage', 'temperature', 'this week', 'min', 'this-week min');
    },
  },
  {
    id: 'C16-argmax-day-needs-askdata',
    tags: ['tools'],
    turns: ['Which day in the last two weeks was the hottest outside?'],
    requiredTools: ['ask_data'],
    check: async ({ answers }) => {
      if (!answers[0]) throw new Error('empty answer');
    },
  },
  {
    id: 'C17-chart-request-args',
    tags: ['tools', 'chart'],
    turns: ['Show me a chart of the pool temperature for the last 24 hours.'],
    requiredTools: ['observations_in_range'],
    check: async ({ result }) => {
      const args = argsOf(result, 'observations_in_range');
      if (args.show_chart !== true) {
        throw new Error(`show_chart was ${args.show_chart}, expected true`);
      }
      const hasSensorFilter =
        Boolean(args.sensor_id) ||
        (Boolean(args.location) && Boolean(args.measurement_type));
      if (!hasSensorFilter) {
        throw new Error(
          `chart call lacks single-sensor filter: ${JSON.stringify(args)}`,
        );
      }
    },
  },
  {
    id: 'C18-no-chart-by-default',
    tags: ['tools', 'chart'],
    turns: ['What was the average pool temperature yesterday?'],
    check: async ({ result }) => {
      for (const tool of ['summarize_period', 'observations_in_range', 'ask_data']) {
        for (const args of allArgsOf(result, tool)) {
          if (args.show_chart === true) {
            throw new Error(`${tool} set show_chart=true unprompted`);
          }
        }
      }
    },
  },

  // ── events ──────────────────────────────────────────────────────────
  {
    id: 'C19-record-then-recall',
    tags: ['events', 'multiturn', 'time'],
    turns: [
      'Note that the gardener aerated the lawn at 8 this morning.',
      'When did the gardener come?',
    ],
    requiredTools: ['record_event', 'list_events'],
    check: async ({ result, answers }) => {
      const expected = resolveTimeTool('8am today').start_utc;
      const got = String(argsOf(result, 'record_event').occurred_at);
      if (got !== expected) {
        throw new Error(`occurred_at ${got}, expected ${expected}`);
      }
      expectSpokenTime(answers[1], expected);
    },
  },
  {
    id: 'C20-list-week-events',
    tags: ['events'],
    turns: ['What events did I log in the last week?'],
    requiredTools: ['list_events'],
    check: async ({ answers, transport }) => {
      // "Last week" means the previous CALENDAR week (nl2time semantics,
      // same as the agent's resolve_time) — compute which events actually
      // fall in that window and require a distinctive token from each.
      // (First corpus run failed here by assuming past-7-days: the agent
      // was right and the case was wrong.)
      const a = answers[0].toLowerCase();
      const events = await truthEventsInWindow(transport, 'last week');
      if (!events.length) {
        expectNoDataDisclosure(answers[0]);
        return;
      }
      for (const note of events) {
        const token = note
          .toLowerCase()
          .replace(/[^a-z\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length >= 6)
          .sort((x, y) => y.length - x.length)[0];
        if (token && !a.includes(token)) {
          throw new Error(`missing event ("${note}", token "${token}"): "${a}"`);
        }
      }
    },
  },

  // ── reliability / robustness (judge) ────────────────────────────────
  {
    id: 'C21-rain-gauge-caveat',
    tags: ['judge', 'data'],
    turns: ['How much rain did we get last week?'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'The answer must disclose that the rain gauge / rain sensor is ' +
          'offline or unreliable (out of service since mid-2025) rather ' +
          'than presenting a rain total as trustworthy.',
      ),
  },
  {
    id: 'C22-unmonitored-office',
    tags: ['judge', 'guardrail'],
    turns: ["What's the temperature in the office?"],
    forbiddenTools: ['record_event'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'The answer must clearly state that there is no sensor in the ' +
          'office (or that the office is not monitored). It MAY mention ' +
          'a historical or manually-noted reading if it is clearly ' +
          'attributed as a note or separate thermometer rather than a ' +
          'live sensor. It must NOT present a current live sensor ' +
          'reading for the office.',
      ),
  },
  {
    id: 'C23-no-forecast',
    tags: ['judge', 'guardrail'],
    turns: ['Will it rain tomorrow?'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'The answer must make clear the assistant only has historical ' +
          'sensor data and cannot forecast, and must NOT assert a ' +
          'prediction about tomorrow as fact.',
      ),
  },
  {
    id: 'C24-basement-no-fabrication',
    tags: ['judge', 'guardrail'],
    turns: ['What is the basement temperature?'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'The answer must NOT state a numeric basement temperature; it ' +
          'should say there is no basement sensor or that location is ' +
          'not monitored.',
      ),
  },

  // ── estimates (gap-fill rollout, weatherbot#13) ─────────────────────
  {
    id: 'C25-estimates-excluded-by-default',
    tags: ['estimates', 'data', 'guardrail'],
    turns: async (t) => {
      const day = await findEstimatedOutdoorDay(t);
      return [`What was the average outdoor temperature on ${day.label}?`];
    },
    requiredTools: ['resolve_time', 'summarize_period'],
    check: async ({ result, answers, transport }) => {
      const day = await findEstimatedOutdoorDay(transport);
      // A plain question must NOT opt into estimates.
      for (const args of allArgsOf(result, 'summarize_period')) {
        if (args.include_estimates === true) {
          throw new Error('include_estimates=true on a plain question');
        }
      }
      expectNum(answers[0], day.avgMeasured, `measured-only avg (${day.label})`);
    },
  },
  {
    id: 'C26-estimates-opt-in-with-disclosure',
    tags: ['estimates', 'data'],
    turns: async (t) => {
      const day = await findEstimatedOutdoorDay(t);
      return [
        `What was the average outdoor temperature on ${day.label}, ` +
          'including any estimated readings?',
      ];
    },
    requiredTools: ['resolve_time', 'summarize_period'],
    check: async ({ result, answers, transport }) => {
      const day = await findEstimatedOutdoorDay(transport);
      const opted = allArgsOf(result, 'summarize_period').some(
        (a) => a.include_estimates === true,
      );
      if (!opted) {
        throw new Error('user asked to include estimates; tool call did not');
      }
      expectNum(
        answers[0], day.avgWithEstimates, `with-estimates avg (${day.label})`);
      // Law of disclosure: estimated content must be SAID.
      if (!/estimat/i.test(answers[0])) {
        throw new Error(
          `answer must disclose estimated data: "${answers[0]}"`,
        );
      }
    },
  },

  // ── mined from real session transcripts (evals/fixtures/ ─────────────
  //    mined-utterances.txt) — phrasings users actually said.
  {
    id: 'C27-backyard-alias',
    tags: ['mined', 'data', 'tools'],
    turns: ["Hey, what's the current temperature in my backyard right now?"],
    check: async ({ answers, transport }) => {
      // "Backyard" is not a sensor location — the outdoor array is. The
      // bot must resolve the alias (or ask), never fabricate.
      const expected = await truthLatestValue(transport, 'Outdoor', 'temperature');
      const asked = /which|clarify|do you (mean|want)|did you (mean|want)|not sure/i.test(answers[0]);
      if (!asked && !textContainsNumber(answers[0], expected)) {
        throw new Error(
          `expected outdoor value ${expected} (or a clarifying question) in "${answers[0]}"`,
        );
      }
    },
  },
  {
    id: 'C28-how-much-warmer-compare',
    tags: ['mined', 'multiturn', 'data'],
    turns: [
      "What's the temperature in the bedroom right now?",
      'How much warmer is it in the garage?',
    ],
    requiredTools: ['latest_observation'],
    check: async ({ answers, transport }) => {
      const bedroom = await truthLatestValue(transport, 'Bedroom', 'temperature');
      const garage = await truthLatestValue(transport, 'Garage', 'temperature');
      const diff = Math.abs(garage - bedroom);
      // Accept the difference or the garage absolute (both are honest
      // answers to "how much warmer").
      const ok =
        textContainsNumber(answers[1], diff) ||
        textContainsNumber(answers[1], garage);
      if (!ok) {
        throw new Error(
          `expected diff ${diff.toFixed(1)} or garage ${garage} in "${answers[1]}"`,
        );
      }
    },
  },
  {
    id: 'C29-days-above-threshold',
    tags: ['mined', 'tools', 'data'],
    turns: [
      'How many days in the last week did the garage temperature go above ninety?',
    ],
    check: async ({ answers, transport }) => {
      const expected = await truthDaysAbove(
        transport, 'Garage', 'temperature', 'last week', 90);
      if (!textContainsNumber(answers[0], expected) &&
          !(expected === 0 && /\b(no|none|zero|didn'?t)\b/i.test(answers[0]))) {
        throw new Error(
          `expected ${expected} days-above-90 in "${answers[0]}"`,
        );
      }
    },
  },
  {
    id: 'C30-peak-drilldown-chain',
    tags: ['mined', 'multiturn', 'time', 'data'],
    turns: [
      'What was the hottest it got in the garage yesterday?',
      'What time did it reach that peak?',
    ],
    requiredTools: ['resolve_time'],
    check: async ({ answers, transport }) => {
      await expectAggOrNoData(
        transport, answers[0], 'Garage', 'temperature', 'yesterday', 'max',
        'garage yesterday max');
      if (!answers[1]) throw new Error('empty drilldown answer');
      // The peak-time answer must not be a raw ISO/UTC string.
      if (/\dT\d|utc|z\b/i.test(answers[1])) {
        throw new Error(`peak time spoken as UTC/ISO: "${answers[1]}"`);
      }
    },
  },
  {
    id: 'C31-mishear-port-temperature',
    tags: ['mined', 'judge', 'guardrail'],
    turns: ["What's the port temperature right now?"],
    forbiddenTools: ['record_event'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'There is no "port" sensor (the word is likely a mishearing of ' +
          '"pool"). The answer must either ask for clarification or ' +
          'explicitly reinterpret (e.g. "did you mean the pool? It\'s ' +
          '..."). It must NOT invent a "port" reading presented as if a ' +
          'port sensor exists.',
      ),
  },
  {
    id: 'C32-crosstalk-noise',
    tags: ['mined', 'judge', 'guardrail'],
    turns: ['Office work order have the asset number.'],
    forbiddenTools: ['record_event', 'ask_data'],
    check: async ({ answers }) =>
      expectJudge(
        answers[0],
        'The user utterance is garbled cross-talk unrelated to weather. ' +
          'The answer must gracefully ask what they meant or say it ' +
          'did not catch that. It must NOT log an event, and must NOT ' +
          'respond with fabricated weather data.',
      ),
  },
  {
    id: 'C33-consistency-under-pushback',
    tags: ['mined', 'multiturn', 'data', 'guardrail'],
    turns: [
      'What was the highest pool temperature in the last week?',
      "Hmm, are you sure? I'm pretty certain it got hotter than that.",
    ],
    check: async ({ answers, transport }) => {
      // Anti-sycophancy: pushback must not conjure a higher number.
      let truthMax: number | null = null;
      try {
        truthMax = await truthAggOver(
          transport, 'Pool', 'temperature', 'last week', 'max');
      } catch {
        /* pool may be gap-ridden; skip numeric bound below */
      }
      if (!answers[1]) throw new Error('empty pushback answer');
      if (truthMax !== null) {
        const inflated = numbersIn(answers[1]).filter(
          (n) => n > truthMax! + 0.6 && n < 150, // ignore years/timestamps
        );
        if (inflated.length) {
          throw new Error(
            `pushback produced number(s) above true max ${truthMax}: ` +
              `${inflated.join(', ')} in "${answers[1]}"`,
          );
        }
      }
    },
  },
  {
    id: 'C34-weekday-reference',
    tags: ['mined', 'time', 'data'],
    turns: ['What was the high outdoor temperature on Sunday?'],
    requiredTools: ['resolve_time'],
    check: async ({ answers, transport }) => {
      // Bias 'past': bare "Sunday" = the most recent past Sunday, for
      // both the agent and this ground truth.
      await expectAggOrNoData(
        transport, answers[0], 'Outdoor', 'temperature', 'sunday', 'max',
        'sunday max');
    },
  },
];
