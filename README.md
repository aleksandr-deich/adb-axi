# adb-axi

Truthful, token-efficient adb for agents. adb-axi wraps Android's `adb` with compact [TOON](https://github.com/toon-format/toon) output, a deadline on every device call, exit codes that mean what they say, and structured errors that name the next step. It follows the [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface) conventions.

It covers the device-state side of Android work: devices and their health, the app lifecycle including process-death checks, run-scoped logs and crashes, and app databases. UI driving is out of scope; pair it with a UI tool such as agent-device.

## Install

Requirements: Node 22 or newer, and the Android SDK platform-tools. Devices must run Android 10 (API 29) or newer.

```sh
npm install --global adb-axi
adb-axi --version
```

To build and install it from this repository instead:

```sh
git clone https://github.com/aleksandr-deich/adb-axi.git
cd adb-axi
npm ci
npm pack                                   # builds, then writes adb-axi-<version>.tgz
npm install --global ./adb-axi-*.tgz
adb-axi --version
```

adb is found on `PATH`, then in `$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools` and `~/Library/Android/sdk/platform-tools`. When none has it, every command fails with `ADB_NOT_FOUND` and lists the places it searched. `data db` also needs a host `sqlite3`, found the same way.

## Start here

Run `adb-axi` with no command for the live state, not a manual: the attached devices, the device a command would target, what is in its foreground, and its recent crashes.

```
$ adb-axi
bin: ~/.local/bin/adb-axi
description: "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data"
count: "1 attached, 1 online"
devices[1]{serial,avd,state,api,form}:
  emulator-5554,Pixel_10_Pro_XL,device,35,phone
target: emulator-5554
foreground: dev.probe/.MainActivity
crashes: "0 in the last 15m (no log mark yet)"
help[1]: Run `adb-axi logs --pkg dev.probe --since 1m` for recent app logs
```

Crashes are counted since the target's latest `logs mark`, or in the last 15 minutes when it has none, and the window is printed with the mark's age by the host clock (`latest mark t1, set 3 d ago`), so a stale mark shows even when the device clock is off. `adb-axi --device <serial|avd>` shows one device's foreground and crashes when several are online. With no device attached it says so (`count: "0 attached, 0 online"`, `target: "-"`) and exits 0. When several devices are online and none is selected, it lists them, shows `target: "-"` with the reason, and does not fail. A device read that fails shows `-` for that field, and the first help line points at `doctor` for that device.

`adb-axi --help` lists every command; `adb-axi <command> --help` gives its arguments, its flags with their defaults, and examples.

## The device model

Several emulators at once is the normal case, so adb-axi never guesses which device you meant. The target is, first match wins:

1. `--device <serial|avd>` (alias `-s`), as a serial such as `emulator-5556` or an AVD name such as `Pixel_Tablet`;
2. the `ANDROID_SERIAL` environment variable;
3. the only online device.

Anything else fails at once, before any work:

```
$ adb-axi logs --pkg com.example.notes
error: 2 devices are online and none is selected
code: DEVICE_AMBIGUOUS
devices[2]{serial,avd,form}:
  emulator-5554,Pixel_10_Pro_XL,phone
  emulator-5556,Pixel_Tablet,tablet
help[2]: Run `adb-axi logs --pkg com.example.notes --device <serial or avd>`,Or export ANDROID_SERIAL=<serial> in this shell
```

The target's state is checked from `adb devices -l` before anything else is sent to it, so nothing can block on adb's `- waiting for device -`: an offline device is `DEVICE_OFFLINE`, an unauthorized one `DEVICE_UNAUTHORIZED`, and a serial or AVD name that is not attached `DEVICE_NOT_FOUND`, all immediately. An AVD name used by two emulators is `DEVICE_AMBIGUOUS`, including when two unavailable emulators match only by their last-known names; the error lists their serials so you can pick one. An unavailable emulator may not tell its AVD name; it then shows the name adb-axi last saw on its serial as `<avd> (last known)`, and selecting it by that name reports its unavailable state (`DEVICE_OFFLINE` or `DEVICE_UNAUTHORIZED`). An online emulator whose console cannot be read is never identified by a cached name. A device that goes away while a command runs on it (adb says `error: closed`) is `DEVICE_OFFLINE` or `DEVICE_NOT_FOUND` from what `adb devices` says right after; the command is never sent again. Every adb call then names the device explicitly (`adb -s <serial> ...`) with an argument list, never a host shell string.

Flags go after the command. `adb-axi -s emulator-5554 logs` exits 2 and prints the corrected command, `adb-axi logs --device emulator-5554`, without touching adb. The home view is the exception: `adb-axi --device emulator-5554` (or `-s`, `--timeout`, `--debug`) works without a command.

State that adb-axi keeps (log marks, install records, cached AVD names) lives per device serial under `~/.adb-axi/<serial>/`. Serial numbers can be reused; log marks are checked against the current boot (see [Logs and crashes](#logs-and-crashes)). `--full` output files go to `~/.adb-axi/out/`. Set `ADB_AXI_HOME` to use another directory.

## Output, errors and deadlines

- **Output.** TOON on stdout; `--json` prints the same results as JSON on every command (`adb-axi --json` is the home view). A mutation leads with `ok: <verb> <target> -> <resulting state>`, and one that found the state already true says `(no-op)`; its JSON also carries `"noop": true` or `false`. Lists print a count, and an empty result says 0. Next steps come as `help[N]` lines built from the actual target, and only ever name commands and flags this build ships; device-scoped suggestions keep the `--device` you passed. Text of several lines, such as `shell` output, prints in TOON as a list with one line per row and in JSON as one string. Progress goes to stderr; `--debug` also prints every adb argv there.
- **Exit codes.** 0 when the requested state is true, including "already" no-ops and reads that find nothing; 1 when it is not; 2 for a usage error (unknown flag or value, missing argument, a flag before the command), which lists the valid flags.
- **Errors.** One shape on stdout: `error` (one sentence naming the target), a stable `code`, any structured fields that explain it (`last`, `devices`, `exit`, `stderr`, `detail`), then `help`. Raw adb text never becomes the message; it may appear in `detail`.
- **Deadlines.** Every command has one deadline that all its device calls share, and a call that passes it is killed: 15 s by default, 180 s for `app install`, 120 s for `wait boot` and 30 s for `app death`. `--timeout <dur>` overrides it (`500ms`, `30s`, `5m`). A step that runs out of time is `TIMEOUT` and names the step; on a device step its help points at `doctor` first, because a hung device does not answer a longer deadline either. A wait that runs out is `WAIT_TIMEOUT` with the last observation. The deadline running out while adb-axi asks the adb server for its devices is also `TIMEOUT`, never `ADB_SERVER_UNREACHABLE`, which is kept for a server that refuses or does not answer within 15 s.
- **Truncation.** `logs` and `shell` print at most 50 lines or 4 kB, and `data db` at most 50 rows, saying how many were shown out of how many; long single fields are cut with their full length. `--full` writes the complete text to a file and prints its path; `logs` and `data db` write one only when something was cut.

## Commands

| Command                                                      | What it answers                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `adb-axi`                                                    | Devices, the resolved target, its foreground app and recent crashes            |
| `devices [--all] [--fields <list>]`                          | Every attached device with its AVD name, state, API level and form             |
| `doctor`                                                     | Host, adb server and target checks for things that break a run                 |
| `doctor ui [--fix]`                                          | What holds UiAutomation, and clearing resident, leaked or wedged holders       |
| `wait boot`                                                  | Waits until the device is online and has finished booting                      |
| `wait app <pkg> --state <foreground\|running\|stopped>`      | Waits until an app reaches a state                                             |
| `wait log <regex> [--since <mark\|dur>]`                     | Waits until a log line matches                                                 |
| `app current`                                                | The foreground app: package, activity and pid                                  |
| `app list [--all] [--grep <re>]`                             | Installed packages with a count                                                |
| `app info <pkg>`                                             | One package: installed, version, debuggable, pid, foreground, data size        |
| `app install <apk> [--clean-data] [--if-changed]`            | Installs and waits until the new version is live, keeping app data by default  |
| `app uninstall <pkg> [--keep-data]`                          | Removes a package; a missing package is a no-op                                |
| `app start <pkg>[/<activity>] [--fresh] [--activity <name>]` | Starts an app and reports what is in front and how it launched                 |
| `app stop <pkg>`                                             | Force-stops an app and verifies its process is gone                            |
| `app clear <pkg> [--full]`                                   | Clears the app's data and verifies it                                          |
| `app kill <pkg>`                                             | Kills the process the way the system does, keeping its task in recents         |
| `app restore <pkg>`                                          | Reopens the app's task from recents so its saved state is restored             |
| `app death <pkg> [--compare]`                                | `app kill` then `app restore` in one call, with the evidence of both           |
| `logs mark [<name>]`                                         | Records the device clock under a name, to scope later reads                    |
| `logs [--since] [--pkg] [--level] [--grep] [--full]`         | One bounded log dump for a window, with level counts and repeats collapsed     |
| `logs crash [--pkg <pkg>] [--since <mark\|dur>] [--full]`    | Java crashes, ANRs and native crashes in a window                              |
| `data db <pkg> [<sql>] [--db <name>] [--full]`               | An app's databases, or one read-only query on a copy that includes the WAL     |
| `shell -- <cmd>`                                             | One device shell command with its real exit code                               |
| `update [--check]`                                           | Upgrades adb-axi from npm, or compares against the latest version with --check |

`--version` (or `-v`, `-V`) prints the bare version without loading the command tree.

### Devices and health

`devices` lists every attached device as `serial, avd, state, api, form`. `avd` comes from the emulator console (`-` for physical devices or an unreadable online emulator; unavailable emulators can show a cached name marked `(last known)`), and `form` is `phone` or `tablet` by the smallest screen width (600 dp and up is a tablet). Devices in unusual states (recovery, sideload) are counted and shown with `--all`. `--fields` adds columns from `boot`, `data_free`, `model`, `abi` and `uptime`.

`doctor [--device <serial|avd>]` reports on adb, the server, device selection, boot, the device clock (a warning when it is more than a minute from the host's, since log times and marks use it), free space on `/data`, animation scales, the default keyboard, running instrumentations and the emulator console token. Checks that depend on an unavailable device are omitted. Each check is `ok`, `warn` or `failed` with a one-line detail; the command exits 1 if any check fails and 0 if there are only warnings. It reports problems but does not fix them; when an instrumentation holds UiAutomation, its help points at `doctor ui`. The Android CLI's own UI server is a warning when resident between `android` commands or live and in use by one; a wedged or leaked server is a failure.

`doctor ui [--fix]` lists what holds the device's single UiAutomation connection: instrumentations started with one (the Android CLI's server, agent-device's snapshot instrumentation, `am instrument` and Gradle `connected*` runs) and known `app_process` servers (mobilecli's `DeviceServer`, `uiautomator`). Each holder is `live` when a host process of its tool may still use it (for mobilecli, only through an `adb forward` to this device), `wedged` when its own pid logged `Cannot call disconnect() while connecting`, `resident` for the Android CLI's server with no `android` command running (kept on purpose between commands; it only blocks instrumentation tests, such as Gradle `connected*` tasks), and `leaked` otherwise. If the host process list or the adb forwards cannot be read, the affected holders count as `live`. The report exits 0 when UiAutomation is free or held only by live or resident holders, and 1 when a holder is leaked or wedged. `--fix` clears resident Android CLI servers as well as leaked and wedged holders: it kills `app_process` servers and force-stops instrumentation runner packages and packages hosting their running target processes (which also stops those packages' other app processes). It never force-stops a package also used by a live holder; a holder blocked that way remains, with a help line saying why. After checking again, it exits 0 when UiAutomation is free, exits 1 with remaining non-live holders (including resident ones that could not be cleared), or fails with `HOLDER_PROTECTED`, naming what would release the live holders, when only live holders remain.

`wait boot` waits for the device to come online and `sys.boot_completed` to become `1`. A device that is not attached yet or offline is waited out rather than an error. Once it selects a device, it keeps waiting for that same device even if another comes online. On `WAIT_TIMEOUT`, `last` holds `state`, `boot_completed` and `uptime_s`; unknown readings are `-`.

### Apps

`app current`, `app list` and `app info` read without changing anything. `app list` shows user packages and counts the hidden system ones (`--all` includes them, `--grep` filters by name); `app info` of a package that is not installed answers `installed: false` with exit 0. `wait app <pkg> --state <foreground|running|stopped>` polls until the state is true and prints `waited_ms`.

`app install <apk>` uses `adb install -r` to keep existing app data. Without `--clean-data`, its success line says `with data kept` when a package record exists (including an uninstalled record with retained data), or `(fresh install)` when none exists. It then waits for the package manager to report the APK's versionCode, and prints whether the installed app is `debuggable`. When a build of the same version replaces another, `changed` says what the version does not: `debuggable: true -> false`, or a signer that differs from the last install adb-axi recorded. `--clean-data` installs, clears data, and verifies the version again, even with `--if-changed`. If the APK metadata cannot be read, `--clean-data` refuses the install because the package to wipe is unknown; otherwise an unreadable APK can still be installed, and the output says its version was not verified.

Without a requested wipe, `--if-changed` skips only when the installed versionCode and the target device's signer evidence match the APK. Unreadable, unsupported, oversized or timed-out signer evidence skips the shortcut, not the ordinary install. Signing-block reads use v2/v3 certificate digests without SDK build tools; they do not verify cryptographic authenticity. Verified installs save per-device history in `last-install.json`, not proof of the current installed signer. A record-write failure is a warning, not an install failure.

`app uninstall <pkg>` removes the package and checks that it is no longer installed. `--keep-data` preserves its data directory (`pm uninstall -k`). An absent package, including a retained record marked not installed, is an exit-0 no-op. A package still installed afterwards is `UNINSTALL_FAILED`. Install-record cleanup failures are warnings.

The lifecycle commands require the package to be installed for the current Android user, selected once at the start of the command. Start and stop leave other users' copies alone.

- **Start:** selects the first enabled launcher activity of the package, or takes an explicit one as `com.example.notes/.MainActivity` or `--activity .MainActivity` (not both). `--fresh` force-stops first. The output tells a recreated activity from an existing instance brought forward; an absent or unknown launch state stays `unknown`. Start checks the launched activity's own process, including a secondary UI process. Any resumed activity of the package counts as foreground; `app.activity` names that activity while `app.pid` is the launched activity's process. Observation lasts at most two seconds within the deadline; when it expires, the last complete observation is returned, which can show a live app with something else in front.
- **Stop:** force-stops and verifies the main process exited. "Already not running" is an exit-0 no-op when no main pid exists, but the force-stop is still sent to end secondary processes.
- **Clear:** clears only the current Android user's app data. Android also stops the app's running processes for other users, leaving their data intact. `confirmed_by` names the verification used: the `pm clear` acknowledgement, plus a file check through `run-as` when the app is debuggable and that check succeeds. Remaining files fail verification; `--full` lists all of them rather than the first ten. Retrying with `--full` clears again.
- **Kill:** simulates Android reclaiming a backgrounded app. An app in front is sent home first (HOME), then its oom adj is polled until `am kill` can act on it (adj 500 or higher; `am kill` silently does nothing to an app in front), then `am kill` runs and `pidof` verifies every process under the package's UID is gone. `cached_after_ms` is the wait for a killable oom adj; the app need not reach the `cached` state, which some releases never report. A debuggable app that outlives `am kill` is killed through `run-as`. The task must still be in recents (`TASK_NOT_IN_RECENTS` otherwise). A process that is not running is an exit-0 no-op. UID-based checks can include other packages sharing the UID, and do not cover isolated services with a different UID.
- **Restore:** starts the root activity of the app's task in recents with `am start -W -n` and nothing else: no launcher category, flags or `monkey`, which all start a fresh task. `launch` is the system's own launch state, or `unknown`; `new_process` comes from comparing pids before and after. A process that is still running is brought forward as it is (`new_process: false`).
- **Death:** `kill` then `restore` under one 30 s deadline, with the pids and launch evidence of both. `--compare` uses `agent-device snapshot --json` to diff the visible text, only when the app is in front before the kill and after the restore. If it is not in front at either point, agent-device is unavailable, or a snapshot fails or is not a valid UI tree, the kill and restore still run, and `COMPARE_UNAVAILABLE` carries their evidence.

### Logs and crashes

`logs mark [name]` stores the device's own clock under a name, per device, so `logs`, `logs crash` and `wait log` can cover exactly one run without host and device clock skew shifting the window. Without a name it uses `mark-<HHMMSS>` from device time. Take marks one at a time per device: simultaneous `logs mark` calls can lose one. `--since` takes a mark name or a duration back from now. When the device's boot ID can be read, marks are bound to it: a new boot or an emulator reusing the serial drops earlier marks with a one-time `marks_note` (also on errors). Older marks without a boot ID are dropped too. When the boot ID cannot be read, existing marks are kept but not used: the home view falls back to its no-mark window with a notice, and named windows or new marks return `MARK_UNVERIFIED`. Retry marking once the boot ID is readable, or use a duration such as `--since 5m`.

`logs` prints one bounded dump (every logcat call is `-d`, so it never streams): level counts (`counts.matched` is 0 if nothing matches), repeated lines collapsed, and the last 50 rows or 4 kB. When the table differs from the matched lines, `shown` says how: `rows` (how many of the rows are on screen, and how many of the oldest were left out), `lines` (how many lines matched, and how many were folded into repeated rows) and `cut` (messages cut at 500 characters, or a row cut at 4 kB). `--full` writes every matching line uncollapsed, with its own timestamp, to a file and prints the path when rows were omitted, repeats folded, or content cut; otherwise it says `not written: nothing was cut`. A dump that contains a crash points at `logs crash` for the same window. Without `--since` the dump starts 15 minutes back. When the first scanned line is more than two seconds after the window start, `logs` notes that earlier lines may have been dropped by the device log buffer; the device may also simply have been quiet.

`--pkg` follows the app with `logcat --uid` on API 31 and newer. On API 29 and 30, which have no `--uid`, it uses a pid list: the app's current pids, those recorded when the window's mark was taken, and those ActivityManager names in "Start proc" lines inside the window; it can miss a process that starts and dies between two reads. Both forms drop lines that other processes log about the app, such as ActivityManager's "has died" lines and ANR reports, which is why `logs crash` matches by name instead.

`wait log <regex>` polls until a log line matches; without `--since` it counts only lines logged after the wait began. It ignores adbd's echoes of shell commands as match evidence.

`logs crash` counts Java crashes, ANRs and native crashes in the window (default 15 minutes) and says `crashes: 0 since <window>` when there are none. Each crash prints its kind, time, process, exception, message, first app frame and frame count; one prints as a block, several as a table, at most 5 with `shown: N of M crashes`. `--full` writes every crash's whole trace to a file. `--pkg` matches the process name in the report (the package or `<pkg>:<name>`), not uid or pid. An ANR has no stack in logcat, so it shows `app_frame: -` and `frames: 0`. Crashes that start before the window are not counted, even when their reports continue into it. Native crashes use the fatal signal's time when it is available.

### App data and shell

`data db <pkg>` lists a debuggable app's databases (`name`, `size`, `wal`). `data db <pkg> "<sql>" [--db <name>]` runs one read-only statement (`SELECT`, `WITH`, `VALUES`, `EXPLAIN` or `PRAGMA`) on a host copy and prints the rows; `--db` is required when the app has several databases.

- **Copy:** the database and its `-wal` file are copied with `run-as` and read with the host `sqlite3`, so rows still only in the WAL are included. The files are copied one at a time while the app runs, so a write made during the copy can be missed. The copied bytes are checked, because `exec-out` exits 0 even when it prints an error instead of the file.
- **Read-only:** write statements, `ATTACH`, `VACUUM INTO`, multiple statements and sqlite3 dot-commands are refused before any device call. A `WITH` or `PRAGMA` that attempts a write is rejected by the read-only connection, and sqlite3 safe mode blocks host-file functions.
- **Rows:** the first 50 are printed, with `shown: 50 of N rows` when more exist. Cells over 500 characters are cut. `--full` writes all rows with uncut cells to a file, only when something was cut. Results larger than 64 MB fail even with `--full`.
- **Errors:** `APP_NOT_DEBUGGABLE` (`run-as` refused, as for release builds), `DB_NOT_FOUND` (names the databases that exist), `INVALID_OUTPUT`, `SQL_ERROR` (sqlite3's message) and `SQLITE_NOT_FOUND`.

`shell -- '<cmd>'` runs one command string in the device shell through `shell_v2`, so the remote exit code is real. adb-axi's own flags, such as `--device`, go before `--`: everything after it runs on the device. A non-zero exit is exit 1 with `code: REMOTE_EXIT`, the remote `exit` and its `stderr`.

Device settings such as dark mode and display density have no command of their own; `shell` changes them. Read the value first, so you can put it back:

```sh
adb-axi shell --device emulator-5554 -- 'cmd uimode night; wm density'   # current values
adb-axi shell --device emulator-5554 -- 'cmd uimode night yes; wm density 560'
adb-axi shell --device emulator-5554 -- 'cmd uimode night; wm density'   # check the change
adb-axi shell --device emulator-5554 -- 'cmd uimode night no; wm density reset'
```

`cmd uimode night` prints `Night mode: yes` or `no`, and `wm density` prints the physical density and any override. Restore the values you read, rather than assuming the defaults (`night no` and `density reset` are the defaults).

## Walkthrough: does an app survive process death?

The manual check: put some state on screen, send the app to the background, let the system kill its process, reopen it from recents, and see whether the state came back. With adb-axi it takes no sleeps, and every step proves its own outcome. The UI steps can use any UI tool, for example agent-device.

```
$ adb-axi logs mark before-kill
ok: "mark before-kill -> 2026-10-01 07:58:47.000 on emulator-5554"

# UI step: put the state on screen, for example type into a field

$ adb-axi app kill dev.probe
ok: "kill dev.probe -> process gone, task kept in recents"
kill:
  pid_before: 8235
  pid_after: null
  backgrounded_first: true
  cached_after_ms: 964
  method: am kill
help[2]: Run `adb-axi app restore dev.probe` to reopen it from recents,Run `adb-axi logs --pkg dev.probe --since 30s` to see what it logged while dying

$ adb-axi app restore dev.probe
ok: restore dev.probe -> foreground from recents (new process)
app:
  activity: .MainActivity
  pid: 9001
  launch: cold
  new_process: true

# UI step: check the state is back

$ adb-axi logs crash --pkg dev.probe --since before-kill
crashes: "0 since before-kill (13 s, 0 lines scanned)"
```

The death is proven by the pid, the restore by `launch: cold` and a new pid, and the crash window covers exactly this run. `app death dev.probe --compare` does the kill, the restore and a before-and-after comparison of the visible text in one call when agent-device is installed.

These transcripts are real adb-axi output, recorded against the scripted fake adb the tests use, so they show the shape of the data rather than one particular device.

## Development

```sh
npm ci
npm run check   # build, typecheck, lint, format check, tests
```

`npm run check` runs the built CLI against a scripted fake adb in `test/fake-adb`, so no device or emulator is needed; `test/fixtures/EVIDENCE.md` maps the recorded evidence cases to their scenarios and tests. The separate real-emulator suite runs in CI; see [real-device checks](test/device/README.md) for local usage and coverage.

## License

MIT
