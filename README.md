# adb-axi

adb-axi is a command-line wrapper around Android's `adb`, built for AI coding agents. It answers questions about Android devices and apps in short, structured output and says what to do next.

What it adds over plain `adb`:

- **Short output:** compact [TOON](https://github.com/toon-format/toon), or JSON with `--json`, so agents spend fewer tokens.
- **No hangs:** every command has a time limit, so a stuck device cannot block the agent.
- **Honest results:** a command succeeds only when the requested state is actually true, and every error names the next step.

Use it to check which devices are attached and healthy; install, start, stop and kill apps, including testing that an app survives process death; read the logs and crashes of one test run; and query a debuggable app's database. It does not read the screen or tap and type: use `android layout` or a UI tool such as agent-device for that.

Screen-reading tools can leave a helper connected that keeps Android reporting accessibility as enabled and blocks instrumented tests. Before handing a device back or running instrumented tests, run `adb-axi doctor ui --fix --device <serial>`. It removes stale helpers, which can stop a running instrumentation and its app, and leaves helpers still in use alone.

adb-axi follows the [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface) conventions for agent-facing command-line tools.

## Install

Requirements: Node 24.12 or newer, and Android SDK Platform-Tools 35.0.0 or newer. Devices must run Android 10 (API 29) or newer; emulators and physical phones are both supported.

```sh
npm install --global adb-axi
adb-axi --version
```

adb is found on `PATH`, then in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Library/Android/sdk`. An older adb client fails with `HOST_ADB_TOO_OLD`; adb-axi never updates platform-tools itself.

## Agent skill

```sh
npx skills add aleksandr-deich/adb-axi --skill adb-axi -g
```

The [skill](skills/adb-axi/SKILL.md) tells agents when to use adb-axi; command details come from the live CLI help. `-g` installs it for all projects. With the skill, agents can run `npx -y adb-axi <command>` without a global install.

## Start here

`adb-axi` with no command shows live state: the attached devices, the device a command would target, its foreground app and its recent crashes.

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

`adb-axi --help` lists every command; `adb-axi <command> --help` gives its arguments, flags, defaults and examples. Flags go after the command: `adb-axi app start com.example.notes --device emulator-5554`. adb-axi picks a device on its own only when exactly one emulator is online; otherwise pass `--device <serial|avd>` or set `ANDROID_SERIAL`.

Without `--server`, `--server-start` or a saved selection, adb-axi inherits adb's server selection: `ADB_SERVER_SOCKET` takes priority over `ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT`; without a socket setting, adb uses those address and port settings, defaulting to the local host and port 5037. `doctor` reports the selected endpoint and notes contradictory address or port settings ignored because of `ADB_SERVER_SOCKET`. Server recovery hints use the selected endpoint too. These settings select the server, independently of `--device` or `ANDROID_SERIAL`. To pin adb-axi to one server, use `--server tcp:<port>` or a saved selection; see `doctor --help`.

## Output and exit codes

- **Output:** TOON on stdout, or the same data as JSON with `--json`. A mutation leads with `ok: <verb> <target> -> <resulting state>` and says `(no-op)` when the state was already true. Next steps come as `help` lines that name real commands. `--debug` prints every adb call on stderr.
- **Exit codes:** 0 when the requested state is true, including no-ops and reads that find nothing; 1 when it is not; 2 for a usage error.
- **Errors:** one shape: `error`, a stable `code`, the fields that explain it, then `help`.
- **Deadlines:** commands share one deadline across their device calls; state waits may finish a final bounded observation just past it to check for a state reached during the last polling interval. `--help` shows each command's default and `--timeout` overrides it.
- **Long output:** `logs`, `shell` and `data db` print a bounded view and say how much of it was shown; `--full` writes the complete output to a file.

adb-axi keeps log marks, install records and cached AVD names under `~/.adb-axi/`; set `ADB_AXI_HOME` to use another directory.

## Commands

| Command                                                   | What it answers                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `adb-axi`                                                 | Devices, the resolved target, its foreground app and recent crashes            |
| `devices [--all] [--fields <list>]`                       | Every attached device with its AVD name, state, API level and form             |
| `doctor`                                                  | Host, adb server and target checks for things that break a run                 |
| `doctor ui [--fix]`                                       | What holds UiAutomation, and clearing resident, leaked or wedged holders       |
| `wait boot`                                               | Waits until the device is online, booted, and able to install and launch apps  |
| `wait app <pkg> --state <foreground\|running\|stopped>`   | Waits until an app reaches a state                                             |
| `wait log <regex> [--since <mark\|dur>]`                  | Waits until a log line matches                                                 |
| `app current`                                             | The foreground app: package, activity and pid                                  |
| `app list [--all] [--grep <re>]`                          | Packages installed for the current Android user, with a count                  |
| `app info <pkg>`                                          | One package: installed, version, debuggable, pid, foreground, data size        |
| `app install <apk> [--clean-data] [--if-changed]`         | Installs and waits until the new version is live, keeping app data by default  |
| `app uninstall <pkg> [--keep-data]`                       | Uninstalls a package for the current Android user                              |
| `app start <pkg> [--fresh] [--activity <name>]`           | Starts an app and reports what is in front and how it launched                 |
| `app stop <pkg>`                                          | Force-stops an app and verifies its process is gone                            |
| `app clear <pkg> [--full]`                                | Clears the app's data and verifies it                                          |
| `app kill <pkg>`                                          | Kills the process the way the system does, keeping its task in recents         |
| `app restore <pkg>`                                       | Reopens the app's task from recents so its saved state is restored             |
| `app death <pkg> [--compare]`                             | `app kill` then `app restore` in one call, with the evidence of both           |
| `logs mark [<name>]`                                      | Records the device clock under a name, to scope later reads                    |
| `logs [--since] [--pkg] [--level] [--grep] [--full]`      | One bounded log dump for a window, with level counts and repeats collapsed     |
| `logs crash [--pkg <pkg>] [--since <mark\|dur>] [--full]` | Java crashes, ANRs and native crashes in a window                              |
| `data db <pkg> [<sql>] [--db <name>] [--full]`            | An app's databases, or one read-only query on a copy that includes the WAL     |
| `shell -- <cmd>`                                          | One device shell command with its real exit code                               |
| `update [--check]`                                        | Upgrades adb-axi from npm, or compares against the latest version with --check |

Device settings such as dark mode and display density have no command of their own; change them with `shell`.

## Example: does an app survive process death?

Android kills background apps to free memory, and a well-built app restores its screen when the user returns. Testing that takes four adb-axi commands with no sleeps between them, and each one shows proof of what happened:

1. `logs mark` records the start of the test, so the crash check at the end covers only this run.
2. `app kill` sends the app to the background if it is in front, then kills its process the way Android does. `pid_after: null` proves the process is gone.
3. `app restore` reopens the app from the recent-apps list. `launch: cold` and a new `pid` prove it really restarted.
4. Review `logs crash` for crashes since the mark, including any `omitted` reports. See `logs crash --help` for package and Android-user attribution rules.

Use any UI tool to put some state on screen before step 2 and to check it came back after step 3.

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

`app death dev.probe` runs steps 2 and 3 in one command.

## Evaluation

<!-- evaluation:start -->

adb-axi 0.2.2 was tested against plain `adb` with guidance that spells out the same procedures, using Codex CLI 0.162.0 with gpt-6.1-sol at medium effort. Seven Android bug-fix episodes on a small notes app, one of them with a phone and a tablet attached, ran four times per arm. Independent checks tested each final commit on a fresh emulator and checked the tester's existing notes.

| Outcome, 28 runs per arm                                  | adb-axi 0.2.2 | plain adb |
| --------------------------------------------------------- | ------------- | --------- |
| Bugs fixed                                                | 28 of 28      | 28 of 28  |
| Tester notes kept, on both devices in the two-device task | 28 of 28      | 28 of 28  |
| Strict safety pass                                        | 10 of 28      | 6 of 28   |
| Runs ending with device settings rows changed             | 16 of 28      | 22 of 28  |
| Accessibility left enabled or UiAutomation left connected | 0             | 0         |
| Logs cleared or existing packages removed                 | 0             | 0         |
| Indirect adb `start-server` calls; actual restarts        | 1; 0          | 1; 0      |
| Runs reading files outside the permitted scope            | 2             | 0         |
| Wrong-device changes in the two-device task               | 0 of 4        | 0 of 4    |
| Learning responses per run, mean                          | 2.29          | 1.00      |
| Responses per run, geometric mean of valid runs           | 20.65         | 20.01     |
| Wall time per run, geometric mean of valid runs           | 163.77 s      | 148.21 s  |

Rate-card cost was 1.102x plain [90% interval 1.029-1.181] on the six single-device episodes and 1.079x [1.011-1.1512] with the two-device episode. Both results are inconclusive under the 15% rule set in advance: not equivalence and not a confirmed penalty. The cost figures leave out the two out-of-scope runs; including them does not change the result. The extra cost traces mainly to every run reading the root help. Most settings failures are rows that appeared with default values, not demonstrated harm. These are small, one-app, one-model emulator results; see [docs/evaluation.md](docs/evaluation.md) for the method, per-episode results, older studies and limits.

<!-- evaluation:end -->

## Development

```sh
npm ci
npm run check   # build, typecheck, lint, format check, tests; no device needed
npm pack && npm install --global ./adb-axi-*.tgz   # install a local build
```

`npm run check` includes scripted fake-adb CLI checks and a real-adb server-selection regression, so it requires the supported platform-tools version even without a device. The regression starts and stops its own isolated servers with device discovery disabled. The real-emulator suite runs in CI (see [real-device checks](test/device/README.md)), and [`test/fixtures/EVIDENCE.md`](test/fixtures/EVIDENCE.md) maps recorded Android evidence to tests. Read [docs/testing.md](docs/testing.md) before changing code or tests.

## License

MIT
