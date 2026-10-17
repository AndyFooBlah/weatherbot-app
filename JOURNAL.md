# weatherbot-app — project journal

Append-only. Every entry starts with a UTC timestamp and a tag
(`[step] [decision] [friction] [learning] [surprise] [incident] [idea]
[milestone]`). Never edit or delete a past entry; correct by appending
a new entry that names the earlier one's timestamp. Synced daily to
`andy-private-docs/journals/`.

Entries up to 2026-10-16 were backfilled on 2026-10-16 from git
history, GitHub issues, and Claude session transcripts; timestamps are
anchored to commits/issues where available, else day-accurate.

---

- 2026-07-10T17:09Z [milestone] Repo created: mobile-first voice frontend on Gemini Live via @andyfooblah/voice-common; tools fetched live from the weatherbot toolbox (b2d8515).
- 2026-07-20T05:39Z [step] Prompt taught to record/recall events (5087782) — pairs with weatherbot's events table.
- 2026-07-21T05:08Z [learning] The time-correctness saga, five owner-reported field failures in four days, each pinned later as a permanent eval case: "9pm tonight" recorded a day late → deterministic resolve tool (e43b5ec, fd055dc); AM/PM flips reading results back → *_local speech fields (930a126); off-by-one "yesterday" built from improvised windows → day windows + wider grammar (1c1064e); "9pm yesterday" labeled wrong relative day → (today)/(yesterday) markers (a8edf69). Governing lesson: the model gets NO date arithmetic, in either direction.
- 2026-07-21T04:14Z [step] Hand-rolled timeResolver with 88 (later 100) tests (25d5e0d) — superseded ten hours later by nl2time; the tests seeded nl2time's consumer-side regression suite.
- 2026-07-21T19:06Z [milestone] nl2time adopted (8090388): client-side resolve_time / describe_time tools; prompt collapsed to the TWO TIME LAWS (words in via resolve_time; timestamps out via describe_time). Knobs: bias 'past', casual describe style.
- 2026-07-22T18:00Z [decision] Hardening phase plan approved. Owner: eval DB on same instance "fine"; on-demand eval runs, "don't need nightly"; "We can definitely defer audio evals… my main focus is data correctness. I am much less concerned about security hardening, audio quality, tone/style."
- 2026-07-22T18:30Z [decision] Owner on framework choice: "I'm more in favor of agentevals as a framework (part of LangChain) than promptfoo (now owned by OpenAI)" — and EvalBench to be judged by code, not README. Stack landed: vitest + agentevals trajectory matching + openevals (available) + custom SQL-ground-truth graders; EvalBench for the ask_data layer only.
- 2026-07-22T19:00Z [decision] No second text-only app. A text chatbot would run a different model, so its evals wouldn't validate the voice bot; the headless driver IS the text mode (same brain, no UI). Prompt layered core/voice/text to keep the option open. Recorded on #21.
- 2026-07-23T01:16Z [milestone] P0 (#21): agent core extracted to src/agent/ (zero browser imports, SPA + harness share it), voice prompt pinned BYTE-FOR-BYTE by snapshot test, headless Live driver runs the exact prod config from Node (88f2cb7). First headless transcript executed both time laws correctly.
- 2026-07-23T01:23Z [surprise] The npm type-check script had been vacuous forever: solution-style tsconfig with `files: []` means plain `tsc --noEmit` checks NOTHING. Fixed to tsc -b; real pre-existing errors surfaced and fixed (424b6f6, #23).
- 2026-07-23T16:32Z [milestone] Corpus v1: 24 cases (#22), iterated against two live runs (916af88). First-run shakedown found: one REAL bug (nl2time#9, "8 this morning" → 6am — filed upstream, the discovery-to-regression-gate loop closed at 4bef857 with 24/24 on nl2time 0.1.1); one case where the agent was right and the case wrong ("last week" = calendar week); empty-window cases redesigned so missing data demands a spoken disclosure, never fabrication. [learning] Live-model variance is real: retry:1 per case; failing twice is the defect signal.
- 2026-07-23T22:57Z [step] Estimates prompt guidance shipped (f9dea3f); estimates eval cases landed after the gap-fill rollout — corpus 26/26 (be62750). Cases find their target day dynamically so they survive re-seeds.
- 2026-07-25T05:54Z [milestone] Corpus growth from REAL data: 269 utterances mined from 64 recorded session transcripts → 8 new cases → THREE production bugs found on first contact (2a63ab7): (1) backyard→Outdoor alias missing — bot falsely claimed "no data for the outside area"; (2) no ASR-noise handling — bot played along with garbled cross-talk; (3) the subtlest bug of the phase: "last week" meant THREE different windows (Sun–Sat in nl2time's en-US default, Mon–Sun per the prompt's own words, Mon-start date_trunc in QueryData SQL) → wrong day-counts. Fixed: prompt vocabulary + noise rules, weekStart:'mon' pinned, ask_data TIME RULE (embed resolved UTC bounds in query text). Corpus 34/34.
- 2026-07-25T06:00Z [learning] Transcript mining beats synthetic case design: all three bugs above came from phrasings no grid would have produced ("office work order have the asset number" was literal cross-talk from a real session).
- 2026-09-11T05:03Z [step] Eval fixture provenance recorded; dependency bumps; verbatim Apache-2.0 license shipped (6fddabd, 5eed499).
- 2026-09-19T18:36Z [milestone] Live sessions moved to gemini-3.8-live, stable, same price (880732f). Gotcha captured in global memory: 3.8-live REJECTS thinkingConfig; a bare model-id swap closes the socket with 1007.
- 2026-10-16T20:30Z [step] Journal created per new global journal policy; backfilled from git history, issues #20–#23, and session transcripts.
