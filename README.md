# adb-axi

An agent-friendly command-line wrapper around adb, following the AXI conventions: token-efficient output, truthful exit codes, deadlines on every device call, and structured errors.

It covers the device-state side of Android work: device health, app lifecycle including process-death checks, run-scoped logs and crashes, and app data. UI driving is out of scope.

**Status:** in development. Commands ship one slice at a time; `adb-axi --help` lists the ones available in your build.

`app install <apk>` keeps app data by default. `--clean-data` installs and wipes data even when combined with `--if-changed`. Without a requested wipe, `--if-changed` skips only when current installed version and target-device signer evidence match. Unreadable APK or signer evidence skips the shortcut, not the ordinary install. Signing-block reads do not verify cryptographic authenticity.
