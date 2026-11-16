# SharedPreferences snapshot

`probe-settings.xml` is the actual persisted output of the probe app's `prefs` action with name `settings` on an Android 10 (API 29) default arm64 emulator. It was read through `run-as dev.probe cat shared_prefs/settings.xml` after the action's `ok=true` commit log. Values are determined by `writePrefs` in `test/device/probe-app/app/src/main/java/dev/probe/MainActivity.kt`.

The host backup-recovery case places these real bytes into the primary/backup states used by AOSP SharedPreferencesImpl's write protocol: backup-only, and backup plus incomplete primary. It executes the same listing/read shell scripts against a temporary directory and checks that every file remains byte-identical. This establishes shell selection and reading behavior, not an Android runtime race reproduction.
