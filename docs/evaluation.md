# Evaluation

How adb-axi has been measured in agent workflows and real-device regression checks. The agent studies compare two arms: an agent with adb-axi and its skill, and the same agent with plain `adb`. Scripted device checks test the CLI's behaviour without comparing agents or tools. Studies are listed newest first.

## How to read this

Two kinds of evidence are kept apart:

- **Realistic task evidence**: an agent does a whole job (fix a reported bug on a device, build an app slice) and independent checks score the result. This is the evidence to use for "does adb-axi help an agent".
- **Regression signal**: a fixed set of small scripted tasks, run the same way for each release. It shows whether a release moved correctness, turns, tokens or time. Its tasks are too small, and its checks too literal, to rank the two arms.

The agent studies so far are small: one app or one probe app, one model per study, and three to five repeats. No study claims statistical significance. A null result is reported as a null result.

| Study                                                            | Kind       | Date       | Version       | Agent runs | Verdict                                                                                   |
| ---------------------------------------------------------------- | ---------- | ---------- | ------------- | ---------- | ----------------------------------------------------------------------------------------- |
| [Packed-CLI emulator coverage](#packed-cli-emulator-coverage)    | Regression | 2026-10-13 | 0.2.1 + fixes | 0          | All 11 checks pass on API 29/30/35 and supplementary API 37.1; exposed a process-name bug |
| [Device bug-fix episodes](#device-bug-fix-episodes)              | Realistic  | 2026-10-10 | 0.2.1         | 30         | No reliability or effort difference; three workflow strengths; one side effect to mind    |
| [App-build repeats](#app-build-repeats)                          | Realistic  | 2026-10-09 | 0.2.0         | 8          | No whole-run difference at 5 runs per arm; process death takes fewer turns                |
| [App-build pilot](#app-build-pilot)                              | Realistic  | 2026-10-08 | 0.1.3         | 2          | No detectable difference at 1 run per arm; found a `data db` bug                          |
| [Scripted benchmark, second run](#scripted-benchmark-second-run) | Regression | 2026-10-07 | 0.1.3         | 80         | Turn overhead halved; success counts not comparable as first scored                       |
| [Scripted benchmark, first run](#scripted-benchmark-first-run)   | Regression | 2026-10-05 | 0.1.2         | 80         | Same success and cost; 27% more turns, spent on learning the CLI                          |

Raw agent-study transcripts and run records are not published. Scripted device checks publish CI logs and artifacts. The numbers here are taken from each study's final report and frozen analysis; where a public pull request or file backs a statement, it is linked.

## Packed-CLI emulator coverage

- **Date:** 2026-10-13.
- **Tested version:** adb-axi 0.2.1 with the process-name fix in [#52](https://github.com/aleksandr-deich/adb-axi/pull/52), at testing commit [`26d058b`](https://github.com/aleksandr-deich/adb-axi/commit/26d058b5006b10679ba21f7a0d17a88486642134).
- **Design:** the installed executable from `npm pack` drives the existing debug and non-debuggable release probe APKs on disposable emulators. The six existing device files and their assertions remain; a seventh checks device identity and foreground state against independent Android queries. Each test has isolated CLI state, crash scenarios reset probe data, log marks delimit observations, and the final test stops its emulator. This is a correctness regression round, not an adb-axi versus plain-adb comparison.
- **Agent/model:** no agent in the measured runs; Vitest 5 runs the scripted checks on Node.js 24.
- **Sample size:** four final device-suite runs, 11 checks each: three x86_64 CI emulators (API 29, 30 and 35) and one supplementary local arm64 emulator (API 37.1). Earlier diagnostic rounds are not pooled into the final pass counts.

### Key numbers

| Emulator        | Checks passed | Vitest wall seconds |
| --------------- | ------------- | ------------------- |
| API 29, x86_64  | 11 of 11      | 42.87               |
| API 30, x86_64  | 11 of 11      | 36.60               |
| API 35, x86_64  | 11 of 11      | 47.48               |
| API 37.1, arm64 | 11 of 11      | 110.86              |

The [complete CI matrix](https://github.com/aleksandr-deich/adb-axi/actions/runs/38410094458) passes every job. The [Ubuntu and macOS checks](https://github.com/aleksandr-deich/adb-axi/actions/runs/38410094032) also pass. Locally, `npm run check` passes typechecking, lint and formatting, 1,307 tests with 7 preexisting skips, and 64 benchmark-harness tests. Device wall times include framework readiness; the local run also packs and installs inside setup, while CI does that before the measured Vitest command. Image provisioning and the preceding build are excluded, so the times are not a platform-speed comparison.

**Independently grounded results:**

- Starting the foreground singleTop activity preserves its probe counters and PID; `--fresh` creates a new PID and resets both counters. Kill/restore preserves `saved=3`, resets `volatile` to 0 and produces a new process with no crash.
- A Room insert produces `probe-1` in the WAL but not the main database file, and `data db` returns that row. The signed non-debuggable release probe returns `APP_NOT_DEBUGGABLE`.
- One Java crash is counted after its mark and none after the next mark. Native SIGSEGV and ANR reports remain covered; the ANR is independently present in Android's system log buffer.
- UiAutomation is free with exit 0. The target's serial, AVD name and API match its independently read identity; `app current` matches WindowManager focus and the kernel PID. After emulator shutdown, an explicit-serial command returns a typed unavailable-device error within the unchanged two-second bound.

**Four duplicate fake-backed cases were replaced after real assertions passed:** foreground app payload and formatting by `6-device-state`; already-on-top start by `2-app-start`; the captured WAL row and release database refusal by `3-data-db`. Their JSON/TOON and expected payload checks remain in the device replacements. Pure parsing, formatting and algorithm tests remain, as do synthetic transport faults, hangs, deadline expiry, malformed/ZIP64 input, crash-boundary cases and other branches that these device checks do not replace.

**A product bug exposed by API 29:** before the fix, `app kill` could reject a bracketed kernel process name with `INVALID_OUTPUT` during process exit, even though independent kernel and ActivityManager observations subsequently showed the process gone ([failing run](https://github.com/aleksandr-deich/adb-axi/actions/runs/38376236171)). It was fixed separately in [#52](https://github.com/aleksandr-deich/adb-axi/pull/52), which accepts valid bracketed names without dropping UID filtering or malformed-name rejection. After rebasing onto that fix, the complete API 29 suite passes: kill reports exit, restore produces a new PID, saved state survives, volatile state resets and there is no crash. This testing change adds no shipped implementation changes of its own.

**Two test-environment corrections, without weaker assertions or longer deadlines:** older emulator images expose the AVD name through `ro.kernel.qemu.avd_name`, not the newer boot property. Android 10 can leave a prior crash dialog in front of a resumed activity, and its input dispatcher detects an unfinished key event when a second event waits behind it. The crash file now temporarily suppresses error dialogs, requires actual input-window focus and runs two concurrent keyboard-event producers. It restores and verifies the original setting afterward. Raw Android logs distinguish failure to generate an ANR from failure to parse one.

### Verdict

The packed CLI passes all approved ordinary flows on the complete API 29/30/35 PR matrix, with independent device evidence rather than simulated ADB replies. Extending the matrix exposed a real product issue that the previous API 30/35 coverage had not caught. Four duplicate fake cases could be removed; the remaining synthetic tests still cover distinct failure and edge conditions.

### Limitations

- One final run per API level, one small probe app, emulators only; this is not a reliability estimate or a comparison of agent effort.
- API 37.1 is supplementary local evidence, not a substitute for CI's API 29/30/35 coverage. One later local startup attempt failed before any assertion; a fresh isolated transport passed the final integrated run.
- Device listing checks the selected target's real row but does not automate ambiguous selection or physical-device behaviour. Resident UiAutomation-holder repair remains a local-only check.
- ANR coverage deliberately suppresses error dialogs and uses a synthetic blocking action in a real app; it does not test an app's naturally occurring ANR or dialog interaction.
- Seven existing tests remain skipped in the non-device suite; none were newly skipped or weakened in this round.

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
3. Refresh the summary in the [README](../README.md) between the `<!-- evaluation:start -->` and `<!-- evaluation:end -->` markers. Keep it to 3-5 lines that lead with the newest realistic evidence and link here.
4. Take every number from the study's final report or analysis file, and report what was tested: the version, the behaviour and the verdict as they were at the time. When a weakness has since been fixed, say so and link the change; do not rewrite the result.
5. State null results and unfavourable results plainly, and keep the limitations.
6. Keep the page self-contained. Link only to public sources; leave transcripts, local paths and other private evidence out.

Older sections are not edited when a new study lands, except to add a link to a later fix.
