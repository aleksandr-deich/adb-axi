import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdb, FIXTURES_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

// Parity cases run two CLI deadlines sequentially, plus process startup and cleanup.
vi.setConfig({ testTimeout: 40_000 });

const SERIAL = "emulator-5554";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const CURRENT_USER = "am get-current-user";
const PACKAGE = "dumpsys package dev.probe";
const PIDOF = "pidof dev.probe";
const KERNEL_UIDS = "ps -A -o PID,UID,NAME";
const PROCESSES = "dumpsys activity processes dev.probe";
const FOREGROUND = "dumpsys activity activities";
const RECENTS = "dumpsys activity recents";
const HOME = "input keyevent KEYCODE_HOME";
const AM_KILL = "am kill --user 0 dev.probe";
const RUN_AS_KILL = "run-as dev.probe --user 0 kill -9 8235";
const START = "am start --user 0 -W -n 'dev.probe/.MainActivity'";
const METADATA = "cmd package resolve-activity --user 0 -n 'dev.probe/.MainActivity'";
const LAUNCHER_RESOLVE =
  "cmd package query-activities --components --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p dev.probe";

/** `cmd package resolve-activity` for the probe's main activity, which runs in the app's own process. */
const ACTIVITY_INFO: Response = {
  stdout: [
    "priority=0 preferredOrder=0 match=0x100000 specificIndex=-1 isDefault=false",
    "ActivityInfo:",
    " name=dev.probe.MainActivity",
    " packageName=dev.probe",
    " enabled=true exported=true directBootAware=false",
    " ApplicationInfo:",
    "  packageName=dev.probe",
    "  processName=dev.probe",
    "",
  ].join("\n"),
};

const OLD_PID = 8235;
const NEW_PID = 9001;

const captured = (file: string): string =>
  readFileSync(join(FIXTURES_DIR, "captured/35", file), "utf8");
const fromCapture = (file: string): Response => ({ stdoutFile: `captured/35/${file}` });
const withNewPid = (text: string): string => text.replaceAll(String(OLD_PID), String(NEW_PID));

const INSTALLED = fromCapture("dumpsys-package-debug.txt");
const INSTALLED_RELEASE = fromCapture("dumpsys-package-release.txt");
const ABSENT = fromCapture("dumpsys-package-absent.txt");
const PROBE_FRONT = fromCapture("dumpsys-activity-activities-probe-front.txt");
const LAUNCHER_FRONT = fromCapture("dumpsys-activity-activities-launcher-front.txt");
const RECENTS_KEPT = fromCapture("dumpsys-activity-recents-after-kill.txt");
/** Synthetic: a recents list with only the launcher's task, as after the app's task was swiped away. */
const RECENTS_GONE: Response = {
  stdout: [
    "ACTIVITY MANAGER RECENT TASKS (dumpsys activity recents)",
    "  Recent tasks:",
    "  * Recent #0: Task{fa8efa1 #7 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity}",
    "    userId=0 effectiveUid=u0a179 mCallingUid=0",
    "    mActivityComponent=com.google.android.apps.nexuslauncher/.NexusLauncherActivity",
    "    autoRemoveRecents=false isPersistable=true activityType=2",
    "",
  ].join("\n"),
};
const OTHER_USER_RECENTS: Response = {
  stdout: captured("dumpsys-activity-recents-after-kill.txt").replace(
    /userId=0 effectiveUid=u0a213/, "userId=10 effectiveUid=u10a213",
  ),
};
const AM_COLD = fromCapture("am-start-restore-after-kill.txt");
/** Synthetic: the task came to the front, and the system could not say how the launch went. */
const AM_UNKNOWN: Response = {
  stdout: [
    "Starting: Intent { cmp=dev.probe/.MainActivity }",
    "Warning: Activity not started, its current task has been brought to the front",
    "Status: ok",
    "LaunchState: UNKNOWN (0)",
    "Activity: dev.probe/.MainActivity",
    "Complete",
    "",
  ].join("\n"),
};
const AM_TIMEOUT: Response = { stdoutFile: "synthetic/29/am-start-timeout.txt" };

const PIDOF_OF = (pid: number): Response => ({ stdout: `${pid}\n` });
const PIDOF_GONE: Response = { exit: 1 };
const UIDS_OF = (pid: number): Response => ({ stdout: `  PID   UID NAME\n ${pid} 10213 dev.probe\n` });
const UIDS_NONE: Response = { stdout: "  PID   UID NAME\n" };

/** Where the probe is: in front, just sent home, the previous app, dead, or restored. */
type Phase = "front" | "leaving" | "previous" | "dead" | "restored";

interface Probe {
  phase: Phase;
  package?: Response;
  recents?: Response;
  /** Whether HOME takes the app out of the front. */
  homeWorks?: boolean;
  /** Whether `am kill` kills a killable process. */
  amKillWorks?: boolean;
  /** Whether `run-as kill` kills it. */
  runAsKillWorks?: boolean;
  /** What `am start -W` prints, and where the probe is after it. */
  start?: { respond: Response; then: Phase };
  /** Extra rules, tried first. */
  rules?: Rule[];
}

const shell = (command: string): string[] => ["-s", SERIAL, "shell", command];

/**
 * A device where the probe's process follows what is sent to it (S5): `am kill` does
 * nothing to the app in front or just sent home, and kills it once it is the previous
 * app. After HOME the first two process reads still show it in front; the third shows it
 * as the previous app (oom adj 700), as E0 recorded.
 */
function probeDevice(probe: Probe): FakeAdb {
  const rules: Rule[] = [
    ...(probe.rules ?? []),
    { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
    { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
    { match: shell(PACKAGE), respond: probe.package ?? INSTALLED },
    { match: shell(RECENTS), respond: probe.recents ?? RECENTS_KEPT },
    { match: shell(METADATA), respond: ACTIVITY_INFO },
    {
      match: shell(HOME),
      when: { app: "front" },
      respond: {},
      set: probe.homeWorks === false ? {} : { app: "leaving" },
    },
    { match: shell(HOME), respond: {} },
    { match: shell(PIDOF), when: { app: "front" }, respond: PIDOF_OF(OLD_PID) },
    { match: shell(PIDOF), when: { app: "leaving" }, respond: PIDOF_OF(OLD_PID) },
    { match: shell(PIDOF), when: { app: "previous" }, respond: PIDOF_OF(OLD_PID) },
    { match: shell(PIDOF), when: { app: "dead" }, respond: PIDOF_GONE },
    { match: shell(PIDOF), when: { app: "restored" }, respond: PIDOF_OF(NEW_PID) },
    { match: shell(KERNEL_UIDS), when: { app: "dead" }, respond: UIDS_NONE },
    { match: shell(KERNEL_UIDS), when: { app: "restored" }, respond: UIDS_OF(NEW_PID) },
    { match: shell(KERNEL_UIDS), respond: UIDS_OF(OLD_PID) },
    { match: shell(FOREGROUND), when: { app: "previous" }, respond: LAUNCHER_FRONT },
    { match: shell(FOREGROUND), when: { app: "dead" }, respond: LAUNCHER_FRONT },
    { match: shell(FOREGROUND), respond: PROBE_FRONT },
    { match: shell(PROCESSES), when: { app: "dead" }, respond: {} },
    {
      match: shell(PROCESSES),
      when: { app: "restored" },
      respond: { stdout: withNewPid(captured("dumpsys-activity-processes-probe-front.txt")) },
    },
    {
      match: shell(PROCESSES),
      when: { app: "previous" },
      respond: fromCapture("dumpsys-activity-processes-probe-previous.txt"),
    },
    {
      match: shell(PROCESSES),
      when: { app: "leaving" },
      respond: fromCapture("dumpsys-activity-processes-probe-front.txt"),
      times: 2,
    },
    {
      match: shell(PROCESSES),
      when: { app: "leaving" },
      respond: fromCapture("dumpsys-activity-processes-probe-previous.txt"),
      set: { app: "previous" },
    },
    { match: shell(PROCESSES), respond: fromCapture("dumpsys-activity-processes-probe-front.txt") },
    {
      match: shell(AM_KILL),
      when: { app: "previous" },
      respond: {},
      set: probe.amKillWorks === false ? {} : { app: "dead" },
    },
    { match: shell(AM_KILL), respond: {} },
    {
      match: shell(RUN_AS_KILL),
      when: { app: "previous" },
      respond: {},
      set: probe.runAsKillWorks === true ? { app: "dead" } : {},
    },
    { match: shell(RUN_AS_KILL), respond: { exit: 1 } },
    {
      match: shell(START),
      respond: probe.start?.respond ?? AM_COLD,
      set: { app: probe.start?.then ?? "restored" },
    },
  ];
  const fake = createFakeAdb({
    description: "The probe's process follows HOME, am kill, run-as kill and am start",
    synthetic: true,
    state: { app: probe.phase },
    rules,
  });
  fakes.push(fake);
  return fake;
}

const fakes: FakeAdb[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
  /** The fake of the TOON run. */
  fake: FakeAdb;
}

/** Times differ between runs; every other field must match field for field. */
function normalized(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(data, (key, value: unknown) =>
      key === "cached_after_ms" && typeof value === "number" ? 0 : value,
    ),
  ) as Record<string, unknown>;
}

/**
 * Run a command as TOON and as `--json`, each on its own fresh fake (the probe's state
 * moves as it is killed); the two must carry the same data field for field.
 */
async function both(args: string[], build: () => FakeAdb): Promise<Both> {
  const fake = build();
  const toon = await runCli(args, fake.env);
  const jsonFake = build();
  const json = await runCli([...args, "--json"], jsonFake.env);
  expect(toon.exitCode).toBe(json.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  expect(normalized(decoded)).toEqual(normalized(data));
  return { toon, json, data, fake };
}

function shellCommands(fake: FakeAdb): string[] {
  return fake
    .calls()
    .filter((call) => call.tool === "adb" && call.argv[2] === "shell")
    .map((call) => call.argv[3] ?? "");
}

/** Every adb call was answered and named its device. */
function expectClean(fake: FakeAdb): void {
  expect(fake.unmatched()).toEqual([]);
  for (const call of fake.calls()) {
    if (call.tool === "adb" && call.argv[0] !== "devices") {
      expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
    }
  }
}

/** A command's output with the time-dependent field blanked, for exact comparison. */
const stable = (stdout: string): string =>
  stdout.replace(/cached_after_ms: \d+/, "cached_after_ms: <n>");

const killedFront = {
  pid_before: OLD_PID,
  pid_after: null,
  backgrounded_first: true,
  cached_after_ms: 0,
  method: "am kill",
};

describe("app kill", () => {
  it("sends the app home, polls until it can be killed, then kills it (S5, L5)", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "front" }),
    );
    expect(toon.exitCode).toBe(0);
    expect(stable(toon.stdout)).toBe(
      [
        'ok: "kill dev.probe -> process gone, task kept in recents"',
        "kill:",
        "  pid_before: 8235",
        "  pid_after: null",
        "  backgrounded_first: true",
        "  cached_after_ms: <n>",
        "  method: am kill",
        "help[2]: Run `adb-axi app restore dev.probe` to reopen it from recents,Run `adb-axi logs --pkg dev.probe --since 30s` to see what it logged while dying",
        "",
      ].join("\n"),
    );
    expect(normalized(data)).toEqual({
      ok: "kill dev.probe -> process gone, task kept in recents",
      kill: killedFront,
      help: [
        "Run `adb-axi app restore dev.probe` to reopen it from recents",
        "Run `adb-axi logs --pkg dev.probe --since 30s` to see what it logged while dying",
      ],
    });
    // HOME first, then process reads until the app is the previous app, then the kill. The
    // fake leaves an app in front, or just sent home, alive after `am kill`, so the
    // success itself shows the kill came last.
    expect(shellCommands(fake)).toEqual([
      CURRENT_USER,
      PACKAGE,
      KERNEL_UIDS,
      PIDOF,
      FOREGROUND,
      HOME,
      PROCESSES,
      PROCESSES,
      PROCESSES,
      AM_KILL,
      KERNEL_UIDS,
      PIDOF,
      RECENTS,
    ]);
    expectClean(fake);
  });

  it("does not send HOME to an app that is already in the background", async () => {
    const { data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "previous" }),
    );
    expect(normalized(data)).toMatchObject({
      kill: { pid_before: OLD_PID, pid_after: null, backgrounded_first: false, method: "am kill" },
    });
    expect(shellCommands(fake)).toEqual([
      CURRENT_USER,
      PACKAGE,
      KERNEL_UIDS,
      PIDOF,
      FOREGROUND,
      PROCESSES,
      AM_KILL,
      KERNEL_UIDS,
      PIDOF,
      RECENTS,
    ]);
    expectClean(fake);
  });

  it("reports a process that is not running as already not running, and touches nothing", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "dead" }),
    );
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe("ok: kill dev.probe -> already not running (no-op)\n");
    expect(data).toEqual({ ok: "kill dev.probe -> already not running (no-op)" });
    expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE, KERNEL_UIDS, PIDOF]);
    expectClean(fake);
  });

  it("fails with KILL_TIMEOUT and the state seen when the app never leaves the front", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe", "--timeout", "3s"], () =>
      probeDevice({ phase: "front", homeWorks: false }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error:
        "dev.probe never reached a state am kill can act on within 3 s (foreground, oom adj 0)",
      code: "KILL_TIMEOUT",
      last: { pid: OLD_PID, state: "foreground", adj: 0 },
      am_kill_sent: false,
      help: [
        "Run `adb-axi app kill dev.probe --timeout 30s` to give it longer",
        "Run `adb-axi app info dev.probe` for its pid and foreground state",
      ],
    });
    // am kill would have been a silent no-op on this app, so it is never sent (S5).
    expect(shellCommands(fake)).not.toContain(AM_KILL);
    expectClean(fake);
  });

  it("fails with KILL_TIMEOUT when the process outlives am kill", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe", "--timeout", "3s"], () =>
      probeDevice({ phase: "previous", package: INSTALLED_RELEASE, amKillWorks: false }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: "dev.probe was still alive at the 3 s deadline after am kill (previous, oom adj 700)",
      code: "KILL_TIMEOUT",
      last: { pid: OLD_PID, state: "previous", adj: 700 },
      am_kill_sent: true,
      help: [
        "Run `adb-axi app kill dev.probe --timeout 30s` to give it longer",
        "Run `adb-axi app info dev.probe` for its pid and foreground state",
      ],
    });
    // A release build refuses run-as, so there is no fallback to try.
    expect(shellCommands(fake)).not.toContain(RUN_AS_KILL);
    expectClean(fake);
  });

  it("falls back to run-as kill for a debuggable app that outlives am kill", async () => {
    const { data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "previous", amKillWorks: false, runAsKillWorks: true }),
    );
    expect(normalized(data)).toMatchObject({
      ok: "kill dev.probe -> process gone, task kept in recents",
      kill: { pid_before: OLD_PID, pid_after: null, method: "run-as kill" },
    });
    const commands = shellCommands(fake);
    expect(commands.indexOf(RUN_AS_KILL)).toBeGreaterThan(commands.indexOf(AM_KILL));
    expectClean(fake);
  });

  it("does not report success while a secondary process survives run-as", async () => {
    const sibling = "pidof dev.probe:remote";
    const { toon, data, fake } = await both(["app", "kill", "dev.probe", "--timeout", "3s"], () =>
      probeDevice({
        phase: "previous", amKillWorks: false,
        rules: [
          { match: shell(KERNEL_UIDS), respond: { stdout: "PID UID NAME\n8333 10213 dev.probe:remote\n" } },
          { match: shell(sibling), respond: PIDOF_OF(8333) },
          { match: shell("run-as dev.probe --user 0 kill -9 8333"), respond: {} },
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "KILL_TIMEOUT", last: { pid: 8333 }, am_kill_sent: true });
    expect(shellCommands(fake)).toContain("run-as dev.probe --user 0 kill -9 8333");
    expect(shellCommands(fake)).not.toContain(START);
    expectClean(fake);
  });

  it("tracks an absolute process name by package UID, even without a main process", async () => {
    const custom = "com.example.shared.worker";
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--timeout", "3s"], () =>
      probeDevice({
        phase: "previous",
        amKillWorks: false,
        rules: [
          {
            match: shell(KERNEL_UIDS),
            respond: { stdout: `PID UID NAME\n8333 10213 ${custom}\n9000 10214 dev.probe:unrelated\n` },
          },
          { match: shell(`pidof ${custom}`), respond: PIDOF_OF(8333) },
          { match: shell("run-as dev.probe --user 0 kill -9 8333"), respond: {} },
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "KILL_TIMEOUT", last: { pid: 8333 }, am_kill_sent: true });
    expect(shellCommands(fake)).toContain(`pidof ${custom}`);
    expect(shellCommands(fake)).toContain("run-as dev.probe --user 0 kill -9 8333");
    expect(shellCommands(fake)).not.toContain("pidof dev.probe:unrelated");
    expect(shellCommands(fake)).not.toContain(START);
    expectClean(fake);
  });

  it("rejects an unsafe process name before sending it to the device shell", async () => {
    const unsafe = "worker;id";
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({
        phase: "previous",
        rules: [
          {
            match: shell(KERNEL_UIDS),
            respond: { stdout: `PID UID NAME\n8333 10213 ${unsafe}\n` },
          },
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT" });
    expect(shellCommands(fake)).not.toContain(`pidof ${unsafe}`);
    expect(shellCommands(fake)).not.toContain("id");
    expect(shellCommands(fake)).not.toContain(AM_KILL);
    expectClean(fake);
  });

  it("rejects an unsafe process name after am kill without sending it to the shell", async () => {
    const unsafe = "worker;id";
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({
        phase: "previous",
        rules: [
          {
            match: shell(KERNEL_UIDS),
            when: { app: "dead" },
            respond: { stdout: `PID UID NAME\n8333 10213 ${unsafe}\n` },
          },
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT" });
    expect(shellCommands(fake)).toContain(AM_KILL);
    expect(shellCommands(fake)).not.toContain(`pidof ${unsafe}`);
    expect(shellCommands(fake)).not.toContain("id");
    expectClean(fake);
  });

  it("fails with TASK_NOT_IN_RECENTS when the process died but its task is gone", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "previous", recents: RECENTS_GONE }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error:
        "dev.probe was killed but its task is not in recents, so a restore would be a fresh launch",
      code: "TASK_NOT_IN_RECENTS",
      kill: { ...killedFront, backgrounded_first: false },
      help: ["Run `adb-axi app start dev.probe` to start it fresh"],
    });
    expectClean(fake);
  });

  it("does not claim another user's task was kept", async () => {
    const { data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "previous", recents: OTHER_USER_RECENTS }),
    );
    expect(data).toMatchObject({ code: "TASK_NOT_IN_RECENTS" });
    expectClean(fake);
  });

  it("fails with APP_NOT_INSTALLED for a package that is not installed", async () => {
    const { toon, data, fake } = await both(["app", "kill", "dev.probe"], () =>
      probeDevice({ phase: "dead", package: ABSENT }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe is not installed on this device",
      code: "APP_NOT_INSTALLED",
    });
    expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE]);
    expectClean(fake);
  });
});

const restoredApp = {
  activity: ".MainActivity",
  pid: NEW_PID,
  launch: "cold",
  new_process: true,
};

describe("app restore", () => {
  it("restores the task with one plain am start and reads the new process from the pids (L10)", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead" }),
    );
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        "ok: restore dev.probe -> foreground from recents (new process)",
        "app:",
        "  activity: .MainActivity",
        "  pid: 9001",
        "  launch: cold",
        "  new_process: true",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "restore dev.probe -> foreground from recents (new process)",
      app: restoredApp,
    });
    expect(shellCommands(fake)).toEqual([
      CURRENT_USER,
      PACKAGE,
      RECENTS,
      PROCESSES,
      START,
      METADATA,
      PROCESSES,
      FOREGROUND,
    ]);
    // Never a launcher category, flags, or monkey: each starts a fresh task (L10).
    const argv = fake.calls().map((call) => call.argv.join(" "));
    expect(argv.filter((line) => line.includes("am start"))).toEqual([
      `-s ${SERIAL} shell ${START}`,
    ]);
    expect(argv.join("\n")).not.toMatch(/monkey|android\.intent\.category|LAUNCHER| -f | -c | -a /);
    expect(shellCommands(fake)).not.toContain(LAUNCHER_RESOLVE);
    expectClean(fake);
  });

  it("reports the same process when the pid is unchanged, whatever LaunchState says", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "front", start: { respond: AM_COLD, then: "front" } }),
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "restore dev.probe -> foreground from recents (same process)",
      app: { activity: ".MainActivity", pid: OLD_PID, launch: "cold", new_process: false },
      help: ["Run `adb-axi app kill dev.probe` first so the restore starts a new process"],
    });
    expectClean(fake);
  });

  it("reports launch unknown, and a new process from the pids, when LaunchState is UNKNOWN", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", start: { respond: AM_UNKNOWN, then: "restored" } }),
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "restore dev.probe -> foreground from recents (new process)",
      app: { ...restoredApp, launch: "unknown" },
    });
    expectClean(fake);
  });

  it("fails with TASK_NOT_IN_RECENTS when there is no task to restore", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", recents: RECENTS_GONE }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: "dev.probe has no task in recents, so there is nothing to restore",
      code: "TASK_NOT_IN_RECENTS",
      help: [
        "Run `adb-axi app start dev.probe` to start it fresh (its saved state is not restored)",
      ],
    });
    expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE, RECENTS]);
    expectClean(fake);
  });

  it("does not restore another user's task", async () => {
    const { data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", recents: OTHER_USER_RECENTS }),
    );
    expect(data).toMatchObject({ code: "TASK_NOT_IN_RECENTS" });
    expect(shellCommands(fake)).not.toContain(START);
    expectClean(fake);
  });

  it("fails with APP_DIED_ON_START when the restored process is gone right after the start", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", start: { respond: AM_COLD, then: "dead" } }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "the dev.probe process of dev.probe/.MainActivity is gone right after its restore",
      code: "APP_DIED_ON_START",
      last: { state: "stopped", pid: "-", foreground: "com.google.android.apps.nexuslauncher" },
    });
    for (const line of (data.help as string[] | undefined) ?? []) {
      expect(line).toContain("logs crash --pkg dev.probe");
    }
    expectClean(fake);
  });

  it("fails with WAIT_TIMEOUT when am reports Status: timeout", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", start: { respond: AM_TIMEOUT, then: "dead" } }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT" });
    expectClean(fake);
  });

  it("fails with APP_NOT_INSTALLED for a package that is not installed", async () => {
    const { toon, data, fake } = await both(["app", "restore", "dev.probe"], () =>
      probeDevice({ phase: "dead", package: ABSENT }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE]);
    expectClean(fake);
  });
});

/** Synthetic `agent-device snapshot --json` output: a counter that kept one value and lost another. */
const SNAPSHOT_BEFORE = JSON.stringify({
  nodes: [{ label: "Counter", value: "saved=3 volatile=3" }, { text: "Save" }],
});
const SNAPSHOT_AFTER = JSON.stringify({
  nodes: [{ label: "Counter", value: "saved=3 volatile=0" }, { text: "Save" }],
});

const snapshotRule = (before: Response, after: Response): Rule => ({
  tool: "agent-device",
  match: ["snapshot", "--json"],
  respond: before,
  times: 1,
  then: after,
});

const withoutAgentDevice = (fake: FakeAdb): FakeAdb => {
  rmSync(join(fake.binDir, "agent-device"));
  return fake;
};

const diedAndRestored = {
  pid_before: OLD_PID,
  pid_after_kill: null,
  pid_restored: NEW_PID,
  new_process: true,
  launch: "cold",
  cached_after_ms: 0,
  method: "am kill",
};

describe("app death", () => {
  it("kills the app and restores it from recents in one call, with evidence from both", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe"], () =>
      probeDevice({ phase: "front" }),
    );
    expect(toon.exitCode).toBe(0);
    expect(stable(toon.stdout)).toBe(
      [
        "ok: death dev.probe -> killed and restored from recents",
        "death:",
        "  pid_before: 8235",
        "  pid_after_kill: null",
        "  pid_restored: 9001",
        "  new_process: true",
        "  launch: cold",
        "  cached_after_ms: <n>",
        "  method: am kill",
        "",
      ].join("\n"),
    );
    expect(normalized(data)).toEqual({
      ok: "death dev.probe -> killed and restored from recents",
      death: diedAndRestored,
    });
    const commands = shellCommands(fake);
    expect(commands.indexOf(HOME)).toBeLessThan(commands.indexOf(AM_KILL));
    expect(commands.indexOf(AM_KILL)).toBeLessThan(commands.indexOf(START));
    expect(fake.calls().some((call) => call.tool === "agent-device")).toBe(false);
    expectClean(fake);
  });

  it("restores an app that was not running, and says the kill had nothing to do", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe"], () =>
      probeDevice({ phase: "dead" }),
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "death dev.probe -> restored from recents (it was not running)",
      death: {
        pid_before: null,
        pid_after_kill: null,
        pid_restored: NEW_PID,
        new_process: true,
        launch: "cold",
        cached_after_ms: null,
        method: null,
      },
    });
    expect(shellCommands(fake)).not.toContain(AM_KILL);
    expectClean(fake);
  });

  it("diffs the visible text before and after with --compare", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [snapshotRule({ stdout: SNAPSHOT_BEFORE }, { stdout: SNAPSHOT_AFTER })],
      }),
    );
    expect(toon.exitCode).toBe(0);
    expect(normalized(data)).toEqual({
      ok: "death dev.probe -> killed and restored from recents",
      death: diedAndRestored,
      diff: ["- saved=3 volatile=3", "+ saved=3 volatile=0"],
    });
    // One snapshot before the kill and one after the restore, for the targeted device.
    const calls = fake.calls();
    const snapshots = calls.filter((call) => call.tool === "agent-device");
    expect(snapshots.map((call) => call.argv)).toEqual([
      ["snapshot", "--json"],
      ["snapshot", "--json"],
    ]);
    expect(snapshots.map((call) => call.androidSerial)).toEqual([SERIAL, SERIAL]);
    const killAt = calls.findIndex((call) => call.argv[3] === AM_KILL);
    const startAt = calls.findIndex((call) => call.argv[3] === START);
    expect(calls.indexOf(snapshots[0] as (typeof calls)[number])).toBeLessThan(killAt);
    expect(calls.indexOf(snapshots[1] as (typeof calls)[number])).toBeGreaterThan(startAt);
    expectClean(fake);
  });

  it("compares an empty before snapshot with visible text after restore", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [snapshotRule({ stdout: JSON.stringify({ nodes: [] }) }, { stdout: SNAPSHOT_AFTER })],
      }),
    );
    expect(toon.exitCode).toBe(0);
    expect(normalized(data)).toEqual({
      ok: "death dev.probe -> killed and restored from recents",
      death: diedAndRestored,
      diff: ["+ Counter", "+ saved=3 volatile=0", "+ Save"],
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(2);
    expectClean(fake);
  });

  it("returns an empty diff when both snapshots have no visible text", async () => {
    const blank = { stdout: JSON.stringify({ nodes: [] }) };
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({ phase: "front", rules: [snapshotRule(blank, blank)] }),
    );
    expect(toon.exitCode).toBe(0);
    expect(normalized(data)).toEqual({
      ok: "death dev.probe -> killed and restored from recents",
      death: diedAndRestored,
      diff: [],
    });
    expectClean(fake);
  });

  it.each(["null", '"not a tree"', "42"])(
    "rejects an invalid before snapshot (%s) with kill and restore evidence",
    async (payload) => {
      const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
        probeDevice({
          phase: "front",
          rules: [snapshotRule({ stdout: payload }, { stdout: SNAPSHOT_AFTER })],
        }),
      );
      expect(toon.exitCode).toBe(1);
      expect(normalized(data)).toEqual({
        error: "dev.probe was killed and restored, but the visible-text comparison could not run: agent-device snapshot did not contain a UI tree",
        code: "COMPARE_UNAVAILABLE",
        death: diedAndRestored,
        help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
      });
      expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(1);
      expect(shellCommands(fake)).toContain(AM_KILL);
      expect(shellCommands(fake)).toContain(START);
      expectClean(fake);
    },
  );

  it("rejects an invalid after snapshot with kill and restore evidence", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [snapshotRule({ stdout: SNAPSHOT_BEFORE }, { stdout: "null" })],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error: "dev.probe was killed and restored, but the visible-text comparison could not run: agent-device snapshot did not contain a UI tree",
      code: "COMPARE_UNAVAILABLE",
      death: diedAndRestored,
      help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(2);
    expectClean(fake);
  });

  it.each([
    { nodes: [null] },
    { nodes: [{ children: [null] }] },
  ])("rejects malformed snapshot nodes with kill and restore evidence", async (snapshot) => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [snapshotRule({ stdout: JSON.stringify(snapshot) }, { stdout: SNAPSHOT_AFTER })],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error: "dev.probe was killed and restored, but the visible-text comparison could not run: agent-device snapshot did not contain a UI tree",
      code: "COMPARE_UNAVAILABLE",
      death: diedAndRestored,
      help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(1);
    expectClean(fake);
  });

  it("rejects malformed nodes in the after snapshot", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [snapshotRule({ stdout: SNAPSHOT_BEFORE }, { stdout: '{"nodes":[null]}' })],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toMatchObject({
      code: "COMPARE_UNAVAILABLE",
      death: diedAndRestored,
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(2);
    expectClean(fake);
  });

  it("does not compare another app's foreground text with the restored app", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({ phase: "previous" }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error: "dev.probe was killed and restored, but the visible-text comparison could not run: dev.probe was not in front before the kill",
      code: "COMPARE_UNAVAILABLE",
      death: { ...diedAndRestored, cached_after_ms: 0 },
      help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(0);
    expect(shellCommands(fake)).toContain(AM_KILL);
    expect(shellCommands(fake)).toContain(START);
    expectClean(fake);
  });

  it("does not compare another app's text after restore", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [
          { match: shell(FOREGROUND), when: { app: "restored" }, respond: LAUNCHER_FRONT },
          snapshotRule({ stdout: SNAPSHOT_BEFORE }, { stdout: SNAPSHOT_AFTER }),
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error: "dev.probe was killed and restored, but the visible-text comparison could not run: dev.probe was not in front after the restore",
      code: "COMPARE_UNAVAILABLE",
      death: diedAndRestored,
      help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
    });
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(1);
    expect(shellCommands(fake)).toContain(AM_KILL);
    expect(shellCommands(fake)).toContain(START);
    expectClean(fake);
  });

  it("fails with COMPARE_UNAVAILABLE, exit 1, when agent-device is not installed, after the kill and restore ran", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      withoutAgentDevice(probeDevice({ phase: "front" })),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toEqual({
      error:
        "dev.probe was killed and restored, but the visible-text comparison could not run: agent-device is not installed or not on PATH",
      code: "COMPARE_UNAVAILABLE",
      death: diedAndRestored,
      help: ["Run `adb-axi app death dev.probe` to repeat the check without --compare"],
    });
    const commands = shellCommands(fake);
    expect(commands).toContain(AM_KILL);
    expect(commands).toContain(START);
    expectClean(fake);
  });

  it("fails with COMPARE_UNAVAILABLE when the snapshot itself fails", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--compare"], () =>
      probeDevice({
        phase: "front",
        rules: [
          {
            tool: "agent-device",
            match: ["snapshot", "--json"],
            respond: { stderr: "no active session\n", exit: 1 },
          },
        ],
      }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toMatchObject({
      error:
        "dev.probe was killed and restored, but the visible-text comparison could not run: agent-device snapshot exited 1",
      code: "COMPARE_UNAVAILABLE",
      detail: "no active session",
      death: diedAndRestored,
    });
    // The snapshot before the kill failed, so there is no point in a second one.
    expect(fake.calls().filter((call) => call.tool === "agent-device")).toHaveLength(1);
    expect(shellCommands(fake)).toContain(START);
    expectClean(fake);
  });

  it("fails with KILL_TIMEOUT as app kill does, and never restores", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe", "--timeout", "3s"], () =>
      probeDevice({ phase: "previous", package: INSTALLED_RELEASE, amKillWorks: false }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe was still alive at the 3 s deadline after am kill (previous, oom adj 700)",
      code: "KILL_TIMEOUT",
      last: { pid: OLD_PID, state: "previous", adj: 700 },
      am_kill_sent: true,
    });
    expect((data.help as string[])[0]).toBe(
      "Run `adb-axi app death dev.probe --timeout 30s` to give it longer",
    );
    expect(shellCommands(fake)).not.toContain(START);
    expectClean(fake);
  });

  it("fails with TASK_NOT_IN_RECENTS as app kill does, and never restores", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe"], () =>
      probeDevice({ phase: "previous", recents: RECENTS_GONE }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "TASK_NOT_IN_RECENTS", kill: { method: "am kill" } });
    expect(shellCommands(fake)).not.toContain(START);
    expectClean(fake);
  });

  it("fails with APP_DIED_ON_START as app restore does, with the kill evidence", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe"], () =>
      probeDevice({ phase: "front", start: { respond: AM_COLD, then: "dead" } }),
    );
    expect(toon.exitCode).toBe(1);
    expect(normalized(data)).toMatchObject({
      code: "APP_DIED_ON_START",
      last: { state: "stopped", pid: "-" },
      kill: killedFront,
    });
    expectClean(fake);
  });

  it("fails with APP_NOT_INSTALLED before touching the device", async () => {
    const { toon, data, fake } = await both(["app", "death", "dev.probe"], () =>
      probeDevice({ phase: "dead", package: ABSENT }),
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE]);
    expectClean(fake);
  });
});
