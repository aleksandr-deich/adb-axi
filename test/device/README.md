# Real-device tools

Nothing here runs in `npm test` or `npm run check`. The device checks run on every pull request and on pushes to `main`, against API 30 and 35 emulators (`.github/workflows/emulator.yml`). Everything here changes the devices it touches, so run it only on emulators reserved for the job, and always name each one by serial.

## Device checks (`*.test.ts`)

The checks drive adb-axi installed from a packed tarball against one emulator, use the probe app for app and log scenarios, and wait for app and log events with adb-axi's own `wait` commands instead of sleeping. The numbers follow the v0.1 real-emulator checks; check 6 needs two devices and is a local step (see below):

| File              | What it checks                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `1-process-death` | `app kill` then `app restore`: the saved counter survives, the volatile one resets, a new process, and no crash since the mark        |
| `2-app-start`     | `app start` on the app in front is not recreated; `--fresh` is a cold start                                                           |
| `3-data-db`       | a row still only in `probe.db-wal` comes back from `data db`; the release build gives `APP_NOT_DEBUGGABLE`                            |
| `4-doctor-ui`     | `doctor ui` reports UiAutomation free and exits 0                                                                                     |
| `5-logs-crash`    | a Java crash counts once and zero after the next mark; a native crash and an ANR are reported; the ANR report is in the system buffer |
| `7-offline`       | runs last and stops the emulator; a command against it then fails with a typed error in under 2 s                                     |

Run them against an emulator nobody else is using. The last check shuts it down:

```
ANDROID_SERIAL=emulator-5554 npm run test:device
```

The setup packs and installs adb-axi into a temporary prefix (set `ADB_AXI_BIN` to use an installed one instead) and uses a fresh `ADB_AXI_HOME`. Every adb-axi call and its output is written to `test-results/device/<check>.txt`; CI uploads that folder as the `device-transcripts-api-<level>` artifact.

## Local-only checks

These need what one CI emulator does not have. Run them by hand before a release.

### UiAutomation holder (`doctor ui`)

A resident holder needs the Android CLI. With one emulator (here `emulator-5554`):

```
android layout --device=emulator-5554 > /dev/null    # leaves com.android.cli.interact.instrumentation resident
adb-axi doctor ui --device emulator-5554             # resident after android exits, blocks instrumentation tests, exit 0
adb-axi doctor --device emulator-5554                # instrumentation: warn, exit 0
adb-axi doctor ui --fix --device emulator-5554       # clears it, exit 0
adb-axi doctor ui --device emulator-5554             # uiautomation: free
android layout --device=emulator-5554 > /dev/null    # works again
```

### Two devices

Start the phone and the tablet AVD, then check selection:

```
android emulator start --headless Pixel_10_Pro_XL
android emulator start --headless medium_tablet
unset ANDROID_SERIAL
adb-axi devices                                      # two rows: Pixel_10_Pro_XL phone, medium_tablet tablet
adb-axi app current                                  # DEVICE_AMBIGUOUS
adb-axi logs crash                                   # DEVICE_AMBIGUOUS
adb-axi app current --device Pixel_10_Pro_XL         # the phone's foreground app
adb-axi app current --device medium_tablet           # the tablet's foreground app
android emulator stop Pixel_10_Pro_XL
android emulator stop medium_tablet
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
