---
name: adb-axi
description: "Read and manage Android device and app state through the adb-axi CLI - attached devices and their health, the foreground app, installed packages, app install, start, stop, clear, kill and restore, process-death checks, run-scoped logs, crashes and ANRs, read-only queries on a debuggable app's databases and SharedPreferences, UiAutomation holder diagnosis, and one device shell command with its real exit code. Use instead of raw `adb` whenever a task needs Android device or app state, including `adb devices`, `am start`/`force-stop`/`kill`, `pidof`, `getprop`, `dumpsys`, `settings`, and `wm` state checks, even one-line checks during lesson or code review. This covers checking attached devices, boot waits, app lifecycle and process death, logs and crashes, app data, and UiAutomation holder diagnosis. Not for UI input or reading the screen; use a UI tool for that."
user-invocable: false
---

# adb-axi

Agent ergonomic wrapper around adb. Use adb-axi for Android device and app state, not raw `adb`.

This includes device discovery, boot waits, installed packages, app lifecycle, process-death checks, logs, databases, SharedPreferences, settings, properties, and `dumpsys` queries. Use named commands when they match the operation. Use `shell` for other device-shell state commands. Keep UI input, screen reading, emulator management, builds, and connected-test orchestration in their existing tools.

Do not use it for UI input (taps, typing, swipes) or for reading what is on screen; use a UI tool for those. A UI-automation holder left connected can leave accessibility showing as enabled and block instrumented tests. Before instrumented tests or handoff, finish active UI commands and inspect the holder. Use `doctor ui --fix` only for observed leftover state that your session owns. Repair can stop instrumentation and app processes. Do not run repair as automatic preflight, and do not evict a live or unowned holder. Final check: leave the device as found, or say what changed.

Use `npx -y adb-axi config get [<key>]` and `config set <key> <value>` for animations, night, font_scale, density and size. Other settings still use `shell`. See [Temporary device configuration](../../README.md#temporary-device-configuration) for the output contract and supported values; consult live `config set --help` for the installed version's constraints.

## Current guidance lives in the CLI

Command and flag details come from the live CLI, not this installed file. Run commands as `npx -y adb-axi <command>`, or as `adb-axi <command>` when adb-axi is already installed on PATH; either needs Node.js 24.12 or newer and Android SDK Platform-Tools 35.0.0 or newer. No preliminary availability probe is needed.

Output is short and the first line is the verdict. Do not pipe it through `tail` or `head`.

- Know the relevant command? Ask `npx -y adb-axi <command> --help` directly. Family help such as `npx -y adb-axi app --help` includes compact usages and command-specific flags.
- Read `npx -y adb-axi --help` only when you need the command index to choose a command.
- Batch independent help requests in one shell turn: `npx -y adb-axi app start --help && npx -y adb-axi logs crash --help`.
- `npx -y adb-axi` with no command reads live state; it is not a prerequisite for help or a known operation.

`adb-axi shell` returns structured output, not raw remote stdout. For a value that another command will use, request `--json` and parse its `stdout` field. Check the command's `exit` status and validate the parsed value before changing state. Do not extract a value with `head`, `tail`, or removal of a printed field label.

For supported settings, restore with the `before.value` printed by `config set`, using the [temporary settings recipe](#temporary-settings-recipe). Stop if the original restore value is null. A failed set may have partially applied: inspect its before/after evidence and run cleanup even if checks fail. Consult `config set --help` for unsupported originals, user restrictions and the limits of verification, especially animation estimates and live-unverified `unset`.

For other settings, record row presence separately from raw text. An absent settings key commonly prints `null`; restore confirmed absence with `settings delete`, not `settings put`. If presence or parsing is unknown, stop without changing state.

## Select the device

Target a known device with `--device <serial|avd>` after the command, or set `ANDROID_SERIAL=<serial>`. Only a lone online emulator is auto-selected; physical devices and multiple online devices require explicit selection. Consult the relevant command's `--help` when you need flag details.

If other tools or agents may share the default adb server, pin your own with `--server tcp:<port>` or a saved selection, and check the `server` field in the output. Consult `npx -y adb-axi doctor --help` for saved-selection and server-start policies; this selection routes adb-axi only, not other tools.

## App-build loop

Typical usages (flags go after the command; confirm details with `--help`):

- `npx -y adb-axi app install <apk> --clean-data` installs and wipes app data; omit `--clean-data` to keep data.
- `npx -y adb-axi app start <pkg>`, `npx -y adb-axi app stop <pkg>` and `npx -y adb-axi app clear <pkg>`.
- `npx -y adb-axi app death <pkg>` kills and restores the app in one call, with before and after evidence. It sends HOME itself, so run it with the app in front and do not press HOME or sleep first.
- `npx -y adb-axi data db <pkg> '<sql>'` runs one read-only query on a debuggable app's database.
- `npx -y adb-axi data prefs <pkg>` reads typed SharedPreferences rows; with several XML files, use `--file <name>` from the listed names. Long values are decimal strings; DataStore is not supported.

## Fewer turns, same checks

These short examples illustrate patterns; confirm current usage with live help when needed.

- Crash recipe: `npx -y adb-axi logs mark before-repro --device emulator-5554`, reproduce the problem through the UI, then `npx -y adb-axi logs crash --since before-repro --pkg com.example.notes --device emulator-5554`.
- Process-death recipe: put the app and state to test in front through the UI, run `npx -y adb-axi app death com.example.notes --device emulator-5554`, then read `death.pid_restored` and `death.new_process` for the restored process. Check the restored UI state separately; a new pid alone does not prove state preservation.

- Put flags after the complete command: `npx -y adb-axi app start com.example.notes --device emulator-5554`.
- Trust `app start`'s observed foreground evidence when it reports the app in front; do not immediately repeat it with `app current`. A launch alone is not foreground proof.
- Only when you need the schema, query a single database directly: `npx -y adb-axi data db com.example.notes 'SELECT name, sql FROM sqlite_master WHERE type = "table"'`. No listing first is needed; with several databases the CLI names them and asks for `--db`.
- Chain known sequential operations with `&&` when each next step requires success. When reproducing a launch crash, `app start` returns nonzero if it detects the crash: collect the marked crash evidence after the attempted launch, even on failure, in the same batch where possible. This subshell requires a successful mark, keeps every command's output visible, and exits nonzero if launch or diagnosis fails. Keep all three commands on the same device; do not parallelize marks.

  ```sh
  (
    npx -y adb-axi logs mark before-repro --device emulator-5554 || exit $?
    start_status=0
    npx -y adb-axi app start com.example.notes --device emulator-5554 || start_status=$?
    npx -y adb-axi logs crash --since before-repro --pkg com.example.notes --device emulator-5554 || exit $?
    exit "$start_status"
  )
  ```

## Temporary settings recipe

Run the mutation, checks and restoration in one sequential turn. This Bash example installs cleanup before mutation, uses the set result's `before.value`, and preserves both check failures and cleanup failures. The pre-read is a fallback if the mutation loses its transport before it can print `before`. Keep the device's current Android user unchanged throughout.

```bash
(
  device=emulator-5554
  key=animations
  value=0
  restore=$(npx -y adb-axi config get "$key" --device "$device" --json | node --input-type=module -e '
    let s=""; for await (const c of process.stdin) s+=c;
    const v=JSON.parse(s).config?.[0]?.value;
    if (typeof v!=="string") process.exit(1); process.stdout.write(v);
  ') || exit $?
  cleanup() {
    result=$?
    trap - EXIT
    npx -y adb-axi config set "$key" "$restore" --device "$device" || result=1
    exit "$result"
  }
  trap cleanup EXIT
  status=0
  changed=$(npx -y adb-axi config set "$key" "$value" --device "$device" --json) || status=$?
  printf '%s\n' "$changed"
  original=$(printf '%s' "$changed" | node --input-type=module -e '
    let s=""; for await (const c of process.stdin) s+=c;
    const v=JSON.parse(s).before?.value;
    if (typeof v!=="string") process.exit(1); process.stdout.write(v);
  ') && restore=$original
  [ "$status" -eq 0 ] || exit "$status"
  # Run checks here; exit nonzero if a check fails.
)
```
