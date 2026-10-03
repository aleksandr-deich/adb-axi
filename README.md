# adb-axi

An agent-friendly command-line wrapper around adb, following the AXI conventions: token-efficient output, truthful exit codes, deadlines on every device call, and structured errors.

It covers the device-state side of Android work: device health, app lifecycle including process-death checks, run-scoped logs and crashes, and app data. UI driving is out of scope.

**Status:** in development. Commands ship one slice at a time; `adb-axi --help` lists the ones available in your build.

## Device health and boot

`adb-axi doctor [--device <serial|avd>]` reports on adb, the server, device selection, boot, free space on `/data`, animation scales, the default keyboard, running instrumentations and the emulator console token. Checks that depend on an unavailable device are omitted. Each reported check is `ok`, `warn` or `failed` with a one-line detail; the command exits 1 if any check fails and 0 if there are only warnings. This command reports problems but does not fix them; when an instrumentation holds UiAutomation, its help points at `doctor ui`.

`adb-axi doctor ui [--fix] [--device <serial|avd>]` lists what holds the device's single UiAutomation connection: instrumentations started with one (the Android CLI's server, agent-device's snapshot instrumentation, `am instrument` and Gradle `connected*` runs) and known `app_process` servers (mobilecli's `DeviceServer`, `uiautomator`). Each holder is `live` when a host process of its tool may still use it (for mobilecli, only through an `adb forward` to this device), `wedged` when its own pid logged `Cannot call disconnect() while connecting`, and `leaked` otherwise. When the host process list or the forwards cannot be read, the holder counts as `live`. The report exits 0 when UiAutomation is free or held only by live holders, and 1 when a holder is leaked or wedged. `--fix` kills leaked and wedged servers, force-stops leaked and wedged instrumentation packages (which also stops that package's app processes), then checks again: it exits 0 when UiAutomation is free, 1 with the remaining holders when one survives, and fails with `HOLDER_PROTECTED`, naming what would release it, when a live holder remains.

`adb-axi wait boot [--device <serial|avd>] [--timeout <dur>]` waits for the device to come online and `sys.boot_completed` to become `1` (default timeout 120 s). Once it selects a device, it keeps waiting for that same device even if another comes online. On `WAIT_TIMEOUT`, the error includes `last` with `state`, `boot_completed` and `uptime_s`; unknown readings are `-`. Use `--json` for the same fields as TOON.

`app install <apk>` uses `adb install -r` to keep existing app data. Without `--clean-data`, its success label says `with data kept` when a package record exists (including an uninstalled record with retained data), or `(fresh install)` when no record exists. It then waits for the package manager to report the APK's versionCode. Its default deadline is 180 seconds; override it with `--timeout <dur>`. `--clean-data` installs, clears data, and verifies the version again, even when combined with `--if-changed`. If the APK metadata cannot be read, `--clean-data` refuses the install because the package to wipe is unknown; otherwise an unreadable APK can still be installed, with output stating that its version was not verified.

Without a requested wipe, `--if-changed` skips only when current installed versionCode and target-device signer evidence match the APK. Unreadable, unsupported, oversized, or timed-out signer evidence skips the shortcut, not the ordinary install. Signing-block reads use v2/v3 certificate digests without SDK build tools; they do not verify cryptographic authenticity. Verified installs save per-device history in `last-install.json`, not proof of the current installed signer. A record-write failure is a warning, not an install failure.

`app uninstall <pkg>` removes the package and checks that it is no longer installed. `--keep-data` preserves its data directory (`pm uninstall -k`). An absent package, including a retained record marked not installed, is an exit-0 no-op. A package still installed after removal produces `UNINSTALL_FAILED`. Install-record cleanup failures are warnings and do not turn verified removal or absence into failure.

## App lifecycle

```sh
adb-axi app start com.example.notes
adb-axi app start com.example.notes --fresh
adb-axi app stop com.example.notes
adb-axi app clear com.example.notes
adb-axi app kill com.example.notes
adb-axi app restore com.example.notes
adb-axi app death com.example.notes [--compare]
```

These commands require the package to be installed for the current Android OS user, selected once at the beginning of the operation. Start and stop leave other users' copies alone.

- **Start:** selects the first enabled package launcher candidate, or accepts an explicit activity as `com.example.notes/.MainActivity` or `--activity .MainActivity` (not both). `--fresh` force-stops first. Launch output distinguishes a recreated activity from an existing instance brought forward; an absent or unknown Android launch state stays `unknown`.
- **Observation:** start checks the launched activity's declared process, including a secondary UI process, not an unrelated surviving service. Any resumed activity of the package counts as foreground; `app.activity` names that resumed activity while `app.pid` identifies the launched activity's process. After launching, observation lasts at most two seconds within the remaining command deadline. If that window expires, the last complete observation is returned, which can report a live app with something else in front; without one, the command fails.
- **Stop:** force-stops and verifies main-process exit. “Already not running” is an exit-0 no-op when no main PID exists, but still sends the force-stop to end secondary processes.
- **Clear:** clears only the current Android user's app data. Android also stops the app's running processes for other Android users, leaving their data intact. `confirmed_by` names the verification used: Android's `pm clear` acknowledgement, plus a file check through `run-as` when the app is debuggable and that check succeeds. Remaining files fail verification; `--full` lists all of them rather than the default first ten. Retrying clear with `--full` performs the mutation again.

- **Kill:** simulates Android reclaiming a backgrounded app. An app in front is sent home first (HOME), then its oom adj is polled until `am kill` can act on it (adj 500 or higher; `am kill` silently does nothing to an app in front), then `am kill` runs and `pidof` verifies every process under the package's UID is gone. `cached_after_ms` is the wait for a killable oom adj (measured from HOME when the app was in front); the app need not reach the `cached` state, which some releases never report. A debuggable app that outlives `am kill` is killed through `run-as`. The task must still be in recents (`TASK_NOT_IN_RECENTS` otherwise). A process that is not running is an exit-0 no-op. Limit: UID-based checks can include other packages sharing the UID and do not cover isolated services with a different UID.
- **Restore:** starts the root activity of the app's task in recents with `am start -W -n` and nothing else (no launcher category, flags or `monkey`, which all start a fresh task). `launch` is the system's own launch state, or `unknown`; `new_process` comes from comparing pids before and after, not from the launch state. A process that is still running is brought forward as it is (`new_process: false`). The task's root activity must be startable by `am start -n`.
- **Death:** `kill` then `restore` under one 30 s deadline, with the pids and launch evidence of both. `--compare` uses `agent-device snapshot --json` to diff visible text only when the app is in front before the kill and after the restore. If it is not in front at either point, agent-device is unavailable, or a snapshot fails or is not a valid UI tree, the kill and restore still run; `COMPARE_UNAVAILABLE` carries their evidence. An empty text list in a valid tree is allowed. The snapshot reader collects `text`, `label` and `value` fields.

Use each command's `--help` for flags and defaults. Add `--json` for the same fields as the default TOON output, and put device selection flags after the command, for example `adb-axi app start com.example.notes --device emulator-5554`.

## Logs

`logs mark [name]` stores the device's own clock under a name, per device, so `logs` and `wait log` can cover one run without host and device clock skew shifting the window. Without a name it uses `mark-<HHMMSS>` from device time and prints the name. Take marks one at a time per device: simultaneous `logs mark` calls can lose one. `logs [--since <mark|dur>] [--pkg <pkg>] [--level <V|D|I|W|E>] [--grep <re>] [--full]` prints one bounded dump (every logcat call is `-d`, so it never streams): level counts, repeated lines collapsed in the display, and the last 50 rows or 4 kB. When rows were cut it says `shown: N of M lines` (N displayed rows, M matching lines) and suggests `--full`. `--full` always writes every matching line uncollapsed, with its own timestamp, to a file under `ADB_AXI_HOME/out/` (default `~/.adb-axi/out/`) and prints the path, even when no lines match (an empty file). Without `--since` the dump starts 15 minutes before device time. `wait log "<regex>" [--since <mark|dur>] [--timeout <dur>]` polls until a line matches (default timeout 15 s); without `--since` it only counts lines logged after the wait began. It ignores adbd's echoes of shell commands as match evidence, but `logs` still displays them.

When the first scanned log line is more than two seconds after the window start, `logs` notes its time and that earlier lines may have been dropped by the device log buffer. This is not proof of dropped lines: the device may simply have been quiet. The note uses the scan before host-side `--pkg`, `--level`, or `--grep` filtering; an empty scan has no note. With `--pkg` on API 31+, the note is unavailable because `logcat --uid` filters the scan at the device.

Known limits of `--pkg`:

- On API 31 and newer it is `logcat --uid`. On API 29 and 30, which have no `--uid`, it is a pid list: the app's current pids, the pids recorded when the window's mark was taken, and the pids ActivityManager names in "Start proc" lines inside the window. The list can miss a process that starts and dies between two reads.
- Both forms drop lines that other processes log about the app, such as ActivityManager's "Start proc" and "has died" lines and ANR reports from the system server.

`logs crash [--pkg <pkg>] [--since <mark|dur>] [--full]` counts Java crashes, ANRs and native crashes in the window (default 15 minutes) and says `crashes: 0 since <window> (...)` when there are none. Each crash prints its kind, time, process, exception, message, first app frame and frame count; one crash prints as a block, several as a table, the first 5 at most with `shown: N of M crashes`. `--full` writes every crash's whole trace to a file under `ADB_AXI_HOME/out/`. `--pkg` matches the process name in the report (the package or `<pkg>:<name>`), not uid or pid, and needs no installed-package check. Limits: an ANR has no stack in logcat, so it shows `app_frame: -` and `frames: 0`. Java crashes and ANRs starting before the window are excluded even if their reports continue into it. Native crashes use the fatal signal's time when available; the read includes a 60-second lead-in to recognize pre-window signals whose tombstones appear afterward. Signals older than that lead-in are unavailable, so a delayed tombstone may instead be counted at its header time.

## App data

`data db <pkg>` lists a debuggable app's databases (`name`, `size`, `wal`). `data db <pkg> "<sql>" [--db <name>] [--full]` runs one read-only statement (`SELECT`, `WITH`, `VALUES`, `EXPLAIN` or `PRAGMA`) on a host copy of the database and prints the rows. `--db` is required when the app has several databases.

- **Copy:** the database and its `-wal` file are copied with `run-as` and read with the host `sqlite3` (found like adb: `PATH`, then `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`), so rows still only in the WAL are included. The files are copied one at a time while the app runs, so a write made during the copy can be missed.
- **Read-only:** write statements, `ATTACH`, `VACUUM INTO`, multiple statements and sqlite3 dot-commands are refused before any device call. A `WITH` or `PRAGMA` that attempts a write is rejected by the read-only sqlite3 connection; sqlite3 safe mode blocks host-file functions.
- **Rows:** the first 50 are printed; when more exist, `shown: 50 of N rows` reports the total. Cells over 500 characters are cut. `--full` writes all rows with uncut cells to `ADB_AXI_HOME/out/` and prints the path, but only if rows or cells were cut. Results larger than 64 MB fail even with `--full`; narrow the query with `WHERE` or `LIMIT`.
- **Errors:** `APP_NOT_DEBUGGABLE` (`run-as` refused, release builds), `DB_NOT_FOUND` (names the databases that exist), `INVALID_OUTPUT` (invalid copied bytes, unreadable sqlite3 output or a result over 64 MB), `SQL_ERROR` (sqlite3's message), `SQLITE_NOT_FOUND` (no host sqlite3).
