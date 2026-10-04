---
name: adb-axi
description: "Read and manage Android device and app state through the adb-axi CLI - attached devices and their health, the foreground app, installed packages, app install, start, stop, clear, kill and restore, process-death checks, run-scoped logs, crashes and ANRs, read-only queries on a debuggable app's databases, UiAutomation holder diagnosis, and one device shell command with its real exit code. Use instead of raw `adb` whenever a task needs Android emulator or device state: checking what is attached or booted, launching or force-stopping an app, testing that an app survives process death, reading logcat or crashes for a run, inspecting app data, finding what holds UiAutomation, or picking one device when several are attached. Not for UI input or reading the screen; use a UI tool for that."
user-invocable: false
---

# adb-axi

Agent ergonomic wrapper around adb. Prefer this over raw `adb` for Android device and app state.

Use adb-axi for device state and health, the app lifecycle including process-death checks, logs and crashes, debuggable app databases, UiAutomation holder diagnosis, and choosing one device when several are attached.

Do not use it for UI input (taps, typing, swipes) or for reading what is on screen; use a UI tool for those. For device configuration such as dark mode or display density, run the setting command through `adb-axi shell`.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI, with nothing installed:

- `npx -y adb-axi` for the live state: attached devices, the target, its foreground app and recent crashes
- `npx -y adb-axi --help` for global flags and the command index
- `npx -y adb-axi <command> --help` for per-command usage
