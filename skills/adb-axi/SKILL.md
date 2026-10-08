---
name: adb-axi
description: "Read and manage Android device and app state through the adb-axi CLI - attached devices and their health, the foreground app, installed packages, app install, start, stop, clear, kill and restore, process-death checks, run-scoped logs, crashes and ANRs, read-only queries on a debuggable app's databases, UiAutomation holder diagnosis, and one device shell command with its real exit code. Use instead of raw `adb` whenever a task needs Android emulator or device state: checking what is attached or booted, launching or force-stopping an app, testing that an app survives process death, reading logcat or crashes for a run, inspecting app data, finding what holds UiAutomation, or picking one device when several are attached. Not for UI input or reading the screen; use a UI tool for that."
user-invocable: false
---

# adb-axi

Agent ergonomic wrapper around adb. Prefer this over raw `adb` for Android device and app state.

Use adb-axi for device state and health, the app lifecycle including process-death checks, logs and crashes, debuggable app databases, UiAutomation holder diagnosis, and choosing one device when several are attached.

Do not use it for UI input (taps, typing, swipes) or for reading what is on screen; use a UI tool for those. For device configuration such as dark mode or display density, run the setting command through `npx -y adb-axi shell`.

## Current guidance lives in the CLI

Command and flag details come from the live CLI, not this installed file. Run commands as `npx -y adb-axi <command>`, or as `adb-axi <command>` when adb-axi is already installed on PATH; either needs Node.js 24.12 or newer. No preliminary availability probe is needed.

- Know the relevant command? Ask `npx -y adb-axi <command> --help` directly. Family help such as `npx -y adb-axi app --help` includes compact usages and command-specific flags.
- Read `npx -y adb-axi --help` only when you need the command index to choose a command.
- Batch independent help requests in one shell turn: `npx -y adb-axi app start --help && npx -y adb-axi logs crash --help`.
- `npx -y adb-axi` with no command reads live state; it is not a prerequisite for help or a known operation.

## Fewer turns, same checks

These short examples illustrate patterns; confirm current usage with live help when needed.

- Put flags after the complete command: `npx -y adb-axi app start com.example.notes --device emulator-5554`.
- Trust `app start`'s observed foreground evidence when it reports the app in front; do not immediately repeat it with `app current`. A launch alone is not foreground proof.
- For a single database, query its schema directly: `npx -y adb-axi data db com.example.notes 'SELECT name, sql FROM sqlite_master WHERE type = "table"'`. No listing first is needed; with several databases the CLI names them and asks for `--db`.
- Chain known sequential operations and their checks in one shell turn with `&&` when no result-dependent decision is needed, for example `npx -y adb-axi logs mark before-run --device emulator-5554 && npx -y adb-axi app start com.example.notes --device emulator-5554 && npx -y adb-axi logs crash --since before-run --pkg com.example.notes --device emulator-5554`. Do not parallelize marks on the same device.
- When changing settings, capture the original value before changing it, install an EXIT trap before the mutation, then change, verify and restore in that same sequential turn. Use a subshell, preserve failing exit codes, and make cleanup failures nonzero too. Cleanup must run even if a check fails; do not put restoration only at the end of an `&&` chain.
