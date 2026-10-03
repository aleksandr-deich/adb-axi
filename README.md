# adb-axi

An agent-friendly command-line wrapper around adb, following the AXI conventions: token-efficient output, truthful exit codes, deadlines on every device call, and structured errors.

It covers the device-state side of Android work: device health, app lifecycle including process-death checks, run-scoped logs and crashes, and app data. UI driving is out of scope.

**Status:** in development. Commands ship one slice at a time; `adb-axi --help` lists the ones available in your build.

`app install <apk>` uses `adb install -r` to keep app data, then waits for the package manager to report the APK's versionCode. Its default deadline is 180 seconds; override it with `--timeout <dur>`. `--clean-data` installs, clears data, and verifies the version again, even when combined with `--if-changed`. If the APK metadata cannot be read, `--clean-data` refuses the install because the package to wipe is unknown; otherwise an unreadable APK can still be installed, with output stating that its version was not verified.

Without a requested wipe, `--if-changed` skips only when current installed versionCode and target-device signer evidence match the APK. Unreadable, unsupported, oversized, or timed-out signer evidence skips the shortcut, not the ordinary install. Signing-block reads use v2/v3 certificate digests without SDK build tools; they do not verify cryptographic authenticity. Verified installs save per-device history in `last-install.json`, not proof of the current installed signer. A record-write failure is a warning, not an install failure.

`app uninstall <pkg>` removes the package and checks that it is no longer installed. `--keep-data` preserves its data directory (`pm uninstall -k`). An absent package, including a retained record marked not installed, is an exit-0 no-op. A package still installed after removal produces `UNINSTALL_FAILED`. Install-record cleanup failures are warnings and do not turn verified removal or absence into failure.

## App lifecycle

```sh
adb-axi app start com.example.notes
adb-axi app start com.example.notes --fresh
adb-axi app stop com.example.notes
adb-axi app clear com.example.notes
```

These commands require the package to be installed for the current Android OS user, selected once at the beginning of the operation. Start and stop leave other users' copies alone.

- **Start:** selects the first enabled package launcher candidate, or accepts an explicit activity as `com.example.notes/.MainActivity` or `--activity .MainActivity` (not both). `--fresh` force-stops first. Launch output distinguishes a recreated activity from an existing instance brought forward; an absent or unknown Android launch state stays `unknown`.
- **Observation:** start checks the launched activity's declared process, including a secondary UI process, not an unrelated surviving service. Any resumed activity of the package counts as foreground; `app.activity` names that resumed activity while `app.pid` identifies the launched activity's process. After launching, observation lasts at most two seconds within the remaining command deadline. If that window expires, the last complete observation is returned, which can report a live app with something else in front; without one, the command fails.
- **Stop:** force-stops and verifies main-process exit. “Already not running” is an exit-0 no-op when no main PID exists, but still sends the force-stop to end secondary processes.
- **Clear:** clears only the current Android user's app data. Android also stops the app's running processes for other Android users, leaving their data intact. `confirmed_by` names the verification used: Android's `pm clear` acknowledgement, plus a file check through `run-as` when the app is debuggable and that check succeeds. Remaining files fail verification; `--full` lists all of them rather than the default first ten. Retrying clear with `--full` performs the mutation again.

Use each command's `--help` for flags and defaults. Add `--json` for the same fields as the default TOON output, and put device selection flags after the command, for example `adb-axi app start com.example.notes --device emulator-5554`.

## Logs

`logs mark [name]` stores the device's own clock under a name, per device, so `logs` and `wait log` can cover one run without host and device clock skew shifting the window. Without a name it uses `mark-<HHMMSS>` from device time and prints the name. Take marks one at a time per device: simultaneous `logs mark` calls can lose one. `logs [--since <mark|dur>] [--pkg <pkg>] [--level <V|D|I|W|E>] [--grep <re>] [--full]` prints one bounded dump (every logcat call is `-d`, so it never streams): level counts, repeated lines collapsed in the display, and the last 50 rows or 4 kB. When rows were cut it says `shown: N of M lines` (N displayed rows, M matching lines) and suggests `--full`. `--full` always writes every matching line uncollapsed, with its own timestamp, to a file under `ADB_AXI_HOME/out/` (default `~/.adb-axi/out/`) and prints the path, even when no lines match (an empty file). Without `--since` the dump starts 15 minutes before device time. `wait log "<regex>" [--since <mark|dur>] [--timeout <dur>]` polls until a line matches (default timeout 15 s); without `--since` it only counts lines logged after the wait began.

Known limits of `--pkg`:

- On API 31 and newer it is `logcat --uid`. On API 29 and 30, which have no `--uid`, it is a pid list: the app's current pids, the pids recorded when the window's mark was taken, and the pids ActivityManager names in "Start proc" lines inside the window. The list can miss a process that starts and dies between two reads.
- Both forms drop lines that other processes log about the app, such as ActivityManager's "Start proc" and "has died" lines and ANR reports from the system server.

## App data

`data db <pkg>` lists a debuggable app's databases (`name`, `size`, `wal`). `data db <pkg> "<sql>" [--db <name>] [--full]` runs one read-only statement (`SELECT`, `WITH`, `VALUES`, `EXPLAIN` or `PRAGMA`) on a host copy of the database and prints the rows. `--db` is required when the app has several databases.

- **Copy:** the database and its `-wal` file are copied with `run-as` and read with the host `sqlite3` (found like adb: `PATH`, then `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`), so rows still only in the WAL are included. The files are copied one at a time while the app runs, so a write made during the copy can be missed.
- **Read-only:** write statements, `ATTACH`, `VACUUM INTO`, several statements at once and sqlite3 dot-commands are refused before any device call.
- **Rows:** the first 50 are printed with `shown: 50 of N rows`; cells over 500 characters are cut. `--full` writes the whole result, uncut, to `ADB_AXI_HOME/out/` and prints the path, only when something was cut.
- **Errors:** `APP_NOT_DEBUGGABLE` (`run-as` refused, release builds), `DB_NOT_FOUND` (names the databases that exist), `INVALID_OUTPUT` (copied bytes are not SQLite), `SQL_ERROR` (sqlite3's message), `SQLITE_NOT_FOUND` (no host sqlite3).
