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
