# Real-device tools

Nothing here runs in `npm test` or `npm run check`. The device checks run on every pull request and on pushes to `main`, against API 29, 30 and 35 emulators (`.github/workflows/emulator.yml`). Everything here changes the devices it touches, so run it only on emulators reserved for the job, and always name each one by serial.

## Device checks (`*.test.ts`)

The checks drive adb-axi installed from a packed tarball against one emulator, use the probe app for app and log scenarios, and wait for app and log events with adb-axi's own `wait` commands instead of sleeping. Each expected result is grounded in probe state, Android window focus, kernel process state or database bytes, rather than another adb-axi summary. The original six files remain, with lifecycle, observation and device-identity coverage added:

| File                | What it checks                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0-app-lifecycle`   | install/reinstall, if-changed/clean-data, stop/clear, uninstall/keep-data and missing packages, with real package/process/private-data evidence |
| `1-process-death`   | `app kill` then `app restore`: the saved counter survives, the volatile one resets, a new process, and no crash since the mark                  |
| `2-app-start`       | `app start` on the app in front is not recreated; `--fresh` is a cold start                                                                     |
| `3-data-db`         | a row still only in `probe.db-wal` comes back from `data db`; the release build gives `APP_NOT_DEBUGGABLE`                                      |
| `4-doctor-ui`       | `doctor ui` reports UiAutomation free and exits 0                                                                                               |
| `5-logs-crash`      | a Java crash counts once and zero after the next mark; a native crash and an ANR are reported; the ANR report is in the system buffer           |
| `6-app-observation` | named log windows across process restarts, filters/mark replacement, wait transitions, package metadata and actual Room/WAL reads               |
| `6-device-state`    | the target's serial, AVD name and API match device properties; `app current` matches independent window-focus and kernel-PID queries            |
| `7-offline`         | runs last and stops the emulator; a command against it then fails with a typed error in under 2 s                                               |

Run them against an emulator nobody else is using. The last check shuts it down:

```
ANDROID_SERIAL=emulator-5554 npm run test:device
```

The setup packs and installs adb-axi into a temporary prefix (set `ADB_AXI_BIN` to use an installed one instead) and uses a fresh `ADB_AXI_HOME` for every test. Probe installs clear package data before independent scenarios; log marks scope observations without clearing the device's logs. The crash file temporarily suppresses Android error dialogs and restores the original setting before continuing. Its ANR stimulus requires actual input-window focus and queues two concurrent keyboard events: Android 10 detects the unfinished first event when the second waits behind it, whereas newer Android versions track unfinished events directly. Before any check runs it waits until the emulator's package and activity services answer steadily, since `sys.boot_completed` alone can come seconds before they do. Every adb-axi call, exit code, duration and output is written to `test-results/device/<check>.txt`. Failed tests also save the last 2,000 logcat lines in `<check>.logcat.txt`; CI uploads that folder as the `device-transcripts-api-<level>` artifact. Temporary CLI state and a locally packed installation are removed at teardown.

Ordinary flows belong in this packed-package suite. Keep deterministic synthetic tests for transport faults, hung commands, deadline expiry, malformed input and branches that cannot be reliably reproduced on an emulator; keep pure parsing, formatting and algorithm tests. Remove a fake-backed case only after equivalent independently grounded device assertions pass, preserving its output-format checks.

## Local-only checks

These need what one CI emulator does not have. Run them by hand before a release.

### UiAutomation holder (`doctor ui`)

A resident holder needs the Android CLI. With one emulator (here `emulator-5554`):

```
android layout --device=emulator-5554 > /dev/null    # leaves com.android.cli.interact.instrumentation resident
adb-axi doctor ui --device emulator-5554             # resident after android exits, exit 0
adb-axi doctor --device emulator-5554                # instrumentation: warn, exit 0
adb-axi doctor ui --fix --device emulator-5554       # clears it, exit 0
adb-axi doctor ui --device emulator-5554             # uiautomation: free
android layout --device=emulator-5554 > /dev/null    # works again
```

### Two devices

Reserve two disposable emulators first. The automated `6-device-state` assertions work with one or several attached emulators, but do not assert ambiguous selection. To check that locally, use only emulators you own and substitute their serials below; never reuse an occupied emulator or a physical device:

```
unset ANDROID_SERIAL
adb-axi devices                                      # both reserved emulators are listed
adb-axi app current                                  # DEVICE_AMBIGUOUS when both are online
adb-axi logs crash                                   # DEVICE_AMBIGUOUS when both are online
adb-axi app current --device <first-serial>           # first emulator's foreground app
adb-axi app current --device <second-serial>          # second emulator's foreground app
```

## Probe app (`probe-app/`)

`dev.probe` is a one-screen Compose app that the real-device checks drive with explicit intents only, so no UI tool is needed:

```
adb -s <serial> shell am start -n dev.probe/.MainActivity --es probe <action>
```

| Action   | Effect                                                                                     |
| -------- | ------------------------------------------------------------------------------------------ |
| `inc`    | adds 1 to `saved` (`rememberSaveable`, survives process death) and `volatile` (`remember`) |
| `state`  | logs the current state                                                                     |
| `write`  | inserts a row into the Room database `probe.db` (WAL); the row stays in `probe.db-wal`     |
| `finish` | finishes the activity and leaves the process alive, so the next start is warm              |
| `crash`  | throws on the main thread (Java crash)                                                     |
| `native` | sends itself SIGSEGV (native crash with a tombstone)                                       |
| `anr`    | blocks the main thread for 30 s; input sent meanwhile ends in an ANR                       |

`MainActivity` is `singleTop`, so an action sent while it is on top reaches `onNewIntent`. Every state change logs one line with tag `ProbeState`, the oracle the checks read from logcat:

```
ProbeState: event=inc saved=3 volatile=3 rows=0 restored=false pid=4321
```

Build both variants (debuggable debug, non-debuggable release signed with the debug key) and refresh the committed fixtures:

```
cd test/device/probe-app
./gradlew clean assembleDebug assembleRelease
cp app/build/outputs/apk/debug/app-debug.apk ../../fixtures/apk/probe-debug.apk
cp app/build/outputs/apk/release/app-release.apk ../../fixtures/apk/probe-release.apk
```

## Capture (`capture.ts`)

Runs the adb commands adb-axi reads, plus the probe's actions, and saves the raw output under `test/fixtures/captured/<api>/` (host-level output under `captured/host/`):

```
npm run capture -- --serial emulator-5554 --serial emulator-5556
```

It installs, crashes and uninstalls `dev.probe`, clears logcat and presses HOME on every device named. `test/fixtures/EVIDENCE.md` describes each file and the facts recorded in each `index.json`.
