---
name: adb-axi
description: "Read and manage Android device and app state through the adb-axi CLI - attached devices and their health, the foreground app, installed packages, app install, start, stop, clear, kill and restore, process-death checks, run-scoped logs, crashes and ANRs, read-only queries on a debuggable app's databases and SharedPreferences, UiAutomation holder diagnosis, and one device shell command with its real exit code. Use instead of raw `adb` whenever a task needs Android device or app state, including `adb devices`, `am start`/`force-stop`/`kill`, `pidof`, `getprop`, `dumpsys`, `settings`, and `wm` state checks, even one-line checks during lesson or code review. This covers checking attached devices, boot waits, app lifecycle and process death, logs and crashes, app data, and UiAutomation holder diagnosis. Not for UI input or reading the screen; use a UI tool for that."
user-invocable: false
---

# adb-axi

Agent ergonomic wrapper around adb. Use adb-axi for Android device and app state, not raw `adb`.

This includes device discovery, boot waits, installed packages, app lifecycle, process-death checks, logs, databases, SharedPreferences, settings, properties, and `dumpsys` queries. Use named commands when they match the operation. Use `shell` for other device-shell state commands. Keep UI input, screen reading, emulator management, builds, and connected-test orchestration in their existing tools.

Do not use it for UI input (taps, typing, swipes) or for reading what is on screen; use a UI tool for those. A UI-automation holder left connected can leave accessibility showing as enabled and block instrumented tests. Before instrumented tests or handoff, finish active UI commands and inspect the holder. Use `doctor ui --fix` only for observed leftover state that your session owns. Repair can stop instrumentation and app processes. Do not run repair as automatic preflight, and do not evict a live or unowned holder. Final check: leave the device as found, or say what changed.

Use `adb-axi config get [<key>]` and `config set <key> <value>` for animations, night, font_scale, density and size. Other settings still use `shell`. Consult live `config get --help` and `config set --help` for the output contract, supported values and constraints.

## Install and run

Install once with `npm i -g adb-axi`, then run `adb-axi` from PATH. Fallback: `NPM_CONFIG_LOGLEVEL=warn npx -y adb-axi <command>` suppresses `npm notice` noise. Both routes need Node.js 24.12 or newer and Android SDK Platform-Tools 35.0.0 or newer. No preliminary availability probe is needed.

Output is short and the first line is the verdict. Do not pipe it through `tail` or `head`. Bare `adb-axi` reads live state; it is not a prerequisite for a known operation.

## Quick reference

- `adb-axi shell --json -- '<cmd>'` - output is structured, not raw stdout. Parse `stdout`, check `exit`, and validate the value before changing state. Put all CLI flags before `--`.
- `adb-axi data db <pkg> ['<sql>'] [--db <name>]` - list databases or run one read-only query for a debuggable app.
- `adb-axi app install <apk> [--clean-data] [--if-changed]` - omit `--clean-data` to preserve data; `--if-changed` skips the same versionCode and signer.
- `adb-axi app start <pkg> [--fresh]` - `--fresh` force-stops first.
- `adb-axi app stop <pkg>`
- `adb-axi app clear <pkg>`
- `adb-axi app death <pkg>` - kills and restores with before and after evidence. Start with the app in front; do not press HOME or sleep first.
- `adb-axi doctor ui [--fix]` - inspect first; repair only owned leftovers.
- `adb-axi logs [--since <mark|dur>] [--pkg <pkg>]`
- `adb-axi logs mark [<name>]`
- `adb-axi logs crash [--since <mark|dur>] [--pkg <pkg>]`

Use live `adb-axi <command> --help` for anything not listed. Family help such as `adb-axi app --help` shows compact usages. Batch independent help requests; use `adb-axi --help` for the command index.

For supported settings, `config set` prints `before.value`; install a cleanup trap before mutation and restore that value in the same turn, even if checks fail. Consult live `config get --help` and `config set --help` for restore restrictions and verification limits.

For other settings, record row presence separately from raw text. An absent settings key commonly prints `null`; restore confirmed absence with `settings delete`, not `settings put`. If presence or parsing is unknown, stop without changing state.

## Select the device

Target a known device with `--device <serial|avd>` after the command, or set `ANDROID_SERIAL=<serial>`. Only a lone online emulator is auto-selected; physical devices and multiple online devices require explicit selection. Consult the relevant command's `--help` when you need flag details.

If other tools or agents may share the default adb server, pin your own with `--server tcp:<port>` or a saved selection, and check the `server` field in the output. Consult `adb-axi doctor --help` for saved-selection and server-start policies; this selection routes adb-axi only, not other tools.

## Fewer turns, same checks

`adb-axi data prefs <pkg>` reads typed SharedPreferences rows; with several XML files, use `--file <name>` from the listed names. Long values are decimal strings; DataStore is not supported.

These short examples illustrate patterns; confirm current usage with live help when needed.

- Crash recipe: `adb-axi logs mark before-repro --device emulator-5554`, reproduce the problem through the UI, then `adb-axi logs crash --since before-repro --pkg com.example.notes --device emulator-5554`.
- Process-death recipe: put the app and state to test in front through the UI, run `adb-axi app death com.example.notes --device emulator-5554`, then read `death.pid_restored` and `death.new_process` for the restored process. Check the restored UI state separately; a new pid alone does not prove state preservation.

- Put flags after the complete command: `adb-axi app start com.example.notes --device emulator-5554`.
- Trust `app start`'s observed foreground evidence when it reports the app in front; do not immediately repeat it with `app current`. A launch alone is not foreground proof.
- Only when you need the schema, query a single database directly: `adb-axi data db com.example.notes 'SELECT name, sql FROM sqlite_master WHERE type = "table"'`. No listing first is needed; with several databases the CLI names them and asks for `--db`.
- Chain known sequential operations with `&&` when each next step requires success. When reproducing a launch crash, `app start` returns nonzero if it detects the crash: collect the marked crash evidence after the attempted launch, even on failure, in the same batch where possible. This subshell requires a successful mark, keeps every command's output visible, and exits nonzero if launch or diagnosis fails. Keep all three commands on the same device; do not parallelize marks.

  ```sh
  (
    adb-axi logs mark before-repro --device emulator-5554 || exit $?
    start_status=0
    adb-axi app start com.example.notes --device emulator-5554 || start_status=$?
    adb-axi logs crash --since before-repro --pkg com.example.notes --device emulator-5554 || exit $?
    exit "$start_status"
  )
  ```
