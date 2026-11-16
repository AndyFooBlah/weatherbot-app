# Testing weatherbot-app

Four levels. Only the first runs in CI by default.

| Level | Command | Needs | What it proves |
|---|---|---|---|
| Offline tests | `npm test` | nothing | The Live configuration is defined once and every path uses it; the tool declarations, the prompt, the time tools and the eval driver behave as specified |
| Live conformance suite | `npm run test:live` | `GEMINI_API_KEY` (real Gemini Live API) | The configuration production sends is accepted by the Live API and works, today |
| Evals | `npm run eval:smoke`, `npm run eval:corpus` | `GEMINI_API_KEY`, `TOOLBOX_URL`, an identity that may invoke the Toolbox | The agent answers weather questions correctly from real tool results |
| Live contract canary | `.github/workflows/live-contract.yml` | secret `LIVE_TEST_GEMINI_API_KEY` (**not set: off by default**) | The live suite, weekly in CI |

The live suite is built on the conformance kit that
[`@andyfooblah/voice-common`](https://github.com/AndyFooBlah/VoiceCommon/blob/main/TESTING.md)
publishes as `@andyfooblah/voice-common/testing`.

---

## The Live paths, and what each one sends

There are two code paths that open a Gemini Live session, and one server
function that authorizes the first.

| Path | Where | Model | Connect config |
|---|---|---|---|
| The app | `src/hooks/useWeatherbotSession.ts`, through VoiceCommon's `useSession` | `WEATHERBOT_LIVE_MODEL` | `useSession` calls `buildLiveConnectConfig` with `WEATHERBOT_LIVE_SESSION_OPTIONS` (model, thinking `'auto'`, voice Aoede) |
| The eval driver | `evals/driver.ts` → `ai.live.connect` | `WEATHERBOT_LIVE_MODEL` | `buildEvalLiveConnectConfig`: `buildLiveConnectConfig(weatherbotLiveConnectParams(...))`, the same inputs |
| Token broker | `functions/src/liveToken.ts` (`mintGeminiLiveToken`) | none: the token carries no model constraint | n/a; request built in `functions/src/liveTokenConfig.ts` |

- **One model constant.** `src/agent/liveModel.ts` is the only file in which a
  Live model id is written.
- **One configuration.** `src/agent/liveConfig.ts` holds the model, the
  thinking level and the voice as data. Both paths build their connect config
  from it with VoiceCommon's `buildLiveConnectConfig`, so the evals exercise
  the setup message production sends: voice, server-VAD turn-taking,
  input and output transcription, session resumption, context-window
  compression and the injected `endSession` tool.
- **Turn-taking is deliberately not configured.** Weatherbot keeps the
  server's automatic voice-activity detection with VoiceCommon's defaults, for
  snappy question and answer. A test fails if a turn-taking option appears.
- There is no diagnostics page and no raw `BidiGenerateContent` WebSocket in
  this repository.

The eval driver differs from a production session in five deliberate ways,
listed in the header of `evals/driver.ts` and each pinned by
`tests/evalDriver.test.ts`: text turns sent with `sendClientContent` instead of
microphone audio; no opening greeting cue; a long-lived API key instead of an
ephemeral token (same API version); `endSession` is acknowledged the way the
hook acknowledges it and recorded, but the socket stays open so a scripted
conversation can finish; and no resumption handle.

---

## 1. Offline tests (`npm test`)

No network and no key. They run on every push and pull request.

| File | Covers |
|---|---|
| `src/hooks/useWeatherbotSession.test.ts` | The hook, run for real with only `useSession` replaced by a recorder: it passes the model constant, `'auto'` thinking, the pinned voice and the greeting cue; sets no turn-taking option; starts each session with a fresh instruction and the fetched declarations. The config the real `buildLiveConnectConfig` produces from those inputs is asserted field by field and equals the shared route's. |
| `tests/liveConfig.test.ts` | The model is one VoiceCommon's registry lists as current, and is VoiceCommon's default (fails when VoiceCommon moves to a newer model, so the app's model gets a decision). `'auto'` gives the same config as the hand-set `'none'` it replaced. The tool declarations built from the committed Toolbox tool list: every tool declared, `show_chart` on chartable tools only, Toolbox tools `NON_BLOCKING`, valid names and schemas, `endSession` appended once, accepted by the builder for every current Live model. **The eval driver's config equals the production config.** The live suite's profile resolves to the production config. |
| `tests/evalDriver.test.ts` | The driver against a scripted fake SDK: the model, config and API version it connects with; each deliberate difference; tool calls go through the production dispatcher; a rejected setup fails at once with the close code and reason instead of hanging. |
| `tests/liveModelGuard.test.ts` | Guard. Scans `src/`, `functions/src/`, `evals/`, `tests/`, `scripts/` and `.github/workflows/` for Live model ids. One outside `src/agent/liveModel.ts`, one the registry marks legacy or shut down, or one the registry has never verified fails with file and line. |
| `tests/liveTokenBroker.test.ts` | The broker's token request: single use, 30-minute expiry, one minute to open the session, minted on the API version the browser connects on, and **no model constraint**, so the client constant is the only place the model is named. |
| `evals/promptSnapshot.test.ts` | The production (voice) prompt, byte for byte. |
| `src/agent/nl2timeTools.test.ts` | The client-side time tools and every time regression the app has shipped. |

### The Toolbox tool-list fixture

`evals/fixtures/toolbox-tools.json` is the Toolbox's `tools/list` answer,
reduced to names, descriptions and input schemas (no weather data) and sorted
by name. The offline tests build the production declarations from it and the
live suite sends them. Refresh it after any change to the Toolbox's tools:

```bash
TOOLBOX_URL="$(gcloud run services describe weatherbot-toolbox --region=us-central1 \
    --project=<backend project> --format='value(status.url)')" \
  npx tsx evals/recordToolboxFixture.ts
```

Review the diff before committing; this repository is public. When
`TOOLBOX_URL` is set, `npm run test:live` fails if the fixture no longer
matches the deployed Toolbox.

---

## 2. The live conformance suite (`npm run test:live`)

```bash
# The key lives only in this process's environment. Never put it in a file or
# in a VITE_ variable (anything with that prefix is built into the browser bundle).
GEMINI_API_KEY="$(gcloud secrets versions access latest --secret=GEMINI_API_KEY --project=weatherbot-app)" \
  npm run test:live

# Optional: also check the tool-list fixture against the deployed Toolbox,
# and write a results table.
TOOLBOX_URL=https://weatherbot-toolbox-....run.app \
LIVE_RESULTS_FILE=/tmp/live.jsonl GEMINI_API_KEY=... npm run test:live
node scripts/summarize-live-results.mjs /tmp/live.jsonl
```

Without `GEMINI_API_KEY` every Gemini test is skipped and the command exits
green. The files are `tests/live/*.live.test.ts`, run by
`vitest.live.config.ts` (Node, one file at a time, one retry) and excluded
from `npm test`.

Every check runs against the **production inputs**: `WEATHERBOT_LIVE_MODEL`,
the real voice instruction from `buildWeatherbotInstruction` (it contains no
user data beyond what the public prompt snapshot shows), the full declaration
set (nine Toolbox tools, `resolve_time`, `describe_time`, `endSession`), the
Aoede voice, and server VAD with default settings.

| File | Check | Passes when |
|---|---|---|
| `production.live.test.ts` | setup | The socket reaches `setupComplete` with the production config. A rejected thinking level, voice or tool schema shows up here, with the close code and reason. |
| | tool declarations | All 12 declarations are accepted and a first turn runs with them. |
| | text turn | The app's real opening cue (`AUTO_GREET_TEXT`) yields a spoken greeting, an output transcription and `turnComplete`. |
| | audio turn | A spoken question under server VAD with default settings is transcribed and answered. |
| | tool round trip | "What is the current garage temperature?" makes the model call `latest_observation`; the test answers with what the app's real dispatcher returns for a stub Toolbox row (synthetic 71 °F); the bot then says the number. |
| | barge-in | Speaking over the bot produces an `interrupted` event. |
| | session resumption | A handle is issued, the session reconnects with it and the bot recalls a code word from before. |
| | context compression | `contextWindowCompression` is accepted and a turn runs. |
| | model listed | `models.list` includes the model with `bidiGenerateContent`. |
| | ephemeral token | A token minted with the broker's own request (`buildLiveTokenRequestConfig`, same API version) opens the production session and the greeting is spoken. |
| | goodbye | A spoken goodbye under server VAD is answered aloud and the model calls `endSession`, which is what makes the app stop the session. The call is answered as the hook answers it (`scheduling: SILENT` once the bot has spoken). |
| | latency | End of user speech to first bot audio, median of three spoken turns. Warn only; see below. |
| `evalDriver.live.test.ts` | setup, tool declarations | The eval driver's exact connect config (`profile.connectConfig`) is accepted. |
| | driver conversation | One real conversation through `runConversation` with a stub Toolbox: text turn in, `latest_observation` called, dispatcher result returned, spoken answer transcribed with the number in it. |
| `toolboxFixture.live.test.ts` | fixture freshness | Only with `TOOLBOX_URL`: the committed tool list equals the deployed Toolbox's. No Gemini call. |

Not run for this app: `manual-turn-control` and `patience`. Weatherbot does
not use manual turn control or a custom silence duration, by the owner's
decision. VoiceCommon's own suite covers both, and the provider-contract
canaries (which thinking levels each model accepts).

### Latency baseline

Weatherbot is meant to feel snappy: a reply should start within about two
seconds of the user finishing a question. The latency check **warns** when the
median is over 2000 ms (`SNAPPY_SOFT_BUDGET_MS` in
`tests/live/production.live.test.ts`) and never fails on speed alone; a turn
that gets no answer at all still fails. Under server VAD the number includes
the roughly 0.8 s the server waits to be sure the user has stopped speaking.

Measured from a laptop in California against the public API, clean synthetic
speech. These are observations to compare against, not guarantees; the network
between the test machine and the API is part of every number.

| Measure (ms) | Run 1 (VoiceCommon 0.16.0) | Run 2 (0.16.0) | Run 3 (0.16.1) |
|---|---|---|---|
| **Latency check: end of speech to first bot audio**, median of 3 (min to max) | **1034** (1000 to 1131) | **1110** (1008 to 1117) | **1010** (1007 to 1115) |
| Audio-turn check: end of speech to first bot audio, one turn | 1137 | 1660 | 1321 |
| Opening cue sent to first audio of the greeting | 583 | 528 | 670 |
| Tool question (text) to the `latest_observation` call | 868 | 902 | 1044 |
| Tool call to the next bot audio after the tool result (the result is returned at once) | 2687 | 2319 | 2651 |
| Barge-in: user starts speaking to `interrupted` | 211 | 223 | 234 |
| Connect to `setupComplete` | 254 | 268 | 268 |

All three runs on 2026-11-15: `gemini-3.8-live`, server VAD with default
settings, every test passed with no warnings and no retries (15 of 15 in runs
1 and 2; 16 of 16 in run 3, which added the goodbye check). The spoken turn
is the kit's fixture "What is the capital of France?", which weatherbot
declines in one sentence, so the latency rows time turn-taking and first
audio, not a tool call. The tool rows are the ones that include a tool: the
bot speaks a short bridging phrase ("Let me check…") while the tool runs, so
the user hears something within about a second even when the answer itself
follows two to three seconds after the call.

### What a run costs

One run opens about 20 short sessions and takes under two minutes. The
cost is mostly text input: the system instruction and the tool declarations
are roughly 8,500 tokens and are billed on every turn. At the
`gemini-3.8-live` prices checked on 2026-11-15 ($0.75 per million text input
tokens, $3 and $12 per million audio input and output tokens) a run is an
estimated **$0.20 to $0.40**. This is an estimate from token counts, not a
figure read from a bill.

---

## 3. Evals (`npm run eval:smoke`, `npm run eval:corpus`)

The evals drive the production agent, headless, against a real Toolbox and
grade the answers against ground truth computed from direct tool calls. They
answer a different question from the live suite: not "does the session work?"
but "is the answer right?". Run the corpus before declaring any agent change
done (prompt, tools, model, `nl2time`, VoiceCommon).

```bash
GEMINI_API_KEY="$(gcloud secrets versions access latest --secret=GEMINI_API_KEY --project=weatherbot-app)" \
TOOLBOX_URL=https://weatherbot-toolbox-eval-....run.app \
  npm run eval:corpus                # about 9 minutes; -- -t "[smoke]" for the fast gate
```

They need an identity that may invoke the private Toolbox
(`evals/toolboxTransport.ts`: service-account ADC, or `gcloud auth
print-identity-token` on a laptop). Each case retries once; failing twice is
the signal. The scoreboard is written to `evals/results/last-run.json`
(untracked).

The eval database is a static snapshot and it ages. Cases about "today" or
"last week" then have no ground truth and some fail for that reason alone; the
run prints how stale the snapshot is. Re-seed it from the backend repository
(`weatherbot/infra/07-seed-eval-db.sh`) for full coverage. When comparing two
runs, compare them on the same snapshot.

A full corpus run costs an estimated $1 to $2 (about 40 Live sessions with the
full instruction and tool list on every turn, plus the judge calls).

### Results on record

| Date | Code | Smoke | Corpus | Failing cases |
|---|---|---|---|---|
| 2026-11-15 | `main` at `1cf366e`: VoiceCommon 0.15.0, driver with its old hand-built connect config | 1 of 1 | **27 of 34** | C02, C03, C09, C11, C20, C25, C26 |
| 2026-11-15 | weatherbot-app#58: VoiceCommon 0.16.0, driver on the production connect config | 1 of 1 | **29 of 34** | C03, C09, C20, C25, C26 |
| 2026-11-15 | VoiceCommon 0.16.1 (what is deployed), same driver config | 1 of 1 | **28 of 34** | C02, C03, C09, C20, C25, C26 |

All three runs used the same eval snapshot, 2,736 hours (114 days) old, the
same model and the same prompt. No case that passed on `main` fails on either
later run. The five that fail in every run are snapshot-age failures, not
agent defects: C25 and C26 need a day with estimated readings in the last 35
days; C03 and C09 look for events whose dates are now months back; C20
expects a no-data disclosure and the bot's "You didn't log any events last
week" is not recognised as one. C02 ("yesterday's outdoor high", a window
with no data in a snapshot this old) failed, passed, then failed: the model
sometimes gives up cleanly and sometimes keeps trying tools, including the
forbidden `ask_data`. C11 failed once and passed twice. With one run per
column, read those two as model variance on a stale snapshot, not as an
effect of the change: the driver's connect config is identical in the second
and third runs. Re-seed the snapshot before reading anything more into the
absolute numbers.

One thing to watch: in the third run the bot's answer to C20 contained the
same sentence twice in a row. It happened once in 34 conversations and in
neither earlier run.

---

## 4. Live contract canary (CI)

`.github/workflows/live-contract.yml` runs `npm run test:live` on
`workflow_dispatch` and every Monday at 14:41 UTC.

- **Off by default.** The first step checks for the repository secret
  `LIVE_TEST_GEMINI_API_KEY`. Without it the job ends green with a notice and
  nothing is sent to the API. Paid-API tests stay off in CI unless the owner
  opts in. To turn it on, once:

  ```bash
  # Use a key created for this purpose, ideally restricted to the Generative
  # Language API, so it can be rotated or revoked on its own.
  gh secret set LIVE_TEST_GEMINI_API_KEY --repo AndyFooBlah/weatherbot-app
  # paste the key at the prompt; it is never echoed
  gh workflow run live-contract.yml --repo AndyFooBlah/weatherbot-app
  ```

  To turn it off again: `gh secret delete LIVE_TEST_GEMINI_API_KEY --repo AndyFooBlah/weatherbot-app`.
- Dependencies are installed with `npm ci --ignore-scripts` before the key is
  in scope. The job that holds the key has read-only permissions; a separate
  job, which runs no repository code, has `issues: write`.
- On failure it opens one issue titled "Live contract canary is failing",
  assigned to the owner, or comments on the open one. A later pass comments
  and closes it. The job summary carries the full results table.
- The Toolbox fixture check skips in CI (no `TOOLBOX_URL`, no Toolbox
  identity). The evals are not part of the canary.
- Actions are pinned by commit SHA.

---

## Changing the Live model

A model swap is never just the string. The Live models disagree about
`thinkingConfig` (one rejects it, one requires it) and about tool execution,
and a mismatch closes the WebSocket during setup with code 1007, which reads
like a connection fault.

1. Check the provider's [models](https://ai.google.dev/gemini-api/docs/models)
   and [deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
   pages. Do not go from memory.
2. The model must be in VoiceCommon's registry (`LIVE_MODELS`), which records
   what each model accepts and is re-measured by VoiceCommon's own live suite.
   If it is not there, add it there first and bump the dependency.
3. Change `WEATHERBOT_LIVE_MODEL` in `src/agent/liveModel.ts`. Leave the
   thinking level on `'auto'`.
4. `npm test`, then `npm run test:live`, then `npm run eval:corpus`. Compare
   the corpus pass count and the latency numbers with the tables above. A
   corpus regression blocks the change.
5. Update the tables in this file and add a JOURNAL.md entry.

---

## What is not covered

- **The browser audio pipeline.** The kit talks to the Live API from Node. The
  microphone, the AudioWorklet, playback, the recorder and the session UI are
  VoiceCommon's and are covered by its tests and by using the app. That
  includes when the hook raises `onSessionEndRequest` (since VoiceCommon
  0.16.1, after the goodbye has finished playing; the app calls `stopSession`
  from that callback, so on earlier versions most of the goodbye was cut off).
  VoiceCommon's replay tests cover that timing; no test in this repository
  plays audio.
- **The signed-in path end to end.** A real user signing in, the
  `mintGeminiLiveToken` callable checking the allow-list and returning a
  token, and the browser opening a session with it is not run by any automated
  test. What is covered: the token request the callable sends (offline), a
  token minted with that exact request opening the production session (live),
  and the config the hook produces (offline). What is not: Firebase Auth, the
  allow-list check in `functions/src/auth.ts` (no unit tests), the callable's
  deployment and its access to the secret. An automated check would need a
  dedicated test user on the allow-list whose credentials a CI job can use,
  for example a Firebase custom token minted by a service account, calling the
  deployed callable and then running the kit's `setup` check with the returned
  token.
- **Real rooms.** Fixture audio is clean, synthetic speech. It shows that the
  settings reach the server and are obeyed. It does not reproduce room noise,
  echo, accents or hesitant speakers.
- Model output is not deterministic. Checks assert on structure (events, word
  matches, a number in a reply) and each live test retries once.
