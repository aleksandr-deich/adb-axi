# adb-axi

adb-axi is a command-line wrapper around Android's `adb`, built for AI coding agents. It answers questions about Android devices and apps in short, structured output and says what to do next.

What it adds over plain `adb`:

- **Structured output:** compact [TOON](https://github.com/toon-format/toon), or JSON with `--json`, with the verdict on the first line.
- **No hangs:** every command has a time limit, so a stuck device cannot block the agent.
- **Honest results:** a command succeeds only when the requested state is actually true, and every error names the next step. See [Why not plain adb?](#why-not-plain-adb) for examples.

Use it to check which devices are attached and healthy; install, start, stop and kill apps, including testing that an app survives process death; read the logs and crashes of one test run; and read a debuggable app's databases and SharedPreferences. It does not read the screen or tap and type: use `android layout` or a UI tool such as agent-device for that.

**Works well with:** the [Android CLI](https://developer.android.com/tools/agents/android-cli) for builds and emulators, and [agent-device](https://github.com/callstack/agent-device) or `android layout` for the UI. adb-axi handles the app and device checks between them and replaces neither.

**Let your agent review adb-axi:** after a session, ask your agent to run `adb-axi feedback` and post its note on the [issues page](https://github.com/aleksandr-deich/adb-axi/issues). See [Session feedback](#session-feedback).

Screen-reading tools can leave a helper connected that keeps Android reporting accessibility as enabled and blocks instrumented tests. Before handing a device back or running instrumented tests, run `adb-axi doctor ui --fix --device <serial>`. It removes stale helpers, which can stop a running instrumentation and its app, and leaves helpers still in use alone.

adb-axi follows the [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface) conventions for agent-facing command-line tools.

## Get started

```sh
npm install -g adb-axi
npx skills add aleksandr-deich/adb-axi --skill adb-axi -g
```

Add to your `AGENTS.md` or `CLAUDE.md`:

```
Use `adb-axi` instead of raw `adb` for Android device and app state.
```

Requirements: Node 24.12 or newer, and Android SDK Platform-Tools 35.0.0 or newer. Devices must run Android 10 (API 29) or newer; emulators and physical phones are both supported. Check the install with `adb-axi --version`.

adb is found on `PATH`, then in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Library/Android/sdk`. An older adb client fails with `HOST_ADB_TOO_OLD`; adb-axi never updates platform-tools itself.

The [skill](skills/adb-axi/SKILL.md) tells agents when to use adb-axi and includes a quick reference for common commands; live CLI help covers anything not listed. `-g` installs the skill for all projects. See its [Install and run](skills/adb-axi/SKILL.md#install-and-run) section for agent invocation and the quiet npx fallback.

## Why not plain adb?

Plain `adb` often reports success when nothing happened. Each pair below was recorded on an API 35 emulator with adb 37.0.1 and adb-axi 0.2.7, using the [probe test app](test/device/probe-app). Output is trimmed; adb-axi errors also name the next command to run.

**A mistyped package name succeeds.** `am force-stop` exits 0 for a package that is not installed:

```
$ adb shell am force-stop dev.probee; echo "exit $?"
exit 0

$ adb-axi app stop dev.probee
error: dev.probee is not installed on this device
code: APP_NOT_INSTALLED
```

**`am kill` leaves an app in front running.** It exits 0 and the process keeps its pid:

```
$ adb shell pidof dev.probe
6293
$ adb shell am kill dev.probe; echo "exit $?"
exit 0
$ adb shell pidof dev.probe
6293

$ adb-axi app kill dev.probe
ok: "kill dev.probe -> process gone, task kept in recents"
kill:
  pid_before: 6293
  pid_after: null
  backgrounded_first: true
```

**A crash on launch looks like a start.** `am start` exits 0 while the app dies in `onCreate`:

```
$ adb shell am start -n dev.probe/.MainActivity; echo "exit $?"
Starting: Intent { cmp=dev.probe/.MainActivity }
exit 0
$ adb shell pidof dev.probe; echo "exit $?"
exit 1

$ adb-axi app start dev.probe
error: the dev.probe process of dev.probe/.MainActivity crashed during its start
code: APP_DIED_ON_START
last:
  state: crashed
```

**A missing device blocks forever.** `adb wait-for-device` has no deadline:

```
$ adb -s emulator-5999 wait-for-device
# still waiting after 60 s, when it was killed

$ adb-axi wait boot --device emulator-5999 --timeout 10s
error: emulator-5999 had not finished booting after 10 s
code: WAIT_TIMEOUT
last:
  state: not attached
```

These are correctness differences, not a speed or cost claim; see the [evaluation](#evaluation) for per-operation measurements and the whole-session caveat.

## Start here

`adb-axi` with no command shows live state: the attached devices, the device a command would target, its foreground app and its recent crashes.

Example output (description omitted; see live `adb-axi --help`):

```
$ adb-axi
bin: ~/.local/bin/adb-axi
count: "1 attached, 1 online"
devices[1]{serial,avd,state,api,form}:
  emulator-5554,Pixel_10_Pro_XL,device,35,phone
target: emulator-5554
foreground: dev.probe/.MainActivity
crashes: "0 in the last 15m (no log mark yet)"
help[1]: Run `adb-axi logs --pkg dev.probe --since 1m` for recent app logs
```

`adb-axi --help` lists every command; `adb-axi <command> --help` gives its arguments, flags, defaults and examples. Flags go after the command: `adb-axi app start com.example.notes --device emulator-5554`. adb-axi picks a device on its own only when exactly one emulator is online; otherwise pass `--device <serial|avd>` or set `ANDROID_SERIAL`.

Without `--server`, `--server-start` or a saved selection, adb-axi inherits adb's server selection: `ADB_SERVER_SOCKET` takes priority over `ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT`; without a socket setting, adb uses those address and port settings, defaulting to the local host and port 5037. `doctor` reports the selected endpoint and notes contradictory address or port settings ignored because of `ADB_SERVER_SOCKET`. Server recovery hints retain the selected endpoint, but repeat `--server` and `--server-start` only for flag-selected endpoints. These settings select the server, independently of `--device` or `ANDROID_SERIAL`. To pin adb-axi to one server, use `--server tcp:<port>` or a saved selection; see `doctor --help`.

## Output and exit codes

- **Output:** TOON on stdout, or JSON with `--json`. A mutation leads with `ok: <verb> <target> -> <resulting state>` and says `(no-op)` when the state was already true. `help` lines provide recovery or truncation guidance; routine successful reads omit obvious next steps. `--debug` prints every adb call on stderr.
- **Server evidence:** `server` is a one-line endpoint, selection source and answered status in TOON. Errors, observed or unknown startup, and JSON retain the full server block.
- **Preference rows:** `data prefs` uses a TOON table with `key`, `type` and string `value`; string sets are JSON text in one cell. JSON retains typed values, including arrays for sets.
- **Exit codes:** 0 when the requested state is true, including no-ops and reads that find nothing; 1 when it is not; 2 for a usage error.
- **Errors:** one shape: `error`, a stable `code`, the fields that explain it, then `help`.
- **Deadlines:** commands share one deadline across their device calls; state waits may finish a final bounded observation just past it to check for a state reached during the last polling interval. `--help` shows each command's default and `--timeout` overrides it.
- **Long output:** `logs`, `shell`, `data db` and `data prefs` print a bounded view and say how much of it was shown; `--full` writes the complete output to a file.

For `shell`, each stream's view keeps up to 50 source lines or 4096 bytes. Long output normally shows the first 20 and last 30 lines; the byte cap can reduce either portion, prioritizing the last line when both ends cannot fit. An extra `... N lines omitted ...` row marks the gap, and `shown` identifies the portions kept, such as `50 of 193 lines (first 20 and last 30)`. With `--full`, the view instead shows the last 50 lines or 4096 bytes, alongside `full: <path>`. A final line that exceeds the byte cap is shown from its start, with the cut reported in `shown`. Stderr uses `stderr_shown` and `stderr_full`; output within the caps is shown whole in either mode.

`logs`, `logs crash`, `wait log` and the home crash count read log windows incrementally rather than collecting the whole window in memory. See `logs --help` for retained-state limits and temporary-spool cleanup, and `logs crash --help` for summary limits.

adb-axi keeps log marks, install records and cached AVD names under `~/.adb-axi/`; set `ADB_AXI_HOME` to use another directory. Output files and temporary log spools live in that directory's `out/` subdirectory.

## Commands

| Command                                                   | What it answers                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `adb-axi`                                                 | Devices, the resolved target, its foreground app and recent crashes                             |
| `devices [--all] [--fields <list>]`                       | Every attached device with its AVD name, state, API level and form                              |
| `doctor`                                                  | Host, adb server and target checks for things that break a run                                  |
| `doctor ui [--fix]`                                       | What holds UiAutomation, and clearing resident, leaked or wedged holders                        |
| `wait boot`                                               | Waits until the device is online, booted, and able to install and launch apps                   |
| `wait app <pkg> --state <foreground\|running\|stopped>`   | Waits until an app reaches a state                                                              |
| `wait log <regex> [--since <mark\|dur>]`                  | Waits until a log line matches                                                                  |
| `app current`                                             | The foreground app: package, activity and pid                                                   |
| `app list [--all] [--grep <re>]`                          | Packages installed for the current Android user, with a count                                   |
| `app info <pkg>`                                          | One package: installed, version, debuggable, pid, foreground, data size                         |
| `app install <apk> [--clean-data] [--if-changed]`         | Installs and waits until the new version is live, keeping app data by default                   |
| `app uninstall <pkg> [--keep-data]`                       | Uninstalls a package for the current Android user                                               |
| `app start <pkg> [--fresh] [--activity <name>]`           | Starts an app and reports what is in front and how it launched                                  |
| `app stop <pkg>`                                          | Force-stops an app and verifies its process is gone                                             |
| `app clear <pkg> [--full]`                                | Clears the app's data and verifies it                                                           |
| `app kill <pkg>`                                          | Kills the process the way the system does, keeping its task in recents                          |
| `app restore <pkg>`                                       | Reopens the app's task from recents so its saved state is restored                              |
| `app death <pkg> [--compare]`                             | `app kill` then `app restore` in one call, with the evidence of both                            |
| `logs mark [<name>]`                                      | Records the device clock under a name, to scope later reads                                     |
| `logs [--since] [--pkg] [--level] [--grep] [--full]`      | One bounded log dump for a window, with level counts and repeats collapsed                      |
| `logs crash [--pkg <pkg>] [--since <mark\|dur>] [--full]` | Java crashes, ANRs and native crashes in a window                                               |
| `data db <pkg> [<sql>] [--db <name>] [--full]`            | An app's databases, or one read-only query on a copy that includes the WAL                      |
| `data prefs <pkg> [--file <name>] [--full]`               | Read SharedPreferences XML as typed rows, including string sets and empty values                |
| `config get [<key>]`                                      | Read raw presence/text and effective values for animations, night, font_scale, density and size |
| `config set <key> <value>`                                | Validate, write and verify settings; print before/after and a pasteable restore value           |
| `shell -- <cmd>`                                          | One device shell command with its real exit code                                                |
| `update [--check]`                                        | Upgrades adb-axi from npm, or compares against the latest version with --check                  |
| `feedback`                                                | What to put in a session note and where to post it                                              |

`data db` copies files while the app runs, so concurrent writes can be missed; the copy is not atomic. After copying the main database, it rechecks the WAL header. If the WAL changes generation, appears or disappears, it retries the copy once. A second change fails with `DATABASE_CHANGED_DURING_COPY` and no query rows; retry when the app stops writing to the database.

### Temporary device configuration

`config get` reads `animations`, `night`, `font_scale`, `density` and `size`, distinguishing absent rows (`present: false, text: null`) from literal `"null"` text (`present: true`). Install cleanup before mutation and restore the `before.value` printed by `config set` in the same turn. Night writes refuse users other than user 0. See live `config get --help` and `config set --help` for value rules and verification limits.

```sh
adb-axi config get animations --device emulator-5554 --json
adb-axi config set animations 0 --device emulator-5554 --json
# In the same turn, restore the value printed as before.value, for example:
adb-axi config set animations window=1,transition=1,animator=unset --device emulator-5554
```

### Session feedback

Ask your agent to run `adb-axi feedback` after a session. Your agent writes a short plain-text impression and gives you the [issues link](https://github.com/aleksandr-deich/adb-axi/issues); open a new issue there, paste the note, check it and submit. adb-axi posts nothing.

```sh
adb-axi feedback
```

## Evaluation

<!-- evaluation:start -->

adb-axi 0.2.8 and matched plain `adb` commands ran the same device operations on an API 35 emulator with the [probe test app](test/device/probe-app). Numbers are the tokens of output the agent reads for each operation (mean of two runs); they are per operation, not per session.

| Operation                                | Plain adb    | adb-axi    | Difference                                                                                  |
| ---------------------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------- |
| Does the app survive process death?      | 4 calls, 309 | 1 call, 66 | One call kills, reopens and proves a new process; `am kill` alone can leave the app running |
| Did the app crash during this run?       | 946          | 120        | Only crashes since a `logs mark`, already parsed                                            |
| Did the app crash on launch?             | 922          | 239        | Plain `am start` reports success; adb-axi returns an error with the crash                   |
| What rows are in this database table?    | 118          | 43         | One call, with rows still in the write-ahead log                                            |
| What is in this app's SharedPreferences? | 171          | 96         | One typed table instead of raw XML                                                          |
| Start the app and check it is in front   | 94           | 46         | Succeeds only when the app is actually in front                                             |
| Which app is in front?                   | 52           | 29         |                                                                                             |
| Which devices are attached and healthy?  | 69           | 39         |                                                                                             |
| Error: the package is not installed      | 41           | 69         | adb-axi errors are larger: they carry the diagnosis and the next command                    |
| Error: no device with this serial        | 13           | 70         | Same                                                                                        |
| Error: reading data of a release build   | 13           | 78         | Same                                                                                        |

Across all 14 measured operations (including install, stop and a UiAutomation check, where both stay within 15 output tokens), adb-axi took 16 calls and 1,227 tokens typed and read, against 21 calls and 3,846-3,916 for plain adb.

In whole agent sessions (42 paired bug-fix sessions with Codex CLI and gpt-6.1-sol), cost and wall time matched plain adb and total tokens were about 9% higher (90% interval 3-16%), almost all of it re-read cached context: per-operation savings are real but small next to everything else an agent reads.

The earlier full 0.2.4 study, with its method, outcomes and limits, is in [docs/evaluation.md](docs/evaluation.md).

<!-- evaluation:end -->

## Example: does an app survive process death?

Android kills background apps to free memory, and a well-built app restores its screen when the user returns. `app death` sends the app to the background if it is in front, kills its process the way Android does and reopens it from recents: `pid_after_kill: null`, a new `pid_restored` and `launch: cold` prove it really restarted. `logs mark` and `logs crash` limit the crash check to this run.

Use any UI tool to put some state on screen before `app death` and to check it came back after.

```
$ adb-axi logs mark before-kill
ok: "mark before-kill -> 2026-10-01 07:58:47.000 on emulator-5554"

$ adb-axi app death dev.probe
ok: death dev.probe -> killed and restored from recents
death:
  pid_before: 8235
  pid_after_kill: null
  pid_restored: 9001
  new_process: true
  launch: cold
  cached_after_ms: 964
  method: am kill

$ adb-axi logs crash --pkg dev.probe --since before-kill
crashes: "0 since before-kill (13 s, 0 lines scanned)"
```

## Development

```sh
npm ci
npm run check   # build, typecheck, lint, format check, tests; no device needed
npm pack && npm install --global ./adb-axi-*.tgz   # install a local build
```

`npm run check` includes scripted fake-adb CLI checks and a real-adb server-selection regression, so it requires the supported platform-tools version even without a device. The regression starts and stops its own isolated servers with device discovery disabled. The real-emulator suite runs in CI (see [real-device checks](test/device/README.md)), and [`test/fixtures/EVIDENCE.md`](test/fixtures/EVIDENCE.md) maps recorded Android evidence to tests. Read [docs/testing.md](docs/testing.md) before changing code or tests.

## License

MIT
