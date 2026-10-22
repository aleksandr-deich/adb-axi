# Real-device tools

The testing policy for adb-axi is in [`docs/testing.md`](../../docs/testing.md).

Nothing here runs in `npm test` or `npm run check`. The device checks run on every pull request and on pushes to `main`, against API 29, 30 and 35 emulators (`.github/workflows/emulator.yml`). Everything here changes the devices it touches, so run it only on emulators reserved for the job, and always name each one by serial.

## Device checks (`*.test.ts`)

The checks drive adb-axi installed from a packed tarball against one emulator, use the probe app for app and log scenarios, and wait for app and log events with adb-axi's own `wait` commands instead of sleeping. Each expected result is grounded in probe state, Android window focus, kernel process state or database bytes, rather than another adb-axi summary. Window focus comes from current display contents, not historical last-ANR snapshots included in an unqualified window dump. These files cover adb-axi's ordinary flows and every failure a real emulator can produce:

| File                    | What it checks                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0-app-install`         | upgrade and downgrade, debug/release swaps, the install record, a file that is not an APK and the package manager's own refusals, from the variant APKs                                                                                                                                            |
| `0-app-lifecycle`       | install/reinstall, if-changed/clean-data, stop/clear, uninstall/keep-data and missing packages, with real package/process/private-data evidence                                                                                                                                                    |
| `1-process-death`       | `app kill` then `app restore`: the saved counter survives, the volatile one resets, a new process, and no crash since the mark; kill, restore and death with nothing running, no task, a second process and no agent-device                                                                        |
| `2-app-crash-on-launch` | a crash in `onCreate` is `APP_DIED_ON_START` for start and restore, with Android's crash dialogs shown and hidden (restored after)                                                                                                                                                                 |
| `2-app-start`           | `app start` on the app in front is not recreated; `--fresh` is a cold start; named, nested, `:ui` and alias activities, other apps in front and start refusals                                                                                                                                     |
| `3-data-db`             | a row still only in `probe.db-wal` comes back from `data db`; the release build gives `APP_NOT_DEBUGGABLE`; several databases with their companions, a lock file, a text file and a corrupt SQLite file, every cell type, row caps with `--full`, SQLite's own errors and a query past `--timeout` |
| `4-doctor`              | every `doctor` check against its own device or host fact; changed animation scales, a missing or empty console token, an unattached serial and a fresh adb server port                                                                                                                             |
| `4-doctor-ui`           | `doctor ui` reports UiAutomation free and exits 0; a live `adb shell` or `adb exec-out` uiautomator reader is named, protected from `--fix`, and gone once it ends                                                                                                                                 |
| `5-logs`                | marks on the device clock, each API level's app scope, default and duration windows, a late buffer start, a burst of probe lines with folded repeats, cut long lines and `--full` files, and `wait log`                                                                                            |
| `5-logs-crash`          | a Java crash counts once and zero after the next mark; a native crash and an ANR are reported, with their tombstone and report in `--full`; the ANR report is in the system buffer; a wrapped crash's root cause, a crash loop of six and an empty window                                          |
| `6-app-observation`     | named log windows across process restarts, filters/mark replacement, wait transitions and timeouts, package metadata, absent packages, the launcher in front and actual Room/WAL reads                                                                                                             |
| `6-device-state`        | the target's serial, AVD name and API match device properties; `app current` matches independent window-focus and kernel-PID queries; the home view and `devices --fields`                                                                                                                         |
| `6-selection`           | a second real transport of the same emulator (`adb connect`): every device command refuses to guess, the home view and `doctor` say so, explicit and AVD-name selection, marks per serial, `--debug` and an unknown serial                                                                         |
| `6-shell`               | the device shell's exit codes and streams, 50-line and 4 kB caps, `--full` files, a command past its deadline and the 15 s default                                                                                                                                                                 |
| `7-reboot`              | reboots the emulator: `wait boot` times out with the last state, then waits until the services answer; marks from the old boot are dropped once; an unattached serial times out naming it                                                                                                          |
| `8-offline`             | runs last and stops the emulator; a command against it then fails with a typed error in under 2 s; with nothing else attached, `devices`, the home view and `doctor` give a definitive empty state                                                                                                 |

Run them against an emulator nobody else is using. The last check shuts it down:

```
ANDROID_SERIAL=emulator-5554 npm run test:device
```

The setup packs and installs adb-axi into a temporary prefix (set `ADB_AXI_BIN` to use an installed one instead) and uses a fresh `ADB_AXI_HOME` for every test. Probe installs clear package data before independent scenarios; log marks scope observations without clearing the device's logs. The late-buffer check requests a window before boot and brackets its reported first timestamp with raw logcat reads, so it does not depend on logcat clearing succeeding. The crash file temporarily suppresses Android error dialogs and restores the original setting before continuing. Its ANR stimulus requires actual input-window focus and queues two concurrent keyboard events: Android 10 detects the unfinished first event when the second waits behind it, whereas newer Android versions track unfinished events directly. Before any check runs it waits until the emulator's package and activity services answer steadily, since `sys.boot_completed` alone can come seconds before they do. Every adb-axi call, exit code, duration and output is written to `test-results/device/<check>.txt`. Failed tests also save the last 2,000 logcat lines in `<check>.logcat.txt`; CI uploads that folder as the `device-transcripts-api-<level>` artifact. Temporary CLI state and a locally packed installation are removed at teardown.

Everything an emulator can produce belongs in this packed-package suite, failures included. The fake-adb CLI tests in `test/cli` keep only what an emulator cannot produce reliably: transport drops, hung commands and deadline expiry, malformed or partial output, hostile files, holders that need tools CI does not have, physical, unauthorized, offline or recovery devices, and one case per command family for a second Android user. A fault that every command shares is tested once in the shared layer, not once per command. Pure parsing, formatting and algorithm tests stay in `test/unit`. Remove a fake-backed case only after equivalent, independently grounded device assertions pass on API 29, 30 and 35.

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

`6-selection` checks ambiguous and explicit selection with a second transport of the one CI emulator. Two distinct emulators can only be checked locally. Reserve two disposable emulators first, use only emulators you own and substitute their serials below; never reuse an occupied emulator or a physical device:

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

| Action         | Effect                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `inc`          | adds 1 to `saved` (`rememberSaveable`, survives process death) and `volatile` (`remember`)                                 |
| `state`        | logs the current state                                                                                                     |
| `write`        | inserts a row into the Room database `probe.db` (WAL); the row stays in `probe.db-wal`                                     |
| `finish`       | finishes the activity and leaves the process alive, so the next start is warm                                              |
| `crash`        | throws on the main thread (Java crash)                                                                                     |
| `native`       | sends itself SIGSEGV (native crash with a tombstone)                                                                       |
| `anr`          | blocks the main thread for 30 s; input sent meanwhile ends in an ANR                                                       |
| `armcrash`     | makes the next `MainActivity` create throw, so a start or restore dies on launch                                           |
| `finishremove` | `finishAndRemoveTask`: the process stays, its task leaves recents                                                          |
| `crashchain`   | throws a wrapped exception with a cause chain and a long message (`--ei length N`)                                         |
| `alias`        | enables (`--ez on true`) or disables the second launcher entry `.Alias`; the shell may not                                 |
| `log`          | logs `--ei count N` lines of `--es text T` (`--es level`, `--es tag`, `--ez numbered`)                                     |
| `file`         | writes `--es name N` into `files/` or, with `--es where databases`, the databases folder (`--es text T` or `--ei bytes B`) |
| `sql`          | runs `--es stmt S` on `--es db NAME` (`--ez wal true`), kept open for the life of the process                              |

`MainActivity` is `singleTop`, so an action sent while it is on top reaches `onNewIntent`. Other activities: `.UiActivity` runs in the `:ui` process, `.BounceActivity` opens Settings over itself, `.PermActivity` asks for the camera permission, `.PrivateActivity` is not exported and `.Outer$Inner` is a nested class. Every state change logs one line with tag `ProbeState`, the oracle the checks read from logcat:

```
ProbeState: event=inc saved=3 volatile=3 rows=0 restored=false pid=4321
```

Build both variants (debuggable debug, non-debuggable release signed with the debug key) and the code-free `variants` module, whose builds of `dev.probe` each get one real package-manager answer (`v2`, `othersigner` signed by the test-only key `variants/test-only-other-signer.jks`, `minsdk36`, `flaggedtest`, `needslib`, `riscvonly`), then refresh the committed fixtures:

```
cd test/device/probe-app
./gradlew clean assembleDebug assembleRelease
cp app/build/outputs/apk/debug/app-debug.apk ../../fixtures/apk/probe-debug.apk
cp app/build/outputs/apk/release/app-release.apk ../../fixtures/apk/probe-release.apk
for v in v2 othersigner minsdk36 flaggedtest needslib riscvonly; do
  cp variants/build/outputs/apk/$v/debug/variants-$v-debug.apk ../../fixtures/apk/probe-$v.apk
done
```

## Capture (`capture.ts`)

Runs the adb commands adb-axi reads, plus the probe's actions, and saves the raw output under `test/fixtures/captured/<api>/` (host-level output under `captured/host/`):

```
npm run capture -- --serial emulator-5554 --serial emulator-5556
```

It installs, crashes and uninstalls `dev.probe`, clears logcat and presses HOME on every device named. `test/fixtures/EVIDENCE.md` describes each file and the facts recorded in each `index.json`.

`--processes` captures only the process table and `pidof` reads of `src/android/app-processes.ts`, with the probe's main and `:ui` processes running, stopped and exiting, and adds them to each API directory without replacing its other captures:

```
npm run capture -- --processes --serial emulator-5554
```
