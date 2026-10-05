# Repeatable Android agent benchmark

This is a sequential, local benchmark, not CI and not part of the npm package (`package.json` publishes only `dist`, `LICENSE`, and the root README). Run from the repository root on macOS with Node 22+, Pi, the Android CLI, SDK platform-tools and `/usr/bin/sqlite3`. Provision the phone and tablet AVDs first. The harness boots them itself and refuses already-running target AVDs. No physical device or other AVD is a target. `Pixel_10_Pro_XL_Sasha` and `small_phone` are prohibited even as overrides.

## Commands and spend guard

No arguments means **dry run**: print all task definitions, setup, model, conditions and run count without booting devices, installing packages or calling the agent.

```sh
node bench/run.js
node bench/run.js --tasks 1 --repeats 1 --version 0.1.2 --max-runs 2
```

Pilot (8 tasks once in both conditions, 16 agent runs):

```sh
node bench/run.js --run --tasks 1,2,3,4,5,6,7,8 --repeats 1 --version 0.1.2 --max-runs 16
```

Full benchmark (8 tasks, 5 repeats, 80 agent runs):

```sh
node bench/run.js --run --tasks 1,2,3,4,5,6,7,8 --repeats 5 --version 0.1.2 --max-runs 80
node bench/run.js summary
```

For a later release, use the **same repository commit, model, skill manifests, AVD images and repeat count**, changing only `--version` to the exact published version. Pin the benchmark revision in your report. A new skill revision is a separate experiment: explicitly record the new benchmark commit. `--phone` and `--tablet` override AVD names. Every repeat runs both conditions (2 agent runs per task); repeats are positive integers, with 3-5 recommended for a full run. Every spending command requires explicit `--run`, `--tasks`, `--repeats`, and `--version`; `--max-runs` is a hard cap (default 80).

Use `--results-dir <path>` to keep records, transcripts and audits outside the clone (default: `bench/results/`). Spending commands create it if needed; a file path is refused. Use a separate directory for each experiment:

```sh
node bench/run.js --run --tasks 1,2,3,4,5,6,7,8 --repeats 5 --version 0.1.2 --max-runs 80 --results-dir /absolute/path/to/experiment
node bench/run.js status --tasks 1,2,3,4,5,6,7,8 --repeats 5 --results-dir /absolute/path/to/experiment
node bench/run.js summary --results-dir /absolute/path/to/experiment
```

Restart the same spending command after interruption, once any leftover run lock has been inspected and removed manually. A task/condition/repeat is done only when its record explicitly marks a boolean verdict, including `false`. Completed runs are skipped, while missing records and harness failures without a verdict run again. Repeat numbers stay 1..N and remaining runs retain the original task/repeat/condition order. The plan prints `skipped`, `toRun`, and their counts before any devices start; a spending command rechecks records and remaining slots after taking the run lock. `--max-runs` caps only `toRun`, not skipped runs. Omit `--run` to inspect that plan without devices or agent calls. `status` reports done, failed-without-verdict and remaining counts per task/condition plus total remaining, without creating directories or needing tools on PATH. Failed-without-verdict counts are a subset of remaining, not an additional category.

Resume refuses any existing record whose model, effort, agent version, exact adb-axi version, benchmark revision or skill-manifest hashes differ from the invocation, listing every mismatch. There is no override. Skill-manifest hashes cover the manifest and every file in its declared skill directories, including references. Version consistency is checked before device access on a spending invocation. Legacy records without these hashes cannot be resumed; preserve them in a separate experiment directory.

Summary groups records by task and condition, counting only verdict-bearing slots in `runs` and success rates. Attempts without a verdict are reported separately as `failedAttempts`; their metrics do not enter the verdict totals. Groups with no verdict have a null success rate. It reports sums and missing metric counts, not statistical significance. Compare versions in separate result sets. Do not treat one verification run as evidence of comparative quality.

## Conditions and isolation

Edit `conditions/baseline.json` and `conditions/adb-axi.json` to change skills. Paths are repository-relative. The baseline contains only the vendored Android CLI skill and its references (copied from the published Android CLI skill). The treatment adds the committed `skills/adb-axi`, never the machine's installed copy. Neither loads `android-device`.

Before **each agent launch**, the runner copies only manifest skills into a fresh isolated config, scans the actual files and all references for baseline contamination, validates frontmatter and unique skill names, hashes skill files and records their actual paths. Pi receives exactly those paths using explicit `--skill` arguments with all discovery disabled: skills, extensions, context files, prompt templates and themes. Only the authentication file is copied from the user's Pi config; settings and user packages are not inherited. HOME, session behavior and shell startup files are isolated. Both conditions use the same Pi built-in read/bash/edit/write tools and Android CLI UI tools. The small `pi.js` adapter is the only agent implementation; another adapter can use the same runner record contract.

The controlled PATH exposes device command bridges, Node, and system utilities, not arbitrary global install directories. Baseline has neither an `adb-axi` command nor an npx bridge. Treatment's `adb-axi` and `npx` bridges execute `npx -y adb-axi@<exact-version>`; unversioned skill instructions cannot silently select another release. Immediately before launch, `command -v adb-axi` runs inside the exact child environment. Baseline must return status 1 and an empty resolution; treatment must resolve. Each record contains this evidence and the actual isolated skill inventory. Invocation arguments and tool audit output are also retained.

This is experimental environment control for a cooperative agent, **not an OS security sandbox**. An agent deliberately accessing absolute host paths or installing tools would violate the run contract. Device bridges restrict explicit serials and prohibit shared device-server operations; Android UI commands require an owned `--device`. Only owned AVD names can be started/stopped. Never run adversarial prompts here. Inspect audit logs when reviewing results.

## Tasks, setup, reset, and oracles

Each `tasks/<id>.json` owns the neutral agent prompt, setup selector, exact reset selector and success-script path. Each `tasks/<id>.js` is the executable check entry point; shared implementation lives in `success.js`. Fixture APKs come from `test/fixtures/apk/`, package `dev.probe`. The UI action is the device activity launch `am start -n dev.probe/.MainActivity --es probe <inc|write|crash|anr>`; it is explained equally in both conditions. Tasks do not tell agents which device-state tool to choose.

Exact setup selectors (implemented in `setupTask`):

- `clean`: execute `clean-both` below, with no app installed.
- `debug`: `clean-both`, install `probe-debug.apk` on the phone, start `dev.probe/.MainActivity` and wait for launch.
- `ui-holder`: `debug`, run `android layout --device=<phone>`, then require `com.android.cli.interact` in the process list. Failure to establish the fixture aborts that run without an agent launch.

Exact `clean-both` reset (`Devices.reset`, before setup and after every run, even on failure): recover each owned emulator if stopped, wait for `sys.boot_completed=1` and package-service availability, restore its initially captured `cmd uimode night` mode and `wm density` override (or `reset`), force-stop `com.android.cli.interact.instrumentation`, uninstall `dev.probe` if present, clear logcat. Verify app absence, holder process absence, exact config restoration and both devices online. A reset failure cancels all remaining runs. Finally shut down only the owned AVDs. A host-wide temp-directory lock prevents two benchmark runners overlapping. If a run is interrupted, the next start refuses the leftover lock and names its path: confirm no benchmark is running, inspect and stop any leftover benchmark AVDs, then remove the lock manually before restarting. This also applies if task 8 restarted an emulator before interruption: an already-running target AVD is refused, not adopted. Reset-before-run cleans each new run. It never restarts the shared server.

Success is computed by scripts, not an agent's assertion:

1. Installed package, foreground activity, fresh probe start oracle (`saved=0`, `volatile=0`, not restored).
2. Three increments and a restored start with saved 3, volatile 0, a different PID, app foreground, and matching final counter report.
3. Real `IllegalStateException: probe crash requested` in logcat and both exception and message in final answer.
4. Actual debug database row captured before package replacement (read-only host SQLite query including WAL), row in agent read output and final report, release installed non-debuggable, an attempted read refusing access and matching final explanation. Database snapshot errors fail this criterion rather than accepting a claim.
5. Opposite night-mode value observed in command output, original state restored on the device, final restoration report.
6. Holder identity in diagnostics and final answer (including class suffixes and descriptive labels, but not contradictory unrelated holders), independent observation that the original holder PID disappeared, then a valid nonempty Android layout response. The verifier does not require a particular clearing command.
7. Task 1's device-state checks on both owned devices, both serials/packages in final answer.
8. During setup, capture the owned phone's valid boot ID through the harness device call and the unique host emulator PID for the owned AVD independently. Require an ordered stop/observation/restart or online/unavailable/online sequence (including later cycles), real unavailable output, a matching final report, and the owned phone online and booted with both a different valid boot ID and a different verified host emulator PID. A disconnect retains both identities; `adb reboot` changes only the boot ID. State sequence alone cannot prove a stop. Evidence is recognized from agent-visible output rather than tool identity, including targeted `wait boot` JSON or TOON errors that name the owned AVD or serial, indicate a timeout (`WAIT_TIMEOUT` or timeout wording), and report `last.state` as `not attached` or `offline` (even on a separate line). Generic untargeted timeouts are not evidence. `unavailable` is an umbrella report; `missing` and `offline` must match an observed state. Help-only lifecycle calls never count. AVD inventories without running-state information are not attached-device lists.

The historical task 8 treatment audit has missing-state output and recovery but lacks the setup boot ID and host emulator PID, so it cannot be rescored as a proven stop under the new criterion. Synthetic equivalents with captured before/after boot and host process identities test that path. The baseline audit has no unavailable observation. Bridge auditing remains a separate future issue: raw transport can report offline while the forwarded listing shown to the agent reports missing; scoring compares the report to forwarded agent-visible output, not hidden raw transport.

Tasks 2-8 require JSON-only final reports with named fields, so incorrect values or contradictory prose cannot pass through keyword matching. The wrapper audit is external command execution evidence, not model prose. It is part of success evaluation for intermediate operations that cannot be inferred from final state alone. Agents must not erase device logs; erased evidence fails the check. No other tasks are run implicitly. Conditions always alternate baseline then treatment within each repeat; this ordering is fixed, not randomized, and should be disclosed as a limitation.

## Records and metrics

`bench/results/` is gitignored. Each run writes a unique record JSON through a flushed temporary file and atomic rename (unfinished temporary files are ignored) and retains agent JSONL, invocation JSON (no credentials) and command-audit JSONL when produced. Records include condition/task/repeat, exact package version, Pi version/model/medium effort, owned devices, reset result, and available success/check details, skills, PATH evidence and errors. A failure to collect metrics is recorded as null, never zero. If Pi exits nonzero after emitting completed turns with usable usage data, their token, cost and turn counts are retained, while the exit still fails the run. Config directories are removed after shutdown; recorded paths describe the ephemeral config at launch, while hashes and invocation arguments retain the evidence.

Input tokens sum Pi's authoritative completed assistant-message usage: input + cacheRead + cacheWrite. Compaction usage, when emitted by Pi, is included in token and cost totals. Cost is Pi's reported USD `usage.cost.total` (a pricing estimate, not an invoice). Turns count completed assistant messages, including tool-calling turns. Wall time measures agent subprocess launch through exit, including tool execution and package acquisition, excluding setup/check/reset. Retries remain in the transcript; errored/aborted assistant responses fail the run. Authentication or infrastructure failures are not silently retried. The agent has a 15-minute timeout; device commands have finite timeouts.

## No-agent device self-check

```sh
node bench/run.js self-check --tasks 1,2,3,4,5,6,7,8
node bench/run.js self-check --tasks 6 --phone Pixel_10_Pro_XL --tablet medium_tablet
```

This explicit command boots only the harness-owned AVDs and never invokes Pi or any other agent. It is not part of CI. Every task definition points to `reference/<id>.js`, a readable scripted solution using the same controlled device tools, `setupTask`, success script, and reset as an agent run. Each case must (1) reject untouched setup with an empty answer, (2) accept the reference solution, (3) reject untouched setup even with the reference's correct-looking answer, and (4) reject a natural wrong answer or incomplete device outcome. Wrong cases include claiming the unsaved counter survived, reporting the wrong crash cause, claiming release database access succeeded, skipping configuration restoration, leaving the UI holder uncleared, skipping the tablet, and stopping/restarting without inspecting the unavailable state, a synthetic disconnect/reconnect listing without a reboot, and a real device reboot without stopping the host emulator for task 8. Tasks 6 and 8 additionally exercise adb-axi references at the pinned `--version` (requiring npx), and reject unrelated holder or unsupported unavailable-state reports. Task 1's wrong case leaves the app in the background.

Results and external command evidence go under ignored `results/self-check/`, separate from agent records and summary aggregation. A failed case makes the command exit nonzero; reset failure aborts the remaining cases. The command requires Node, the SDK, and Android CLI, but not Pi or model credentials. Every reset is verified, and owned AVDs are shut down after the command.

For UI-holder verification, the setup captures the initial PID. The bridge privately samples holder PID state after outer tool calls; nested transport calls are not sampled again. These observations never enter agent stdout. Their shared instrumentation overhead is included in measured agent wall time, so disclose it when interpreting timing. Binary output is forwarded byte-for-byte, and large piped output is allowed to drain before exit. A silently empty emulator-console identity is checked against the independent `ro.boot.qemu.avd_name` property; no serial mapping is guessed.

## Checks

```sh
node --test bench/core.test.js
npm run check
```

Unit tests need neither devices nor agent calls and cover parsing, resume ordering and repeat numbers, verdict completeness, per-field consistency refusals, executed-run spend caps, read-only status, external summaries, atomic records, exclusive run locks and reset-before-run, aggregation, PATH contamination, actual isolated skill inventories and Pi usage parsing. Device and paid agent runs are never invoked by `npm run check`. Tests do not run a pilot. Keep run results and one-off verification reports outside version control; the repository contains only the repeatable harness and definitions.
