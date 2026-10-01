# Real-device tools

Nothing here runs in `npm test` or CI. Everything changes the devices it touches, so run it only on emulators reserved for the job, and always name each one by serial.

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
