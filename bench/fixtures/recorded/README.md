# Recorded scorer regression evidence

These fixtures are projections of completed benchmark runs, not new subject runs. They contain the final report, selected executed command-audit entries, and available independent measurements needed to replay the task scorer without a device.

- `5-adb-axi-2`, `5-adb-axi-4`, and `5-adb-axi-5`: successful capture/check/restore scripts print queried night-mode values as `changed=yes` or `changed: yes`. The final independently checked mode is `Night mode: no`.
- `8-adb-axi-1`: a successful host stop, missing-state observation, and host start. Independently sampled host PID changes from 15663 to 19839; the guest boot ID remains unchanged, with final attachment and boot completion confirmed. Expected success does not require a cold guest boot.
- `8-without-host-pid`: a historical stop/observation/start audit and recovery report, but no independently retained setup/final host PID or guest identity measurements. Subject-visible start output is not a substitute for those measurements. Expected failure means recovery cannot be proven from this evidence, not that a host restart was disproven.

Unrelated audit calls are omitted. Emulator-start progress lines are omitted and the machine-local log-file location is redacted. Execution status, lifecycle completion output, unavailable-state output, script bodies, and retained identity measurements are preserved. These fixtures do not alter the original run records.
