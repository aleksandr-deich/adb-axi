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

For a later release, use the **same repository commit, model, skill manifests, AVD images and repeat count**, changing only `--version` to the exact published version. Pin the benchmark revision in your report. A new skill revision is a separate experiment: explicitly record the new benchmark commit. `--phone` and `--tablet` override AVD names; `--conditions baseline` or `--conditions adb-axi` select a single condition. Repeats are positive integers; 3-5 is recommended for a full run. Every spending command requires explicit `--run`, `--tasks`, `--repeats`, and `--version`; `--max-runs` is a hard cap (default 80).

Use separate results directories by moving the previous `bench/results/` elsewhere before a new experiment. Summary aggregates all record JSON files currently in that directory by task and condition. It reports sums, success rates, and missing metric counts, not statistical significance. Compare versions in separate result sets. Do not treat one verification run as evidence of comparative quality.

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

Exact `clean-both` reset (`Devices.reset`, before setup and after every run, even on failure): recover each owned emulator if stopped, wait for `sys.boot_completed=1` and package-service availability, restore its initially captured `cmd uimode night` mode and `wm density` override (or `reset`), force-stop `com.android.cli.interact.instrumentation`, uninstall `dev.probe` if present, clear logcat. Verify app absence, holder process absence, exact config restoration and both devices online. A reset failure cancels all remaining runs. Finally shut down only the owned serials. A host-wide temp-directory lock prevents two benchmark runners overlapping. If killed with SIGKILL, inspect the owned AVDs and remove the stale lock only after confirming no runner is active; never restart the shared server.

Success is computed by scripts, not an agent's assertion:

1. Installed package, foreground activity, fresh probe start oracle (`saved=0`, `volatile=0`, not restored).
2. Three increments and a restored start with saved 3, volatile 0, a different PID, app foreground, and matching final counter report.
3. Real `IllegalStateException: probe crash requested` in logcat and both exception and message in final answer.
4. Actual debug database row captured before package replacement (read-only host SQLite query including WAL), row in agent read output and final report, release installed non-debuggable, an attempted read refusing access and matching final explanation. Database snapshot errors fail this criterion rather than accepting a claim.
5. Opposite night-mode value observed in command output, original state restored on the device, final restoration report.
6. Holder identity in diagnostics and final answer, successful clear operation, then a successful JSON Android layout response.
7. Task 1's device-state checks on both owned devices, both serials/packages in final answer.
8. Successful owned emulator stop, real unavailable/offline diagnostic output, phone online and booted again, matching final report. A stopped emulator can appear missing rather than literally `offline`; either counts as unavailable.

Tasks 2-8 require JSON-only final reports with named fields, so incorrect values or contradictory prose cannot pass through keyword matching. The wrapper audit is external command execution evidence, not model prose. It is part of success evaluation for intermediate operations that cannot be inferred from final state alone. Agents must not erase device logs; erased evidence fails the check. No other tasks are run implicitly. Conditions always alternate baseline then treatment within each repeat; this ordering is fixed, not randomized, and should be disclosed as a limitation.

## Records and metrics

`bench/results/` is gitignored. Each run writes a unique record JSON, agent JSONL, invocation JSON (no credentials) and command-audit JSONL. Records include success/check details, condition/task/repeat, exact package version, Pi version/model/medium effort, owned devices, actual skills, PATH evidence, reset result, and errors. A failure to collect metrics is recorded as null, never zero. Config directories are removed after shutdown; recorded paths describe the ephemeral config at launch, while hashes and invocation arguments retain the evidence.

Input tokens sum Pi's authoritative completed assistant-message usage: input + cacheRead + cacheWrite. Compaction usage, when emitted by Pi, is included in token and cost totals. Cost is Pi's reported USD `usage.cost.total` (a pricing estimate, not an invoice). Turns count completed assistant messages, including tool-calling turns. Wall time measures agent subprocess launch through exit, including tool execution and package acquisition, excluding setup/check/reset. Retries remain in the transcript; errored/aborted assistant responses fail the run. Authentication or infrastructure failures are not silently retried. The agent has a 15-minute timeout; device commands have finite timeouts.

## Checks

```sh
node --test bench/core.test.js
npm run check
```

Unit tests need neither devices nor agent calls and cover parsing, spend guards, records, aggregation, PATH contamination, actual isolated skill inventories and Pi usage parsing. Device and paid agent runs are never invoked by `npm run check`. Tests do not run a pilot. Keep run results and one-off verification reports outside version control; the repository contains only the repeatable harness and definitions.
