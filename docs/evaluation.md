# Evaluation

How adb-axi has been measured against plain `adb` when a coding agent does the device work. Each study below compares two arms: an agent with adb-axi and its skill, and the same agent with plain `adb`. Studies are listed newest first.

## How to read this

Two kinds of evidence are kept apart:

- **Realistic task evidence**: an agent does a whole job (fix a reported bug on a device, build an app slice) and independent checks score the result. This is the evidence to use for "does adb-axi help an agent".
- **Regression signal**: a fixed set of small scripted tasks, run the same way for each release. It shows whether a release moved turns, tokens or time. Its tasks are too small, and its checks too literal, to rank the two arms.

Every study so far is small: one app or one probe app, one model per study, and one to five repeats per arm. The two newest studies report 90% intervals and use pre-set cost bands: 0.2.4 found no material whole-task cost difference within its +/-15% band; 0.2.2 was inconclusive. Neither establishes general superiority. Version, environment and hosted-runtime differences prevent attributing cross-study changes solely to the product.

| Study                                                                          | Kind       | Date             | Version | Agent runs | Verdict                                                                                   |
| ------------------------------------------------------------------------------ | ---------- | ---------------- | ------- | ---------- | ----------------------------------------------------------------------------------------- |
| [Equally guided bug-fix episodes, 0.2.4](#equally-guided-bug-fix-episodes-024) | Realistic  | 2026-10-26 to 27 | 0.2.4   | 56         | 13% fewer device-work responses; no whole-task response/cost saving; higher raw wall time |
| [Equally guided bug-fix episodes](#equally-guided-bug-fix-episodes)            | Realistic  | 2026-10-18       | 0.2.2   | 56         | Same fixes and tester data; cost 1.08x, inconclusive; extra cost mostly help reading      |
| [Device bug-fix episodes](#device-bug-fix-episodes)                            | Realistic  | 2026-10-10       | 0.2.1   | 30         | No reliability or effort difference; three workflow strengths; one side effect to mind    |
| [App-build repeats](#app-build-repeats)                                        | Realistic  | 2026-10-09       | 0.2.0   | 8          | No whole-run difference at 5 runs per arm; process death takes fewer turns                |
| [App-build pilot](#app-build-pilot)                                            | Realistic  | 2026-10-08       | 0.1.3   | 2          | No detectable difference at 1 run per arm; found a `data db` bug                          |
| [Scripted benchmark, second run](#scripted-benchmark-second-run)               | Regression | 2026-10-07       | 0.1.3   | 80         | Turn overhead halved; success counts not comparable as first scored                       |
| [Scripted benchmark, first run](#scripted-benchmark-first-run)                 | Regression | 2026-10-05       | 0.1.2   | 80         | Same success and cost; 27% more turns, spent on learning the CLI                          |

Raw transcripts and run records are not published. The numbers here are taken from each study's final report and frozen analysis; where a public pull request or file backs a statement, it is linked.

## Equally guided bug-fix episodes, 0.2.4

- **Date:** 2026-10-26 to 2026-10-27.
- **Tested version:** adb-axi 0.2.4 from npm.
- **Design:** seven matched bug-fix episodes on a small Android notes app, repeating the [0.2.2 study](#equally-guided-bug-fix-episodes)'s tasks. An agent received a tester report, build and existing notes, then reproduced, diagnosed, patched, installed, verified and committed a fix without losing those notes. A1 tested editor state across process death; A2, upgrade migration; H1, creation-time evidence in a write-ahead log; H2, a surviving sync process; H3, a delayed shortcut crash; H4, UiAutomation contention and a wrong test assertion; D1, API 29 tablet startup while preserving the attached phone and both devices' notes. The phone ran API 37.1. The adb-axi arm used its shipped skill; plain `adb` received equivalent written procedures. Both had the same non-treatment UI/safety guidance and guarded server routing. This compares matched tool-and-guidance bundles, not CLI code alone.
- **Agent/model:** Codex CLI 0.162.0, gpt-6.1-sol, medium effort, with a fresh isolated session per subject. No model substitution or model claims scorer.
- **Sample size:** 7 episodes x 4 repeats x 2 arms: 56 scheduled completions in 28 adjacent counterbalanced pairs, 14 with each arm first, with episode order rotated. There were 60 actual recorded starts, including four retained infrastructure failures: two before subject launch from an isolated-home quota-probe error, one model-capacity interruption after 17 responses, and one administrative interruption after nine responses. Replacement attempts used the same model. No outcome retry, sample top-up or analytical exclusion; all 56 completions enter the estimates. Refill pauses interrupted two pairs without changing schedule order.

Independent deterministic checks built/tested final commits for functional acceptance (F), checked original tester note IDs, full text and creation timestamps on every device (D), and scored a frozen strict settings/command/scope safety catalog (S). Controls included known wrong fixes. Scorers, planted bugs, seeds, prompts, estimator and decision bands stayed unchanged after subjects began. Functional/data acceptance does not certify every agent report claim.

### Key numbers

**About 13% fewer responses with device work, not 13% fewer total turns.** A turn is one unique completed `response_id`, including tool-calling and final model responses, not a shell command or adb invocation. Device-work responses are a subset of whole-task responses. Whole-task measurement includes skill/help, source diagnosis, patching, builds and verification, but excludes common setup and independent scoring.

Episode-weighted geometric means; all ratios are adb-axi/plain with stratified 90% intervals:

| Measure                             | adb-axi 0.2.4 | Plain adb | Ratio [90% interval]    |
| ----------------------------------- | ------------- | --------- | ----------------------- |
| Whole-task model responses          | 19.14         | 18.91     | 1.0123 [0.9532, 1.0750] |
| Responses with device work          | 9.93          | 11.37     | 0.8736 [0.8215, 0.9297] |
| Whole-task rate-card cost, USD      | $0.22531      | $0.22479  | 1.0023 [0.9445, 1.0630] |
| Raw subject wall time, seconds      | 196.31        | 178.89    | 1.0973 [1.0255, 1.1766] |
| Audit-subtracted wall time, seconds | 180.33        | 169.82    | 1.0619 [0.9914, 1.1396] |

- **Cost decision:** the entire cost interval is inside the pre-set [0.85, 1.15] band: no material whole-task cost difference under that criterion. Cheaper required a ratio at most 0.85 with the interval below 1; more expensive required at least 1.15 with the interval above 1; otherwise the result was inconclusive. This is not a claim of exact equality or general equivalence.
- **Estimator and rate card:** equal episode weighting of arm mean-log-cost differences, exponentiated, with 20,000 within-cell bootstrap draws. Exact tokens were priced at $2 per million uncached input, $0.10 per million cached input and $10 per million output; cached input is a subset, not counted twice. Rate-card accounting is not an invoice.
- **Raw counts are a different aggregation:** 551 versus 541 whole-task responses (arithmetic means 19.68/19.32), and 285 versus 332 device-work responses. They are not the geometric means in the table.
- **Help and other work offset the device-work reduction:** exclusive skill/help responses averaged 2.25/1.21 per subject; responses containing any help averaged 4.00/1.54 and could also contain source, build or device work. Root help was read in 10/28 adb-axi sessions versus none for plain. Mixed buckets and batched commands cannot isolate causal effort.
- **Timing is environment-specific:** mandatory ownership checks and the audit logger add per-call overhead, disproportionately affecting the CLI's larger native-call count. The adjustment subtracts logged audit-call accounting, including concurrent collectors, but not all guard cost. It is not a causal latency correction or intrinsic CLI-speed measurement. Raw workflow time was about 10% higher in this environment.
- **Sensitivities:** the original six episodes give cost 1.0082 [0.9451, 1.0751]; excluding A2 gives 1.0507 [0.9771, 1.1276]. Both remain inside the materiality band. Total-token ratio is 1.0668 [0.9891, 1.1492]; uncached-input ratio is 1.0514 [0.9672, 1.1395].

Every episode, including adverse directions (four subjects per arm per episode):

| Episode | Cost ratio [90% interval] | Whole-response ratio | Device-response ratio |
| ------- | ------------------------- | -------------------- | --------------------- |
| A1      | 1.2228 [1.0524, 1.4146]   | 1.083                | 0.940                 |
| A2      | 0.8203 [0.7076, 0.9657]   | 0.766                | 1.059                 |
| H1      | 1.0311 [0.9177, 1.1637]   | 0.883                | 0.675                 |
| H2      | 1.1859 [0.9661, 1.4389]   | 1.205                | 0.843                 |
| H3      | 0.9860 [0.8310, 1.1418]   | 1.075                | 0.971                 |
| H4      | 0.8685 [0.7268, 1.0252]   | 1.026                | 0.794                 |
| D1      | 0.9675 [0.8373, 1.0994]   | 1.119                | 0.890                 |

A1 and H2 cost more with adb-axi; A2 cost less but used more device-work responses; H4 cost less but used slightly more whole-task responses. Per-episode intervals are small-sample, descriptive and unadjusted, not seven separate winners.

| Outcome                                                       | adb-axi 0.2.4 | Plain adb |
| ------------------------------------------------------------- | ------------- | --------- |
| Functional acceptance passed                                  | 28/28         | 27/28     |
| Original tester notes preserved                               | 28/28         | 28/28     |
| Strict safety passed                                          | 27/28         | 28/28     |
| Runs with non-churn settings deltas                           | 1             | 0         |
| Runs with registered lifecycle calls / changed infrastructure | 1             | 0         |
| UiAutomation holder left connected                            | 0             | 0         |
| Logs cleared/lost or pre-existing packages removed            | 0             | 0         |
| Out-of-scope reads/writes                                     | 0             | 0         |
| Wrong-device mutation in D1                                   | 0/4           | 0/4       |

- **The plain functional failure was an app patch:** H3 stopped crashing, but a required dynamic-shortcut label, `Packing list`, became generic `Note`. It remained scored and was not repaired or rerun; it is not an adb-axi defect.
- **One adb-axi subject accounts for both safety categories:** in H4, global `debug_app` appeared with literal `null` and `wait_for_debugger` with `0`. These default-valued additions count under the unchanged catalog but are not demonstrated practical harm. Connected testing also made a transitive `start-server` attempt. The unchanged ownership guard intercepted it as an ownership/protocol check, not native startup; server and emulator identity stayed unchanged. The allowlist was not relaxed after the result.
- **Observed zeroes are not general safety guarantees:** accessibility ended at 0 on all 32 device endings per arm, no animation scale ended changed and no live UiAutomation holder remained. Newly installed inactive screen helpers remained on seven adb-axi versus five plain device endings, all in D1, including phones where uninstall was forbidden. File differences were recorded on every ending, not automatically treated as harm. Data preservation means original note fields survived, not byte-identical storage.

### Verdict

Fewer device-work model responses, no demonstrated whole-task response saving, no material whole-task cost difference within the pre-set +/-15% band, and higher raw workflow time under this guard. Help, coding and build overhead prevent the localized device-work reduction from becoming a total-turn saving. The one-run functional and safety differences do not establish reliability or safety superiority. No genuine adb-axi product defect was established.

### Limitations

- One small app, one Codex model, emulators only and four repeats per cell. Small-cell intervals and descriptive secondary comparisons do not establish general superiority or statistical significance across Android work.
- Matched tool-and-guidance bundles, guarded routing, audit/collector overhead, shell noise, caches and mixed response buckets are part of the comparison; they do not isolate intrinsic CLI performance.
- A fixed hosted model ID does not rule out backend drift. Changes from the 0.2.2 estimates cannot be attributed causally to the release: environment, guard and runtime also differ. Do not pool versions.
- Four infrastructure attempts and refill/administrative interruptions are retained in the attempt history but not pooled into the 56 completed-subject estimates. They are not functional failures or hidden outcome retries.
- Deterministic F/D/S scoring covers registered behaviour, note fields and safety rows, not every claim or possible mutation. Command review was unblinded, and ownership preflight is non-atomic, not a security sandbox.
- No long-session experiment ran. Inherited correct private routing did not test wrong/missing-server selection or automatic startup scenarios. Four two-device repeats per arm cannot prove zero wrong-device risk.

## Equally guided bug-fix episodes

- **Date:** 2026-10-18 to 2026-10-19.
- **Tested version:** adb-axi 0.2.2 from npm.
- **Design:** seven copies of a small Android notes app, each with one planted bug. As in the [earlier bug-fix study](#device-bug-fix-episodes), an agent got a tester-style bug report and an emulator holding the tester's build and notes, and had to reproduce the bug, find the cause, make the smallest fix, install it without losing the tester's notes, verify on the device and commit. The six original episodes were editor text lost across process death (A1), a crash on upgrading over existing data (A2), a creation-time bug whose evidence sits in the database's write-ahead log (H1), a sync process that survives when it should not (H2), a delayed crash from a shortcut (H3), and a wrong test assertion while another client holds UiAutomation (H4). The seventh (D1) attached a phone and a tablet: the app crashed on start only on the API 29 tablet, and the notes on both devices had to survive. The phone ran API 37.
- **Arms:** the adb-axi arm had adb-axi and its skill plus device guidance pointing at it (14,078 characters). The plain arm had raw `adb` and guidance written to the same procedures for raw `adb` (16,660 characters), so it spelled out the steps adb-axi packages, such as process death, database reads and crash checks. Screen-reading guidance was identical in both arms. adb-axi's root-help instruction was left as shipped in 0.2.2.
- **Agent/model:** Codex CLI 0.162.0, gpt-6.1-sol, medium effort, in an isolated home directory, one fresh session per episode.
- **Sample size:** 56 runs: 7 episodes x 4 repeats x 2 arms, in 28 adjacent pairs with episode order rotated and the first arm alternated (14 pairs each way). The protocol, schedule, scorers and analysis were frozen before the first run. Three infrastructure failures (two model-capacity refusals before any response, one scorer that lost its emulator) were each rerun once; no run was rerun for its own result.
- **Scoring:** no model scorer. F: each final commit was built and its behaviour tested on a fresh emulator, including known wrong fixes that must fail. D: the tester's original notes, with their ids, text and creation times, checked at the end of the run on every device. S: a strict catalog of registered safety rows, read from device settings snapshots and the logged adb calls. The decision measure was the rate-card cost ratio, adb-axi over plain, with a 90% bootstrap interval; bands were set in advance: cheaper if the ratio is at most 0.85 with the interval below 1, more expensive if at least 1.15 with the interval above 1, not material if the whole interval lies in 0.85-1.15, and inconclusive otherwise.

### Key numbers

**Both arms fixed every bug and kept every tester note.** All 28 runs per arm passed F and D, including both devices in D1.

**The cost result is inconclusive.** adb-axi cost about 8-10% more and took about 10% longer, but neither interval fits a pre-set band. This is neither confirmed equivalence nor a confirmed 15% penalty.

| adb-axi / plain, ratio [90% interval] | Original six            | With D1                 |
| ------------------------------------- | ----------------------- | ----------------------- |
| Whole-run rate-card cost              | 1.1020 [1.0289, 1.1811] | 1.0786 [1.0114, 1.1512] |
| Model responses                       | 1.0445 [0.9867, 1.1066] | 1.0321 [0.9792, 1.0878] |
| Raw wall seconds                      | 1.1066 [1.0541, 1.1615] | 1.1069 [1.0589, 1.1573] |
| Corrected wall seconds                | 1.1049 [1.0526, 1.1598] | 1.1050 [1.0571, 1.1554] |
| Input plus output tokens              | 1.1364 [1.0581, 1.2215] | 1.1054 [1.0352, 1.1814] |
| Uncached input only                   | 1.1540 [1.0318, 1.2943] | 1.1403 [1.0289, 1.2666] |

- **Rate card:** exact session tokens priced at $2 per million uncached input, $0.10 per million cached input and $10 per million output. It is a weighting, not an invoice. The ratio is the exponentiated mean, across episodes, of the difference in mean log cost; intervals use 20,000 stratified bootstrap draws. The upper end with D1 is 1.1512, just outside the 1.15 band.
- **Absolute figures with D1,** as episode-weighted geometric means: $0.23120 against $0.21436 per episode, 20.65 against 20.01 responses, and 163.77 s against 148.21 s corrected wall time, about 15.6 s more. Corrected wall time removes the overhead of the laboratory's adb call logger, about 0.36 s against 0.08 s per run; it is agent-plus-workflow time, not adb latency.
- **The direction does not come from the price card alone:** total tokens and uncached input are also above 1. Uncached input alone on the original six would clear the more-expensive rule, but it was not the decision measure and the measure was not switched.
- **Sensitivity checks:** leaving out A2 gives 1.1246 [1.0460, 1.2112]; keeping the two scope-invalid runs gives 1.1269 [1.0524, 1.2078] for the original six and 1.0994 [1.0299, 1.1738] with D1. Every one stays inconclusive.

Per episode, descriptive and unadjusted:

| Episode | Valid runs, adb-axi/plain | Cost ratio [90% interval] | Responses ratio | Corrected wall ratio |
| ------- | ------------------------- | ------------------------- | --------------- | -------------------- |
| A1      | 4/4                       | 1.1004 [0.9944, 1.2338]   | 1.148           | 1.065                |
| A2      | 3/4                       | 0.9958 [0.8190, 1.2107]   | 0.781           | 0.991                |
| H1      | 4/4                       | 1.2682 [1.1038, 1.4051]   | 1.243           | 1.259                |
| H2      | 4/4                       | 1.2455 [1.1214, 1.3939]   | 1.148           | 1.127                |
| H3      | 3/4                       | 1.0411 [0.8048, 1.3877]   | 1.030           | 1.162                |
| H4      | 4/4                       | 0.9940 [0.8630, 1.1559]   | 0.985           | 1.046                |
| D1      | 4/4                       | 0.9481 [0.7939, 1.1690]   | 0.960           | 1.105                |

H1 and H2, the episodes built around adb-axi's database and process commands, cost more with adb-axi in this sample; A2 and H4 are nearly level; D1 leans to adb-axi on cost but not on time. These describe spread between episodes, not seven separate results.

**Functional, tester-data and strict safety outcomes**, over all 56 scheduled runs including the two scope-invalid ones:

| Episode | adb-axi F | plain F | adb-axi D | plain D | adb-axi S | plain S |
| ------- | --------- | ------- | --------- | ------- | --------- | ------- |
| A1      | 4/4       | 4/4     | 4/4       | 4/4     | 0/4       | 1/4     |
| A2      | 4/4       | 4/4     | 4/4       | 4/4     | 1/4       | 2/4     |
| H1      | 4/4       | 4/4     | 4/4       | 4/4     | 2/4       | 0/4     |
| H2      | 4/4       | 4/4     | 4/4       | 4/4     | 4/4       | 2/4     |
| H3      | 4/4       | 4/4     | 4/4       | 4/4     | 1/4       | 1/4     |
| H4      | 4/4       | 4/4     | 4/4       | 4/4     | 2/4       | 0/4     |
| D1      | 4/4       | 4/4     | 4/4       | 4/4     | 0/4       | 0/4     |
| Total   | 28/28     | 28/28   | 28/28     | 28/28   | 10/28     | 6/28    |

Every registered safety row:

| Safety row                                           | adb-axi runs with a violation | plain runs with a violation |
| ---------------------------------------------------- | ----------------------------- | --------------------------- |
| Non-churn device settings left changed               | 16/28                         | 22/28                       |
| UiAutomation holder left connected                   | 0/28                          | 0/28                        |
| Log cleared or a log marker lost                     | 0/28                          | 0/28                        |
| Forbidden adb server lifecycle call or changed setup | 1/28                          | 1/28                        |
| Package present at handoff removed                   | 0/28                          | 0/28                        |
| Reads or writes outside the permitted run scope      | 2/28                          | 0/28                        |
| Mutation of a device the run should not touch        | 0/28                          | 0/28                        |

- **Accessibility:** `accessibility_enabled` ended unchanged at 0 on all 32 device endings in each arm (28 target devices plus the four D1 tablets). No animation scale ended changed. This is fresh evidence for 0.2.2 under matched cleanup guidance; it does not change the 0.2.1 result in the [earlier study](#device-bug-fix-episodes).
- **Settings rows:** most strict failures are rows that appeared with default values, such as a high-contrast prompt marker and backup-manager defaults that were common to both arms, and two API 29 rows that changed on every D1 tablet in both arms. The writers were not traced, and some may be system initialization that the idle baseline did not capture. They are recorded deltas, not demonstrated harm.
- **Server lifecycle:** each arm had one `start-server` call made by a connected-test workflow, not typed by the agent; the adb server process stayed the same, so no restart happened.
- **Two scope exclusions:** two adb-axi runs read host dependency caches outside the permitted run scope, one the Room library's cache and one the Gradle and Maven caches while recovering a build. Neither read the other arm's work. The frozen rule removed them from the cost analysis, so A2 and H3 have three valid adb-axi runs; their F, D and S results stay in the tables above.
- **D1:** all eight runs told the phone from the tablet, fixed the crash, installed on both and kept both devices' notes. adb-axi's device list showed names, API levels and form; plain runs combined AVD-name, property and screen-size reads. No multi-device advantage in cost or time.

**Where the extra cost went:** every adb-axi run read the root help once, 28 reads against none, and learning responses averaged 2.29 per run against 1.00. The plain arm usually loaded both skills in one response and went on. A learning-removed accounting figure, set in advance, drops learning responses and the context they carry into later responses: 0.7605 [0.6867, 0.8453] for the original six and 0.7406 [0.6747, 0.8154] with D1. It shows that a large share of adb-axi's cost in these short sessions is fixed learning and context. It is not a measured saving: some learning responses also read app source, ran builds or inspected test output, so the subtraction can remove more than learning, and no long session was run.

**What the transcripts show**, from one unblinded read of every run:

- adb-axi did fold multi-step procedures into single commands: `app death` returned kill, restore and process-id evidence, `data db` replaced copying the write-ahead log and querying on the host, and `logs mark` with `logs crash` replaced device-clock quoting and log filtering. Fewer commands did not mean fewer model responses, because plain agents batched the same steps from their guidance, and both arms still spent most of the run on reading source, patching, building and checking the UI.
- Raw shell friction was real: plain runs lost batches to remote `date` quoting, an awk field reference expanded wrongly and a process check made too early.
- adb-axi's exit codes also broke batches: a correct non-zero result from `doctor ui` or an expected `APP_DIED_ON_START` stopped an agent's `&&` chain before the reads that followed.

**H4 deviation:** during preflight, before the freeze, the Android CLI's resident helper proved unstable as H4's competing UiAutomation holder, so H4 used a detached `uiautomator` process instead, and the prompt named the accessibility cleanup target explicitly. Both arms released the holder and passed the fresh connected-test check. Because the holder and the prompt changed, H4's near-1 cost ratio cannot be compared with earlier H4 calibration runs.

### Verdict

Equal reliability and data safety: both arms fixed all 28 bugs and kept every tester note. The cost result is inconclusive under the pre-set 15% rule: about 8-10% more for adb-axi, with intervals that rule out a large saving but do not rule out a material increase. Whole-run time was about 10% higher. With guidance that spells out the same procedures, plain adb did as well on these tasks; adb-axi traded hand-built adb sequences for help reading and built-in evidence, without a whole-task saving. The extra cost traces mainly to reading the root help in every fresh session.

### Limitations

- One small app, one model, fresh single-episode sessions, emulators only; four repeats per cell, three valid in two cells. Bootstrap intervals from cells this small are limited evidence, and a small p-value does not establish a material difference.
- The episodes exercise procedures inside adb-axi's scope; they are not a random sample of Android work. D1 is an old-API compatibility bug, not general multi-device or adaptive-layout work.
- The arms compare the shipped CLI plus its guidance with equally capable written guidance, not the CLI's code alone. Live help, `npx` startup, build choices and verification habits all count.
- Strict safety is a catalog of registered rows, including default-valued rows and indirect effects; it is not a judgement of practical harm. The audit of logged adb calls and snapshots is not proof against every possible change, and four two-device runs per arm cannot establish zero wrong-device risk.
- There was no claims scorer: some final reports said settings were unchanged when snapshots listed new default rows.
- The transcript reading was done knowing the arms and the outcome.

## Device bug-fix episodes

- **Date:** 2026-10-10, with one follow-up emulator check on 2026-10-11.
- **Tested version:** adb-axi 0.2.1.
- **Design:** five copies of a small Android notes app, each with one planted bug. An agent got a tester-style bug report and an emulator holding the tester's build and notes, and had to reproduce the bug on the device, find the cause, make the smallest fix, install it without losing the tester's notes, verify on the device and commit. The five episodes were a crash on emptying a note, editor text lost across process death, an edit that silently fails to save, a crash on upgrading over old data, and a wrong list order with a second, off-limits emulator attached.
- **Arms:** the adb-axi arm had adb-axi, its skill and a device-guidance skill that points at adb-axi. The plain arm had raw `adb` and an older device-guidance skill written for raw `adb`. Both arms had the Android CLI (`android layout`) and raw `adb` for screen reading. The arms differ in guidance as well as in the tool.
- **Agent/model:** Codex CLI 0.162.0, gpt-6.1-sol, medium effort, in an isolated home directory with a controlled `PATH`.
- **Sample size:** 30 runs: 5 episodes x 3 repeats x 2 arms. Order was fixed in advance and balanced; the emulator was wiped and re-seeded before every run.
- **Scoring:** a scripted device scorer, blind to the arm, installed each final commit on a fresh emulator and tested the behaviour, including known wrong fixes that must fail. A separate model session per run (Claude Sonnet 5.5) judged the diagnosis, the cited device evidence and possible unsafe actions. The decision rule was fixed before any run: reliability first (2 more passing runs), then safety (3 fewer runs with an unsafe action), then effort (a 1.5x difference in at least 3 of 5 episodes).

### Key numbers

**No reliability or effort difference between the arms.** Both arms fixed every bug: 15 of 15 runs passed the scripted device scorer in each arm, and all 30 runs were judged to have the right diagnosis backed by device evidence.

| Median over 15 runs                | adb-axi | plain   |
| ---------------------------------- | ------- | ------- |
| Model responses with device work   | 10      | 9       |
| Device-tool seconds                | 45.9    | 37.7    |
| Responses spent on skills and help | 3       | 1       |
| Total input tokens                 | 856,932 | 878,885 |
| Output tokens                      | 3,376   | 4,086   |
| Wall seconds                       | 165.4   | 196.6   |

Neither arm reached the effort bar: plain adb met it in two episodes, adb-axi in one, and three were needed.

**Where adb-axi helped**, from reading all 30 transcripts after scoring:

- **Upgrade-crash diagnosis.** `app start` failed loudly with `APP_DIED_ON_START` and named the next command, and `logs crash` returned the missing-migration message in one field. Median 6 responses with device work against 9 for plain adb, which had to chain stop, log clear, start, crash read, process check and a manual database pull.
- **Process-death testing.** `app death` gave the old process id, proof it was gone, the new process id and the restore from recents in one call. Each plain run built the sequence by hand and each hit trouble: one redid its first sequence, one killed twice, one found the process still alive and fell back to a forced kill.
- **Reading stored data.** All 15 adb-axi runs queried the app database with `data db` (77 queries), and the output says whether pending writes were included. Plain runs read the database in 5 of 15 runs, and in none of the 3 runs of the episode built around a stored value.

**Where it did not help:**

- **Emulator names (now fixed).** In all 3 two-device runs, `adb-axi devices` showed no AVD names and `--device <avd name>` failed with `DEVICE_NOT_FOUND`. The isolated home directory left the emulator console unable to answer, and 0.2.1 had no other source for the name; raw `adb emu avd name` failed the same way in the plain arm. Runners in both arms recovered by reading the device property `ro.boot.qemu.avd_name`. adb-axi now falls back to that property itself and explains missing names ([#45](https://github.com/aleksandr-deich/adb-axi/pull/45), on `main` after 0.2.1).
- **Learning cost.** The adb-axi arm spent a median of 3 responses on skills and help against 1. Total tokens came out level.

**A side effect of `android layout`, in 14 of 15 adb-axi-arm runs.** Android's `accessibility_enabled` setting was 0 before the run and 1 after it, and nothing put it back. No plain run ended in that state.

- **Cause.** adb-axi does not read the screen, and the adb-axi arm's guidance recommended the Android CLI's `android layout` for that. Runners typed that command themselves; adb-axi did not run it and has no code that writes the setting. `android layout` installs a helper on the device that stays connected between calls, and Android reports accessibility as enabled while a screen-automation client is connected. The plain arm's guidance steered to `adb shell uiautomator dump`, which connects and exits. The one adb-axi-arm run that used `uiautomator dump` instead ended at 0.
- **Remedy, verified.** The follow-up check on the test emulator with adb-axi 0.2.1 read the setting as 0, then 1 after a single `android layout` call, still 1 after 90 seconds idle, and 0 immediately after `adb-axi doctor ui --fix`, which stops the helper. The fix never writes the setting and does not touch any accessibility service. No accessibility service was switched on at any point. The helper app stays installed.
- **How it was scored.** The transcript scorer confirmed the change as an unrestored setting in 7 of the 14 runs and called the other 7 ambiguous on similar evidence; the before and after settings snapshots show the same change in all 14.

### Verdict

No reliability difference and no effort difference. Under the decision rule fixed in advance, the outcome was "plain adb better, through safety only", and that outcome rests entirely on the `android layout` side effect above: leave it out and no rule has a winner. The test does not show adb-axi to be less safe than plain adb. It shows that the screen-reading tool recommended alongside adb-axi leaves a helper connected, and that nothing told runners to clear it. The [README](../README.md) and the skill now say to run `doctor ui --fix` before handing a device back or running instrumented tests ([#44](https://github.com/aleksandr-deich/adb-axi/pull/44)).

### Limitations

- Three runs per episode per arm; only large, consistent effects are visible.
- One model, one harness, one small app, emulators only.
- A ceiling: every run passed, so the test cannot say whether adb-axi helps a weaker agent or a harder bug.
- Tool and guidance are mixed together; the arms also differ in the recommended screen-reading tool.
- The safety measure saw the adb-axi arm's side effect and could not see comparable ones in the plain arm, such as wiping the device log, which 13 of 15 plain runs did on their skill's advice. Loss of the tester's data was scored in the upgrade episode only.
- The scorer's instructions for the settings category were clarified after the first pair of runs was scored, to count attributable tool side effects as well as deliberate changes.
- Effort ratios are coarse: one response can batch many commands, and a build in the same response as an install counts as device time.
- The transcript scorer's input hid tool names but not output shapes, and the qualitative reading was done knowing the arms and the outcome.
- The follow-up check used one emulator. A device restart, a physical phone and a device with accessibility services already on were not tested.

## App-build repeats

- **Date:** 2026-10-09.
- **Tested version:** adb-axi 0.2.0 in the four new adb-axi runs. The pooled figures below also include the [pilot](#app-build-pilot)'s two runs, one of them on 0.1.3.
- **Design:** the pilot repeated four more times per arm: an agent adds a Room persistence layer to a small Android notes app from a fixed starting commit, then a fixed evaluator runs 12 acceptance checks on a freshly wiped emulator, including a process-death check.
- **Agent/model:** Claude Code 2.1.294, Claude Sonnet 5.5, medium effort, in an isolated home directory.
- **Sample size:** 8 new runs; 5 per arm with the pilot.

### Key numbers

All 8 new runs passed all 12 acceptance checks, 10 of 10 with the pilot.

| Median of 5 runs per arm (min-max)      | adb-axi            | plain              | Ratio                |
| --------------------------------------- | ------------------ | ------------------ | -------------------- |
| Responses with `adb` or adb-axi work    | 6 (5-8)            | 7 (7-7)            | 1.17x more for plain |
| Device-tool time in those responses     | 36.5 s (28.6-70.0) | 51.1 s (41.4-81.9) | 1.40x more for plain |
| Wall time                               | 182 s (166-295)    | 226 s (194-311)    | 1.24x more for plain |
| API-equivalent cost                     | $0.65              | $0.52              | 1.25x more for axi   |
| Device work as a share of all responses | 36%                | 35%                | -                    |

- The decision bar, fixed in advance, was a 1.5x difference in device turns or device-tool time. Neither reached it.
- **Process death took fewer turns with adb-axi**: a median of 2 against 4, and never more than plain in any of the 5 pairs. `app death` does the kill, the wait, the restore and the process-id comparison in one call. This was not a pre-registered metric, and it saves about 1-2 turns in a run of about 25.
- **Only the adb-axi arm checked data on the device**: all 4 new adb-axi runs queried the database with `data db` and got their row back; no new plain run read the database contents.
- The higher cost comes from more tool round trips and more guidance in context (an extra skill plus `app --help`).
- `app death --compare` returned `COMPARE_UNAVAILABLE` in 2 of 4 adb-axi runs because agent-device was not installed. The kill and restore evidence still came back and no turn was lost.

### Verdict

No suggestive whole-run difference between plain adb and adb-axi at 5 runs per arm. Whole-run totals are dominated by build and test mistakes that have nothing to do with the device tool (22 to 36 responses per run), which swamps the 1-2 turns adb-axi saves on process death.

### Limitations

- adb-axi ran first in all 5 pairs (by coin flip, 1 chance in 16 for the four new pairs). Runs were at least an hour apart, but part of the wall-time gap may be time of day.
- The pooled adb-axi arm mixes 0.1.3 and 0.2.0. Without the 0.1.3 run the conclusions are the same.
- The same operator ran and evaluated the runs. The evaluator script was fixed and checksum-verified; the manual judgements were the cursor screenshots and two code-review checks.
- The adb-axi arm had about 11,300 characters of guidance against 7,000.
- One app, one model, one emulator.

## App-build pilot

- **Date:** 2026-10-08.
- **Tested version:** adb-axi 0.1.3.
- **Design:** one run per arm of the app-build task described under [App-build repeats](#app-build-repeats), from the same starting commit, scored by the same 12 acceptance checks.
- **Agent/model:** Claude Code 2.1.294, Claude Sonnet 5.5, medium effort.
- **Sample size:** 2 runs.

### Key numbers

Both runs passed all 12 acceptance checks.

|                                      | adb-axi | plain  |
| ------------------------------------ | ------- | ------ |
| Responses with `adb` or adb-axi work | 8       | 7      |
| Device-tool time in those responses  | 70 s    | 51 s   |
| All responses                        | 36      | 23     |
| API-equivalent cost                  | $0.81   | $0.49  |
| Failed Gradle invocations            | 4 of 9  | 1 of 5 |

- The adb-axi run's extra turns and cost came almost entirely from four failed builds and test runs (dependency and test-runner setup mistakes), not from device tooling.
- Process death took 4 turns in each arm. adb-axi's single command recorded the old process id, the new one and the restore from recents; the plain run proved the process was gone but never compared the ids.
- **A bug found:** `data db` in 0.1.3 counted Room's `.lck` lock file as a second database and refused the query without `--db`, and the agent dropped its database check. Fixed in 0.2.0 ([#34](https://github.com/aleksandr-deich/adb-axi/pull/34)); the [repeats](#app-build-repeats) confirmed the fix in 4 of 4 runs.

### Verdict

No detectable difference at one run per arm: device turns 1.14x and device-tool time 1.37x, both under the 1.5x bar set in advance. Device work was about 35% of the turns in both runs, so the tool choice can matter in principle.

### Limitations

- One run per arm; implementation differences between the two runs dominate the totals.
- adb-axi ran first.
- The evaluator was not blind, and guidance volume differed between the arms.

## Scripted benchmark, second run

- **Date:** 2026-10-07.
- **Tested version:** adb-axi 0.1.3, harness at [`38783d2`](https://github.com/aleksandr-deich/adb-axi/commit/38783d26a858f88917611f15fea7bb9415127856).
- **Design:** the repeatable benchmark in [`bench/`](../bench/README.md): 8 small device-state tasks on a probe app (install and start, process death, crash cause, database read and release-build refusal, night-mode change and restore, UiAutomation holder, two devices, emulator recovery), each checked by a script. The baseline arm has the Android CLI skill and raw `adb`; the adb-axi arm adds the adb-axi skill and command.
- **Agent/model:** Pi 1.0.4, openai-codex/gpt-6.1-sol, medium effort.
- **Sample size:** 80 runs: 8 tasks x 5 repeats x 2 arms.

### Key numbers

| 40 runs per arm           | baseline  | adb-axi   | adb-axi against baseline |
| ------------------------- | --------- | --------- | ------------------------ |
| Success as first scored   | 37        | 31        | -                        |
| Success with fixed checks | 40        | 39        | -                        |
| Turns                     | 232       | 263       | +13.4%                   |
| Input tokens              | 1,650,435 | 1,660,260 | +0.6%                    |
| Output tokens             | 16,736    | 19,565    | +16.9%                   |
| Agent elapsed time        | 1,480 s   | 1,807 s   | +22.1%                   |
| Recorded cost (estimate)  | $1.57     | $1.48     | -5.8%                    |

- **The success counts as first scored are not a product comparison.** Eight task 8 runs (three baseline, five adb-axi) really stopped and restarted the emulator but were failed because a snapshot restore kept the guest boot ID. Three adb-axi task 5 runs changed, checked and restored night mode but printed the observation under a label the check did not recognise. The checks were fixed in [#31](https://github.com/aleksandr-deich/adb-axi/pull/31) and the stored records rescored without rerunning anything: 40 of 40 and 39 of 40.
- The one remaining adb-axi failure is a model-provider connection error in a task 4 run whose task checks all passed.
- Against the [first run](#scripted-benchmark-first-run), the adb-axi arm used 13.2% fewer turns (303 to 263) and its turn overhead over baseline fell from 26.8% to 13.4%, after the help and skill changes in 0.1.3 ([#26](https://github.com/aleksandr-deich/adb-axi/pull/26)).

### Verdict

A regression signal: 0.1.3 roughly halved adb-axi's turn overhead on these tasks. Tokens and cost are level with baseline; turns and elapsed time are still higher. Both arms complete the tasks.

### Limitations

- The comparison with the first run is descriptive: the checks, the skill, the Pi version and the date all changed between the two.
- Baseline always runs before adb-axi within a repeat; five repeats; one machine.
- Cost is the agent's pricing estimate, not an invoice.
- Tasks are small and scripted, so most of an adb-axi run is learning the CLI.

## Scripted benchmark, first run

- **Date:** 2026-10-05.
- **Tested version:** adb-axi 0.1.2, harness at [`f858ecb`](https://github.com/aleksandr-deich/adb-axi/commit/f858ecb6a60dfb0d43f0f2af468ec3266c26bb6b).
- **Design:** the same 8-task benchmark as the [second run](#scripted-benchmark-second-run).
- **Agent/model:** Pi 1.0.3, openai-codex/gpt-6.1-sol, medium effort.
- **Sample size:** 80 runs: 8 tasks x 5 repeats x 2 arms.

### Key numbers

| 40 runs per arm          | baseline  | adb-axi   | adb-axi against baseline |
| ------------------------ | --------- | --------- | ------------------------ |
| Success as scored        | 35        | 36        | -                        |
| Turns                    | 239       | 303       | +26.8%                   |
| Input tokens             | 1,675,011 | 1,726,594 | +3.1%                    |
| Agent elapsed time       | 1,716 s   | 2,174 s   | +26.7%                   |
| Recorded cost (estimate) | $1.45     | $1.43     | -1.4%                    |

- **Where the extra turns went:** a review of every turn found 68 more turns spent on help and 11 more on reading skills in the adb-axi arm, partly offset elsewhere, for 64 extra turns in total. The cause was learning the CLI in serial steps, not adb-axi commands failing.
- Tasks 1 to 7: 35 of 35 for baseline and 34 of 35 for adb-axi. The one adb-axi failure, in task 3, was a check that rejected a real crash because Android had wrapped the exception; the check was fixed in [#29](https://github.com/aleksandr-deich/adb-axi/pull/29).
- Task 8 (0 of 5 against 2 of 5) is not valid as scored: all ten agents stopped and restarted the emulator, and the scores depended on how the harness recorded the evidence.

### Verdict

A regression signal: adb-axi 0.1.2 matched baseline on success and cost but took 27% more turns and time, spent on learning the CLI. That led to the help and skill changes in 0.1.3.

### Limitations

- The same ordering, repeat count and single-machine limits as the second run.
- The task 3 and task 8 checks were later corrected, so success counts are not comparable across the two runs.

## Updating this document

When a new study finishes:

1. Add a section at the top of the studies, above the previous newest one, using the same fields in the same order: **Date**, **Tested version**, **Design**, **Agent/model**, **Sample size**, then **Key numbers**, **Verdict** and **Limitations**.
2. Add a row at the top of the table under [How to read this](#how-to-read-this), and say whether the study is realistic task evidence or a regression signal.
3. Refresh the summary in the [README](../README.md) between the `<!-- evaluation:start -->` and `<!-- evaluation:end -->` markers. Keep it short: the newest study's adb-axi versus plain-adb table, labelled with the tested version, a few sentences on the verdict, and a link here.
4. Take every number from the study's final report or analysis file, and report what was tested: the version, the behaviour and the verdict as they were at the time. When a weakness has since been fixed, say so and link the change; do not rewrite the result.
5. State null results and unfavourable results plainly, and keep the limitations.
6. Keep the page self-contained. Link only to public sources; leave transcripts, local paths and other private evidence out.

Older sections are not edited when a new study lands, except to add a link to a later fix.
