import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const CURRENT_USER = "am get-current-user";
const RESOLVE =
  "cmd package query-activities --components --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p dev.probe";
const KERNEL_UIDS = "ps -A -o PID,UID";
const PROCESSES = "dumpsys activity processes dev.probe";
const PROCESS_RUNNING = { stdoutFile: "captured/35/dumpsys-activity-processes-probe-front.txt" };
const PACKAGE = "dumpsys package dev.probe";
const FOREGROUND = "dumpsys activity activities";
const PIDOF = "pidof dev.probe";
const FORCE_STOP = "am force-stop --user 0 dev.probe";
const CLEAR = "pm clear --user 0 dev.probe";
const DATA_FILES = "run-as dev.probe --user 0 find . -type f";
const startOf = (activity: string): string => `am start --user 0 -W -n 'dev.probe/${activity}'`;
const START = startOf(".MainActivity");
const metadataOf = (activity: string, userId = 0): string =>
  `cmd package resolve-activity --user ${userId} -n 'dev.probe/${activity}'`;
const METADATA = metadataOf(".MainActivity");

function activityInfo(activity = ".MainActivity", process = "dev.probe"): Response {
  return {
    stdout: [
      "priority=0 preferredOrder=0 match=0x100000 specificIndex=-1 isDefault=false",
      "ActivityInfo:",
      ` name=${activity.startsWith(".") ? `dev.probe${activity}` : activity}`,
      " packageName=dev.probe",
      ...(process === "dev.probe" ? [] : [` processName=${process}`]),
      " enabled=true exported=true directBootAware=false",
      " ApplicationInfo:",
      "  packageName=dev.probe",
      "  processName=dev.probe",
      "",
    ].join("\n"),
  };
}

const INSTALLED = { stdoutFile: "captured/35/dumpsys-package-debug.txt" };
const INSTALLED_RELEASE = { stdoutFile: "captured/35/dumpsys-package-release.txt" };
const ABSENT = { stdoutFile: "captured/35/dumpsys-package-absent.txt" };
const PROBE_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt" };
const LAUNCHER_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-launcher-front.txt" };
const PROBE_RUNNING = { stdoutFile: "captured/35/pidof-running.txt" };
const PROBE_STOPPED = { stdoutFile: "captured/35/pidof-not-running.txt", exit: 1 };
const AM_START = {
  cold: { stdoutFile: "captured/35/am-start-cold.txt" },
  warm: { stdoutFile: "captured/35/am-start-warm.txt" },
  hot: { stdoutFile: "captured/35/am-start-hot.txt" },
  deliveredToTop: { stdoutFile: "captured/35/am-start-delivered-to-top.txt" },
  missingActivity: { stdoutFile: "captured/35/am-start-missing-activity.txt", exit: 1 },
};

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** One online emulator whose shell answers the given commands; anything else is unmatched. */
function device(answers: Record<string, Response>): FakeAdb {
  return deviceWithRules(
    Object.entries(answers).map(([command, respond]) => ({ match: shell(command), respond })),
  );
}

function deviceWithRules(rules: Rule[]): FakeAdb {
  fake = createFakeAdb({
    description: "One online emulator answering the app lifecycle commands",
    synthetic: true,
    rules: [
      { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
      ...rules,
      { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
      { match: shell(RESOLVE), respond: { stdout: "dev.probe/.MainActivity\n" } },
      { match: shell(PROCESSES), respond: PROCESS_RUNNING },
      { match: shell(METADATA), respond: activityInfo() },
      { match: shell(KERNEL_UIDS), respond: { stdout: "  PID   UID\n 8235 10213\n" } },
    ],
  });
  return fake;
}

function shell(command: string): string[] {
  return ["-s", SERIAL, "shell", command];
}

/**
 * A device where the probe's process follows the commands sent to it: `am force-stop` and
 * `pm clear` end it, `am start` (answered with `started`) brings it up in front. Its data
 * directory holds no files.
 */
function liveDevice(started: Response, initially: "running" | "stopped"): FakeAdb {
  fake = createFakeAdb({
    description: "The probe's process and foreground follow force-stop, clear and start",
    synthetic: true,
    state: { proc: initially },
    rules: [
      { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
      { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
      { match: shell(RESOLVE), respond: { stdout: "dev.probe/.MainActivity\n" } },
      { match: shell(METADATA), respond: activityInfo() },
      { match: shell(PROCESSES), when: { proc: "running" }, respond: PROCESS_RUNNING },
      { match: shell(PROCESSES), when: { proc: "stopped" }, respond: {} },
      {
        match: shell(KERNEL_UIDS),
        when: { proc: "running" },
        respond: { stdout: "  PID   UID\n 8235 10213\n" },
      },
      {
        match: shell(KERNEL_UIDS),
        when: { proc: "stopped" },
        respond: { stdout: "  PID   UID\n" },
      },
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(FORCE_STOP), respond: {}, set: { proc: "stopped" } },
      { match: shell(CLEAR), respond: { stdout: "Success\n" }, set: { proc: "stopped" } },
      { match: shell(DATA_FILES), respond: {} },
      { match: shell(START), respond: started, set: { proc: "running" } },
      { match: shell(PIDOF), when: { proc: "running" }, respond: PROBE_RUNNING },
      { match: shell(PIDOF), when: { proc: "stopped" }, respond: PROBE_STOPPED },
      { match: shell(FOREGROUND), when: { proc: "running" }, respond: PROBE_FRONT },
      { match: shell(FOREGROUND), when: { proc: "stopped" }, respond: LAUNCHER_FRONT },
    ],
  });
  return fake;
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
}

/** Run a command as TOON and as `--json`; the two must carry the same data field for field. */
async function both(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  const json = await runCli([...args, "--json"], f.env);
  // A mismatch reports both runs whole, so each format's typed error survives a rare failure.
  const runs = `TOON run: ${describeRun(toon)}\n--json run: ${describeRun(json)}`;
  expect(toon.exitCode, runs).toBe(json.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  // The two runs take different times; every other field must match exactly.
  expect(withoutTime(decoded), runs).toEqual(withoutTime(data));
  return { toon, json, data };
}

function describeRun(run: CliRun): string {
  return `exit ${run.exitCode} after ${run.durationMs} ms\nstdout:\n${run.stdout}stderr:\n${run.stderr}`;
}

function withoutTime(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.ok !== "string") return data;
  return { ...data, ok: data.ok.replace(/ after \d+ ms\)$/, " after <n> ms)") };
}

/** Both runs of `both` send the same calls, so a command's calls appear twice. */
function twice<T>(items: T[]): T[] {
  return [...items, ...items];
}

/** The shell commands sent to the device, in order. */
function shellCommands(f: FakeAdb): string[] {
  return f
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[2] === "shell")
    .map((argv) => argv[3] ?? "");
}

/** Every call was answered and every device call named its device. */
function expectClean(f: FakeAdb): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices") expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
  }
}

describe("app start", () => {
  it("reports a task brought to the front as a hot start that recreated nothing (S4, L4)", async () => {
    const f = liveDevice(AM_START.hot, "running");
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        "ok: start dev.probe -> foreground (existing task brought to front)",
        "app:",
        "  activity: .MainActivity",
        "  pid: 8235",
        "  launch: hot",
        "  recreated: false",
        "help[1]: Run `adb-axi app start dev.probe --fresh` to kill the process and cold-start",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "start dev.probe -> foreground (existing task brought to front)",
      app: { activity: ".MainActivity", pid: 8235, launch: "hot", recreated: false },
      help: ["Run `adb-axi app start dev.probe --fresh` to kill the process and cold-start"],
    });
    expect(shellCommands(f)).toEqual(
      twice([CURRENT_USER, PACKAGE, RESOLVE, START, METADATA, PROCESSES, FOREGROUND]),
    );
    expectClean(f);
  });

  it("force-stops first with --fresh, waits for the process to go, then cold-starts", async () => {
    const f = liveDevice(AM_START.cold, "running");
    const { toon, data } = await both(["app", "start", "dev.probe", "--fresh"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        "ok: start dev.probe -> foreground (cold start)",
        "app:",
        "  activity: .MainActivity",
        "  pid: 8235",
        "  launch: cold",
        "  recreated: true",
        "  took_ms: 1102",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "start dev.probe -> foreground (cold start)",
      app: { activity: ".MainActivity", pid: 8235, launch: "cold", recreated: true, took_ms: 1102 },
    });
    expect(shellCommands(f)).toEqual(
      twice([
        CURRENT_USER,
        PACKAGE,
        RESOLVE,
        FORCE_STOP,
        PIDOF,
        START,
        METADATA,
        PROCESSES,
        FOREGROUND,
      ]),
    );
    expectClean(f);
  });

  it("fails with STOP_FAILED, naming --fresh, when the process outlives the force-stop", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [FORCE_STOP]: {}, [PIDOF]: PROBE_RUNNING });
    const { toon, data } = await both(
      ["app", "start", "dev.probe", "--fresh", "--timeout", "1s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(3000);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe was still running at the 1 s deadline after am force-stop in `adb-axi app start dev.probe --fresh`",
        "code: STOP_FAILED",
        "last:",
        "  pid: 8235",
        "help[2]: Run `adb-axi app start dev.probe --fresh --timeout 30s` to give it longer,Run `adb-axi app info dev.probe` for its pid and foreground state",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "STOP_FAILED", last: { pid: 8235 } });
    expect(shellCommands(f)).not.toContain(START);
    expectClean(f);
  });

  it("names the requested activity in the STOP_FAILED help of --fresh", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [FORCE_STOP]: {}, [PIDOF]: PROBE_RUNNING });
    const { data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--fresh", "--timeout", "1s"],
      f,
    );
    expect(data).toMatchObject({
      code: "STOP_FAILED",
      help: [
        "Run `adb-axi app start dev.probe/.MainActivity --fresh --timeout 30s` to give it longer",
        "Run `adb-axi app info dev.probe` for its pid and foreground state",
      ],
    });
  });

  it("reports a warm start as recreated, with the system's launch time", async () => {
    const f = liveDevice(AM_START.warm, "running");
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "start dev.probe -> foreground (warm start)",
      app: { activity: ".MainActivity", pid: 8235, launch: "warm", recreated: true, took_ms: 628 },
    });
  });

  it("reports an intent delivered to the activity on top as launch unknown, not recreated (12.2)", async () => {
    const f = liveDevice(AM_START.deliveredToTop, "running");
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "start dev.probe -> foreground (already on top, intent delivered to it)",
      app: { activity: ".MainActivity", pid: 8235, launch: "unknown", recreated: false },
      help: ["Run `adb-axi app start dev.probe --fresh` to kill the process and cold-start"],
    });
  });

  it("reads API 29 output the same way: a cold start, and LaunchState: UNKNOWN (0) as launch unknown", async () => {
    const cold = liveDevice({ stdoutFile: "synthetic/29/am-start-cold.txt" }, "stopped");
    const first = await both(["app", "start", "dev.probe"], cold);
    expect(first.toon.exitCode).toBe(0);
    expect(first.data.app).toEqual({
      activity: ".MainActivity",
      pid: 8235,
      launch: "cold",
      recreated: true,
      took_ms: 1243,
    });
    cold.cleanup();

    const top = liveDevice({ stdoutFile: "synthetic/29/am-start-delivered-to-top.txt" }, "running");
    const second = await both(["app", "start", "dev.probe"], top);
    expect(second.toon.exitCode).toBe(0);
    expect(second.data.app).toMatchObject({ launch: "unknown", recreated: false });
  });

  it("starts the activity named after a slash or with --activity", async () => {
    for (const args of [
      ["app", "start", "dev.probe/.MainActivity"],
      ["app", "start", "dev.probe", "--activity", ".MainActivity"],
    ]) {
      const f = liveDevice(AM_START.hot, "running");
      const { toon } = await both(args, f);
      expect(toon.exitCode).toBe(0);
      expect(shellCommands(f)).toContain(START);
      expectClean(f);
      f.cleanup();
    }
  });

  it("quotes a nested activity class away from the device shell", async () => {
    const nested = startOf(".MainActivity$Alias");
    const f = device({
      [PACKAGE]: INSTALLED,
      [nested]: AM_START.hot,
      [PIDOF]: PROBE_RUNNING,
      [FOREGROUND]: PROBE_FRONT,
    });
    const { toon } = await both(["app", "start", "dev.probe/.MainActivity$Alias"], f);
    expect(toon.exitCode).toBe(0);
    expect(shellCommands(f)).toContain(nested);
    expectClean(f);
  });

  it("says when the app started but something else is in front", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [START]: AM_START.hot,
      [PIDOF]: PROBE_RUNNING,
      [FOREGROUND]: LAUNCHER_FRONT,
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "start dev.probe -> running, com.google.android.apps.nexuslauncher in front",
      app: { activity: ".MainActivity", pid: 8235, launch: "hot", recreated: false },
      help: ["Run `adb-axi app current` to see what is in front"],
    });
  }, 10000);

  it("fails with APP_NOT_INSTALLED, before any start, when the package is not installed", async () => {
    const f = device({ "dumpsys package dev.probe.missing": ABSENT });
    const { toon, data } = await both(["app", "start", "dev.probe.missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe.missing is not installed on this device",
        "code: APP_NOT_INSTALLED",
        "help[1]: Run `adb-axi app list --grep missing` to find the package",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, "dumpsys package dev.probe.missing"]));
  });

  it("fails with ACTIVITY_NOT_FOUND from am's Error type 3, listing the activities that exist", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [startOf(".Missing")]: AM_START.missingActivity });
    const { toon, data } = await both(["app", "start", "dev.probe/.Missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe has no activity .Missing",
        "code: ACTIVITY_NOT_FOUND",
        "activities[1]: .MainActivity",
        "help[1]: Run `adb-axi app start dev.probe/.MainActivity` to start a listed activity",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "ACTIVITY_NOT_FOUND", activities: [".MainActivity"] });
    expectClean(f);
  });

  it("reads Error type 3 from the text on API 29, where am exits 0 after it", async () => {
    const f = device({
      [PACKAGE]: { stdoutFile: "synthetic/29/dumpsys-package-debug.txt" },
      [startOf(".Missing")]: { stdoutFile: "synthetic/29/am-start-missing-activity.txt" },
    });
    const { toon, data } = await both(["app", "start", "dev.probe", "--activity", ".Missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "ACTIVITY_NOT_FOUND", activities: [".MainActivity"] });
  });

  it("fails with ACTIVITY_NOT_FOUND, without a start, when the app has no launcher activity", async () => {
    const f = device({
      [RESOLVE]: { stdout: "No activities found\n" },
      [PACKAGE]: {
        stdout:
          "Packages:\n  Package [dev.probe] (4f2a9c1):\n    appId=10213\n    User 0: ceDataInode=1 installed=true hidden=false stopped=false\n",
      },
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "ACTIVITY_NOT_FOUND",
      error: "dev.probe has no launcher activity",
      activities: [],
    });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, RESOLVE]));
  });

  it("fails with WAIT_TIMEOUT when am reports Status: timeout with exit 0 (S4)", async () => {
    const f = device({
      [PACKAGE]: { stdoutFile: "synthetic/29/dumpsys-package-debug.txt" },
      [START]: { stdoutFile: "synthetic/29/am-start-timeout.txt" },
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe did not finish launching within 15 s",
        "code: WAIT_TIMEOUT",
        "last:",
        "  status: timeout",
        "  activity: .MainActivity",
        "help[2]: Run `adb-axi app current` to see what is in front,Run `adb-axi app start dev.probe --timeout 30s` to give it longer",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT" });
    // The timed-out start is never read as a launched app.
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, RESOLVE, START]));
  });

  it("fails with WAIT_TIMEOUT when am start does not answer within --timeout", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [START]: { ...AM_START.cold, delayMs: 5000 } });
    const { toon, data } = await both(["app", "start", "dev.probe", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(3000);
    expect(data).toMatchObject({
      code: "WAIT_TIMEOUT",
      error: "dev.probe did not finish launching within 1 s",
      last: { status: "no answer", activity: ".MainActivity" },
    });
  });

  it("fails with APP_DIED_ON_START when the process is gone right after the start", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [START]: AM_START.cold,
      [PROCESSES]: {},
      [PIDOF]: PROBE_STOPPED,
      [FOREGROUND]: LAUNCHER_FRONT,
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: the dev.probe process of dev.probe/.MainActivity is gone right after its start",
        "code: APP_DIED_ON_START",
        "last:",
        "  state: stopped",
        '  pid: "-"',
        "  foreground: com.google.android.apps.nexuslauncher",
        "help[1]: Run `adb-axi app start dev.probe --fresh` to try a cold start",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "APP_DIED_ON_START" });
    // `logs crash` is not shipped yet, so no help line names it.
    expect(toon.stdout).not.toContain("logs crash");
    expectClean(f);
  });

  it("fails with REMOTE_EXIT when am refuses the start for another reason", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [START]: {
        stdout:
          "Starting: Intent { cmp=dev.probe/.MainActivity }\nError: Activity not started, you do not have permission to access it.\n",
        exit: 1,
      },
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "REMOTE_EXIT",
      step: "starting dev.probe/.MainActivity",
      exit: 1,
      detail: "Error: Activity not started, you do not have permission to access it.",
    });
  });

  it("rejects bad names and simultaneous activity selectors with exit 2 before any shell call", async () => {
    const f = device({});
    for (const args of [
      ["app", "start", "dev.probe; reboot"],
      ["app", "start", "dev.probe/.Main; reboot"],
      ["app", "start", "dev.probe", "--activity", "'.Main'"],
      ["app", "start", "dev.probe/.MainActivity", "--activity", ".OtherActivity"],
      ["app", "start", "dev.probe/.MainActivity", "--activity", ".MainActivity"],
      ["app", "start"],
    ]) {
      const { toon, data } = await both(args, f);
      expect(toon.exitCode, args.join(" ")).toBe(2);
      expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails with DEVICE_AMBIGUOUS when two devices are online and none is selected", async () => {
    fake = createFakeAdb("multi-device.json");
    const { toon, data } = await both(["app", "start", "dev.probe"], fake);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "DEVICE_AMBIGUOUS" });
  });
});

describe("app stop", () => {
  it("force-stops a running app and reports its pid gone", async () => {
    const f = liveDevice(AM_START.hot, "running");
    const toon = await runCli(["app", "stop", "dev.probe"], f.env);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatch(
      /^ok: stop dev\.probe -> not running \(pid 8235 gone after \d+ ms\)\n$/,
    );
    expect(shellCommands(f)).toEqual([
      CURRENT_USER,
      PACKAGE,
      PIDOF,
      KERNEL_UIDS,
      FORCE_STOP,
      PIDOF,
    ]);
    expectClean(f);
  });

  it("carries the same fields in --json", async () => {
    const toonDevice = liveDevice(AM_START.hot, "running");
    const toon = await runCli(["app", "stop", "dev.probe"], toonDevice.env);
    toonDevice.cleanup();
    const jsonDevice = liveDevice(AM_START.hot, "running");
    const json = await runCli(["app", "stop", "dev.probe", "--json"], jsonDevice.env);
    expect(json.exitCode).toBe(toon.exitCode);
    const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    const data = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["ok"]);
    expect(withoutTime(decoded)).toEqual(withoutTime(data));
  });

  it("names every pid of an app with two processes", async () => {
    fake = createFakeAdb({
      description: "Two probe processes that end on force-stop",
      synthetic: true,
      state: { proc: "running" },
      rules: [
        { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
        { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
        {
          match: shell(KERNEL_UIDS),
          respond: { stdout: "  PID   UID\n 5120 10213\n 5187 10213\n" },
        },
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(FORCE_STOP), respond: {}, set: { proc: "stopped" } },
        {
          match: shell(PIDOF),
          when: { proc: "running" },
          respond: { stdoutFile: "synthetic/29/pidof-two.txt" },
        },
        { match: shell(PIDOF), when: { proc: "stopped" }, respond: PROBE_STOPPED },
      ],
    });
    const run = await runCli(["app", "stop", "dev.probe"], fake.env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(
      /^ok: stop dev\.probe -> not running \(pids \d+ \d+ gone after \d+ ms\)\n$/,
    );
  });

  it("is the 'already not running' no-op with exit 0 for an app that is not running", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_STOPPED, [FORCE_STOP]: {} });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe("ok: stop dev.probe -> already not running (no-op)\n");
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expectClean(f);
  });

  it("still force-stops on the no-op, ending processes pidof does not see", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_STOPPED, [FORCE_STOP]: {} });
    const run = await runCli(["app", "stop", "dev.probe"], f.env);
    expect(run.exitCode).toBe(0);
    expect(shellCommands(f)).toEqual([CURRENT_USER, PACKAGE, PIDOF, FORCE_STOP]);
  });

  it("fails with STOP_FAILED, carrying the pid, when the process outlives the deadline", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_RUNNING, [FORCE_STOP]: {} });
    const { toon, data } = await both(["app", "stop", "dev.probe", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(3000);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe was still running at the 1 s deadline after am force-stop in `adb-axi app stop dev.probe`",
        "code: STOP_FAILED",
        "last:",
        "  pid: 8235",
        "help[2]: Run `adb-axi app stop dev.probe --timeout 30s` to give it longer,Run `adb-axi app info dev.probe` for its pid and foreground state",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "STOP_FAILED", last: { pid: 8235 } });
    expectClean(f);
  });

  it("fails with APP_NOT_INSTALLED when the package is not installed", async () => {
    const f = device({ "dumpsys package dev.probe.missing": ABSENT });
    const { toon, data } = await both(["app", "stop", "dev.probe.missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, "dumpsys package dev.probe.missing"]));
  });

  it("rejects a package name that is not one with exit 2, before any shell call", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "stop", "dev.probe; reboot"], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });
});

describe("app clear", () => {
  it("clears the data, verifies with run-as that no file is left, and reports the process stopped", async () => {
    const f = liveDevice(AM_START.hot, "running");
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        'ok: "clear dev.probe -> data cleared, process stopped"',
        "confirmed_by[2]: pm clear,run-as",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "clear dev.probe -> data cleared, process stopped",
      confirmed_by: ["pm clear", "run-as"],
    });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, CLEAR, PIDOF, DATA_FILES]));
    expectClean(f);
  });

  it("clears an app that is not running the same way", async () => {
    const f = liveDevice(AM_START.hot, "stopped");
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      ok: "clear dev.probe -> data cleared, process stopped",
      confirmed_by: ["pm clear", "run-as"],
    });
  });

  it("says only pm clear confirms the clear of an app that is not debuggable, without run-as", async () => {
    const f = device({
      [PACKAGE]: INSTALLED_RELEASE,
      [CLEAR]: { stdoutFile: "captured/35/pm-clear.txt" },
      [PIDOF]: PROBE_STOPPED,
    });
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        'ok: "clear dev.probe -> data cleared, process stopped"',
        "confirmed_by[1]: pm clear",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "clear dev.probe -> data cleared, process stopped",
      confirmed_by: ["pm clear"],
    });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, CLEAR, PIDOF]));
    expectClean(f);
  });

  it("fails with CLEAR_FAILED, listing the files, when run-as still finds data after pm clear", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [CLEAR]: { stdoutFile: "captured/35/pm-clear.txt" },
      [PIDOF]: PROBE_STOPPED,
      [DATA_FILES]: { stdout: "./databases/probe.db\n./shared_prefs/probe.xml\n" },
    });
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe still has 2 files in its data directory after pm clear",
        "code: CLEAR_FAILED",
        "left:",
        "  count: 2",
        "  files[2]: databases/probe.db,shared_prefs/probe.xml",
        "help[2]: Run `adb-axi app clear dev.probe` to clear it again,Run `adb-axi app info dev.probe` for its data size",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({
      code: "CLEAR_FAILED",
      left: { count: 2, files: ["databases/probe.db", "shared_prefs/probe.xml"] },
    });
    expectClean(f);
  });

  it("says only pm clear confirms the clear when the device refuses run-as for a debuggable app", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [CLEAR]: { stdoutFile: "captured/35/pm-clear.txt" },
      [PIDOF]: PROBE_STOPPED,
      [DATA_FILES]: { stderr: "run-as: package not debuggable: dev.probe\n", exit: 1 },
    });
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        'ok: "clear dev.probe -> data cleared, process stopped"',
        "confirmed_by[1]: pm clear",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      ok: "clear dev.probe -> data cleared, process stopped",
      confirmed_by: ["pm clear"],
    });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, CLEAR, PIDOF, DATA_FILES]));
    expectClean(f);
  });

  it("fails with STOP_FAILED, naming pm clear, when the process is still there at the deadline", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [CLEAR]: { stdoutFile: "captured/35/pm-clear.txt" },
      [PIDOF]: PROBE_RUNNING,
    });
    const { toon, data } = await both(["app", "clear", "dev.probe", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error:
        "dev.probe was still running at the 1 s deadline after pm clear in `adb-axi app clear dev.probe`",
      code: "STOP_FAILED",
      last: { pid: 8235 },
      help: [
        "Run `adb-axi app clear dev.probe --timeout 30s` to give it longer",
        "Run `adb-axi app info dev.probe` for its pid and foreground state",
      ],
    });
    expect(shellCommands(f)).not.toContain(DATA_FILES);
  });

  it("fails with REMOTE_EXIT, never a cleared claim, when the package manager refuses", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [CLEAR]: { stdout: "Failed\n", exit: 1 } });
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "clearing the data of dev.probe" });
    expect(shellCommands(f)).not.toContain(PIDOF);
  });

  it("fails with APP_NOT_INSTALLED, before clearing anything, when the package is not installed", async () => {
    const f = device({ "dumpsys package dev.probe.missing": ABSENT });
    const { toon, data } = await both(["app", "clear", "dev.probe.missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, "dumpsys package dev.probe.missing"]));
  });
});

describe("lifecycle review regressions", () => {
  it.each([false, true].flatMap((fresh) => [false, true].map((multiple) => ({ fresh, multiple }))))(
    "selects enabled package launcher candidates before starting, fresh=$fresh, multiple=$multiple",
    async ({ fresh, multiple }) => {
      const f = device({
        [PACKAGE]: {
          stdout: [
            "Activity Resolver Table:",
            "  Non-Data Actions:",
            "      android.intent.action.MAIN:",
            "        abc dev.probe/.Disabled filter def",
            '          Action: "android.intent.action.MAIN"',
            '          Category: "android.intent.category.LAUNCHER"',
            "        def dev.probe/.Alternate filter abc",
            '          Action: "android.intent.action.MAIN"',
            '          Category: "android.intent.category.LAUNCHER"',
            "        abd dev.probe/.OtherIcon filter bcd",
            '          Action: "android.intent.action.MAIN"',
            '          Category: "android.intent.category.LAUNCHER"',
            "Packages:",
            "  Package [dev.probe] (abc):",
            "    appId=10213",
            "    User 0: installed=true hidden=false",
            "      disabledComponents:",
            "        dev.probe.Disabled",
          ].join("\n"),
        },
        [RESOLVE]: {
          stdout: multiple
            ? "dev.probe/.Alternate\ndev.probe/.OtherIcon\n"
            : "dev.probe/.Alternate\n",
        },
        "cmd package resolve-activity --components --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p dev.probe":
          {
            stdout: multiple
              ? "android/com.android.internal.app.ResolverActivity\n"
              : "dev.probe/.Alternate\n",
          },
        [startOf(".Alternate")]: {
          stdout:
            "Status: ok\nLaunchState: COLD\nActivity: dev.probe/.Alternate\nTotalTime: 1102\nComplete\n",
        },
        [metadataOf(".Alternate")]: activityInfo(".Alternate"),
        [FOREGROUND]: {
          stdout: "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.Alternate t8}\n",
        },
        [FORCE_STOP]: {},
        [PIDOF]: PROBE_STOPPED,
      });
      const { toon, data } = await both(
        ["app", "start", "dev.probe", ...(fresh ? ["--fresh"] : [])],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(data.app).toMatchObject({ activity: ".Alternate", pid: 8235 });
      const calls = shellCommands(f);
      expect(calls).not.toContain(startOf(".Disabled"));
      expect(calls).not.toContain(startOf(".OtherIcon"));
      expect(calls.indexOf(RESOLVE)).toBeLessThan(calls.indexOf(startOf(".Alternate")));
      if (fresh) expect(calls.indexOf(RESOLVE)).toBeLessThan(calls.indexOf(FORCE_STOP));
      expectClean(f);
    },
  );

  it.each(
    [0, 10].flatMap((userId) => ["stop", "start", "clear"].map((command) => ({ userId, command }))),
  )(
    "keeps polling a kernel main PID after AMS removes it, user=$userId, command=$command",
    async ({ userId, command }) => {
      const otherUser = userId === 0 ? 10 : 0;
      const forceStop = FORCE_STOP.replace("--user 0", `--user ${userId}`);
      const clear = CLEAR.replace("--user 0", `--user ${userId}`);
      const start = START.replace("--user 0", `--user ${userId}`);
      const dataFiles = DATA_FILES.replace("--user 0", `--user ${userId}`);
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    flags=[ DEBUGGABLE HAS_CODE ]\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [forceStop]: {},
        [clear]: { stdout: "Success\n" },
        [start]: AM_START.cold,
        [PIDOF]: { stdout: "8235 9001\n" },
        [KERNEL_UIDS]: {
          stdout: `  PID   UID\n 8235 ${userId * 100000 + 10213}\n 9001 ${otherUser * 100000 + 10213}\n`,
        },
        [PROCESSES]: {},
        [FOREGROUND]: PROBE_FRONT,
        [dataFiles]: {},
      });
      const { toon, data } = await both(
        [
          "app",
          command,
          "dev.probe",
          ...(command === "start" ? ["--activity", ".MainActivity", "--fresh"] : []),
          "--timeout",
          "1s",
        ],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "STOP_FAILED", last: { pid: 8235 } });
      const calls = shellCommands(f);
      expect(calls).toContain(command === "clear" ? clear : forceStop);
      expect(calls).toContain(KERNEL_UIDS);
      expect(calls).not.toContain(PROCESSES);
      expect(calls).not.toContain(start);
      expect(calls).not.toContain(dataFiles);
      expectClean(f);
    },
  );

  it.each([
    ["No activities found\n", "ACTIVITY_NOT_FOUND"],
    ["android/com.android.internal.app.ResolverActivity\n", "INVALID_OUTPUT"],
  ])(
    "rejects unavailable package launcher candidates (%s) before a fresh stop",
    async (stdout, code) => {
      const f = device({ [PACKAGE]: INSTALLED, [RESOLVE]: { stdout } });
      const { toon, data } = await both(["app", "start", "dev.probe", "--fresh"], f);
      expect(toon.exitCode).toBe(1);
      expect(data.code).toBe(code);
      expect(shellCommands(f)).not.toContain(FORCE_STOP);
      expect(shellCommands(f)).not.toContain(START);
      expectClean(f);
    },
  );

  it.each([
    "",
    "PID USER\n8235 u0_a213\n",
    "PID UID\n8235 invalid\n",
    "PID UID\n8235 9007199254740993\n",
    "PID UID\n9007199254740993 10213\n",
  ])("does not guess process ownership from unreadable kernel UID output (%s)", async (stdout) => {
    const f = device({ [PACKAGE]: INSTALLED, [PIDOF]: PROBE_RUNNING, [KERNEL_UIDS]: { stdout } });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading process user IDs" });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expectClean(f);
  });

  it("reports a kernel UID read refusal rather than assuming the main PID is gone", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stderr: "Permission denied\n", exit: 1 },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading process user IDs" });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expectClean(f);
  });

  it("handles a main PID exiting between pidof and the kernel UID read", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: PROBE_RUNNING,
      [KERNEL_UIDS]: { stdout: "  PID   UID\n" },
      [FORCE_STOP]: {},
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toEqual(
      twice([CURRENT_USER, PACKAGE, PIDOF, KERNEL_UIDS, FORCE_STOP]),
    );
    expectClean(f);
  });

  it.each([
    ["app", "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.MainActivity t8}\n", "foreground"],
    [
      "app with full class name",
      "  ResumedActivity: ActivityRecord{abc u0 dev.probe/dev.probe.MainActivity t8}\n",
      "foreground",
    ],
    [
      "another activity of the same app",
      "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.OtherActivity t8}\n",
      "running",
    ],
    [
      "permission dialog",
      "  ResumedActivity: ActivityRecord{abc u0 com.android.permissioncontroller/.Grant t9}\n",
      "running",
    ],
    ["screen off", "", "running"],
  ])(
    "observes a secondary UI process with %s in front",
    async (_name, front, state) => {
      const f = device({
        [PACKAGE]: INSTALLED,
        [START]: AM_START.cold,
        [PIDOF]: PROBE_STOPPED,
        [METADATA]: activityInfo(".MainActivity", "dev.probe:ui"),
        [PROCESSES]: {
          stdout:
            "  *APP* UID 10213 ProcessRecord{abc 8235:dev.probe/u0a213}\n  *APP* UID 10213 ProcessRecord{def 8111:dev.probe:sync/u0a213}\n  *APP* UID 10213 ProcessRecord{fed 8123:dev.probe:ui/u0a213}\n",
        },
        [FOREGROUND]: { stdout: front },
      });
      const { toon, data } = await both(["app", "start", "dev.probe/.MainActivity"], f);
      expect(toon.exitCode).toBe(0);
      expect(data.app).toMatchObject({
        pid: 8123,
        activity: front.includes("dev.probe/dev.probe.MainActivity")
          ? "dev.probe.MainActivity"
          : ".MainActivity",
      });
      expect(data.ok).toContain(`-> ${state}`);
      expect(shellCommands(f)).not.toContain(PIDOF);
      expect(shellCommands(f)).not.toContain(RESOLVE);
      expectClean(f);
    },
    10000,
  );

  it.each([0, 1])("rejects remaining files even when find exits %s", async (exit) => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [CLEAR]: { stdout: "Success\n" },
      [PIDOF]: PROBE_STOPPED,
      [DATA_FILES]: {
        stdout: "./databases/probe.db\n",
        stderr: exit === 1 ? "find: ./files: Permission denied\n" : "",
        exit,
      },
    });
    const { toon, data } = await both(["app", "clear", "dev.probe", "--device", SERIAL], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "CLEAR_FAILED",
      left: { count: 1, files: ["databases/probe.db"] },
      help: [
        `Run \`adb-axi app clear dev.probe --device ${SERIAL}\` to clear it again`,
        `Run \`adb-axi app info dev.probe --device ${SERIAL}\` for its data size`,
      ],
    });
    expectClean(f);
  });

  it.each([false, true])("offers full remaining-file output, full=%s", async (full) => {
    const files = Array.from({ length: 11 }, (_, i) => `files/${i}.txt`);
    const f = device({
      [PACKAGE]: INSTALLED,
      [CLEAR]: { stdout: "Success\n" },
      [PIDOF]: PROBE_STOPPED,
      [DATA_FILES]: { stdout: files.map((file) => `./${file}\n`).join("") },
    });
    const { toon, data } = await both(
      ["app", "clear", "dev.probe", "--device", SERIAL, ...(full ? ["--full"] : [])],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "CLEAR_FAILED",
      left: { count: 11, files: full ? files : files.slice(0, 10) },
    });
    const help = data.help as string[];
    if (full)
      expect(help).not.toContain(
        `Run \`adb-axi app clear dev.probe --full --device ${SERIAL}\` to list all remaining files`,
      );
    else
      expect(help).toContain(
        `Run \`adb-axi app clear dev.probe --full --device ${SERIAL}\` to list all remaining files`,
      );
    expectClean(f);
  });

  it.each([
    [
      "start",
      START,
      "Starting: Intent { cmp=dev.probe/.MainActivity }\n",
      "starting dev.probe/.MainActivity",
    ],
    ["clear", CLEAR, "Unexpected\n", "clearing the data of dev.probe"],
  ])(
    "reports INVALID_OUTPUT from %s with output parity",
    async (command, shellCommand, stdout, step) => {
      const f = device({ [PACKAGE]: INSTALLED, [shellCommand]: { stdout } });
      const { toon, data } = await both(["app", command, "dev.probe"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INVALID_OUTPUT", step, detail: stdout.trim() });
      expectClean(f);
    },
  );

  it("rejects an invalid clear package with output parity before shell calls", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "clear", "dev.probe; reboot"], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });

  it.each(["start", "stop", "clear"])(
    "limits %s mutations and observations to current user 10",
    async (command) => {
      let previous: Record<string, unknown> | undefined;
      for (const json of [false, true]) {
        const stop = "am force-stop --user 10 dev.probe";
        const clear = "pm clear --user 10 dev.probe";
        const start = "am start --user 10 -W -n 'dev.probe/.MainActivity'";
        const resolve = RESOLVE.replace("--user 0", "--user 10");
        const files = DATA_FILES.replace("--user 0", "--user 10");
        fake = createFakeAdb({
          description: "Only the current user's process and data change",
          synthetic: true,
          state: {
            current: "running",
            other: "running",
            otherData: "present",
            currentData: "present",
          },
          rules: [
            { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
            { match: shell(CURRENT_USER), respond: { stdout: "10\n" } },
            {
              match: shell(PACKAGE),
              respond: {
                stdout:
                  "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    flags=[ DEBUGGABLE HAS_CODE ]\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
              },
            },
            { match: shell(resolve), respond: { stdout: "dev.probe/.MainActivity\n" } },
            { match: shell(metadataOf(".MainActivity", 10)), respond: activityInfo() },
            { match: shell(stop), respond: {}, set: { current: "stopped" } },
            {
              match: shell(clear),
              respond: { stdout: "Success\n" },
              set: { current: "stopped", currentData: "empty" },
            },
            { match: shell(start), respond: AM_START.cold, set: { current: "running" } },
            { match: shell(files), when: { currentData: "empty" }, respond: {} },
            {
              match: shell(PIDOF),
              when: { current: "running" },
              respond: { stdout: "9001 8235\n" },
            },
            { match: shell(PIDOF), when: { current: "stopped" }, respond: { stdout: "9001\n" } },
            {
              match: shell(KERNEL_UIDS),
              when: { current: "running" },
              respond: { stdout: "  PID   UID\n 9001 10213\n 8235 1010213\n" },
            },
            {
              match: shell(KERNEL_UIDS),
              when: { current: "stopped" },
              respond: { stdout: "  PID   UID\n 9001 10213\n" },
            },
            {
              match: shell(PROCESSES),
              when: { current: "running" },
              respond: {
                stdout:
                  "  *APP* UID 10213 ProcessRecord{abc 9001:dev.probe/u0a213}\n  *APP* UID 1010213 ProcessRecord{def 8235:dev.probe/u10a213}\n",
              },
            },
            {
              match: shell(PROCESSES),
              when: { current: "stopped" },
              respond: { stdout: "  *APP* UID 10213 ProcessRecord{abc 9001:dev.probe/u0a213}\n" },
            },
            {
              match: shell(FOREGROUND),
              respond: {
                stdout:
                  "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.OtherProfile t2}\n  ResumedActivity: ActivityRecord{def u10 dev.probe/.MainActivity t8}\n",
              },
            },
          ],
        });
        const result = await runCli(
          [
            "app",
            command,
            "dev.probe",
            ...(command === "start" ? ["--fresh"] : []),
            ...(json ? ["--json"] : []),
          ],
          fake.env,
        );
        expect(result.exitCode).toBe(0);
        const data = (json ? JSON.parse(result.stdout) : decode(result.stdout.trimEnd())) as Record<
          string,
          unknown
        >;
        if (previous !== undefined) expect(withoutTime(data)).toEqual(withoutTime(previous));
        previous = data;
        expect(fake.vars()).toMatchObject({
          other: "running",
          otherData: "present",
          current: command === "start" ? "running" : "stopped",
        });
        if (command === "start")
          expect(data.app).toMatchObject({ pid: 8235, activity: ".MainActivity" });
        if (command === "stop") expect(data.ok).toMatch(/pid 8235 gone/);
        if (command === "clear") expect(data.confirmed_by).toEqual(["pm clear", "run-as"]);
        expectClean(fake);
        fake.cleanup();
      }
    },
  );

  it.each(["start", "stop", "clear"])(
    "does not %s a package installed only for another user",
    async (command) => {
      const f = device({ [CURRENT_USER]: { stdout: "10\n" }, [PACKAGE]: INSTALLED });
      const { toon, data } = await both(["app", command, "dev.probe", "--device", SERIAL], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "APP_NOT_INSTALLED",
        help: [`Run \`adb-axi app list --grep probe --device ${SERIAL}\` to find the package`],
      });
      expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE]));
      expectClean(f);
    },
  );

  it.each([
    ["WAIT_TIMEOUT", { stdout: "Status: timeout\n" }, false],
    ["WAIT_TIMEOUT", { delayMs: 5000 }, false],
    ["STOP_FAILED", AM_START.cold, true],
    ["APP_DIED_ON_START", AM_START.cold, false],
    ["REMOTE_EXIT", { stderr: "Permission denied\n", exit: 1 }, false],
    ["ACTIVITY_NOT_FOUND", AM_START.missingActivity, false],
  ] as const)(
    "preserves activity, fresh mode and device for %s",
    async (code, response, stopFails) => {
      const f = device({
        [PACKAGE]: INSTALLED,
        [FORCE_STOP]: {},
        [PIDOF]: stopFails ? PROBE_RUNNING : PROBE_STOPPED,
        [PROCESSES]: stopFails ? PROCESS_RUNNING : {},
        [FOREGROUND]: LAUNCHER_FRONT,
        [startOf(".Editor")]: response,
      });
      const { toon, data } = await both(
        [
          "app",
          "start",
          "dev.probe",
          "--activity",
          ".Editor",
          "--fresh",
          "--device",
          SERIAL,
          "--timeout",
          "1s",
        ],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(data.code).toBe(code);
      const help = data.help as string[];
      expect(help.every((line) => line.includes(`--device ${SERIAL}`))).toBe(true);
      if (["WAIT_TIMEOUT", "STOP_FAILED"].includes(code))
        expect(help).toContain(
          `Run \`adb-axi app start dev.probe/.Editor --fresh --device ${SERIAL} --timeout 30s\` to give it longer`,
        );
      if (code === "APP_DIED_ON_START")
        expect(help).toContain(
          `Run \`adb-axi app start dev.probe/.Editor --fresh --device ${SERIAL}\` to try a cold start`,
        );
      expectClean(f);
    },
  );

  it.each([0, 10])(
    "does not treat another profile's activity or process as user %s liveness",
    async (userId) => {
      const other = userId === 0 ? 10 : 0;
      const start = START.replace("--user 0", `--user ${userId}`);
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [start]: AM_START.cold,
        [metadataOf(".MainActivity", userId)]: activityInfo(),
        [PROCESSES]: {
          stdout: `  *APP* UID ${other * 100000 + 10213} ProcessRecord{abc 9001:dev.probe/u${other}a213}\n`,
        },
        [FOREGROUND]: {
          stdout: `  ResumedActivity: ActivityRecord{abc u${other} dev.probe/.MainActivity t8}\n`,
        },
      });
      const { toon, data } = await both(["app", "start", "dev.probe/.MainActivity"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "APP_DIED_ON_START",
        last: { state: "stopped", pid: "-", foreground: "-" },
      });
      expectClean(f);
    },
  );

  it("keeps stop's no-op and force-stop scoped when only another profile is running", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PIDOF]: { stdout: "9001\n" },
      [FORCE_STOP]: {},
      [KERNEL_UIDS]: { stdout: "  PID   UID\n 9001 1010213\n" },
    });
    const { toon, data } = await both(["app", "stop", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ ok: "stop dev.probe -> already not running (no-op)" });
    expect(shellCommands(f)).toEqual(
      twice([CURRENT_USER, PACKAGE, PIDOF, KERNEL_UIDS, FORCE_STOP]),
    );
    expectClean(f);
  });

  it.each([
    [CURRENT_USER, "unknown\n", "reading the current Android user"],
    [RESOLVE, "unexpected\n", "resolving the launcher activity of dev.probe"],
  ])("rejects unreadable output from %s without mutating", async (command, stdout, step) => {
    const f = device({ [PACKAGE]: INSTALLED, [command]: { stdout } });
    const { toon, data } = await both(["app", "start", "dev.probe", "--fresh"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT", step });
    expect(shellCommands(f)).not.toContain(FORCE_STOP);
    expect(shellCommands(f)).not.toContain(START);
    expectClean(f);
  });

  it("preserves an explicit activity and environment device in cold-start help", async () => {
    const f = liveDevice(AM_START.hot, "running");
    f.env.ANDROID_SERIAL = SERIAL;
    const { data } = await both(["app", "start", "dev.probe/.MainActivity"], f);
    expect(data.help).toEqual([
      `Run \`adb-axi app start dev.probe/.MainActivity --device ${SERIAL} --fresh\` to kill the process and cold-start`,
    ]);
    expectClean(f);
  });
});

describe("app start settle deadlines", () => {
  const ui: Response = {
    stdout: "  *APP* UID 10213 ProcessRecord{abc 8123:dev.probe:ui/u0a213}\n",
  };
  const permission: Response = {
    stdout:
      "  ResumedActivity: ActivityRecord{abc u0 com.android.permissioncontroller/.Grant t8}\n",
  };

  it.each(
    [0, 10].flatMap((userId) =>
      [false, true].flatMap((fresh) =>
        ["dev.probe", "dev.probe:ui"].map((process) => ({ userId, fresh, process })),
      ),
    ),
  )(
    "returns the complete short-budget observation, user=$userId, fresh=$fresh, process=$process",
    async ({ userId, fresh, process }) => {
      const other = userId === 0 ? 10 : 0;
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [START.replace("--user 0", `--user ${userId}`)]: AM_START.cold,
        [FORCE_STOP.replace("--user 0", `--user ${userId}`)]: {},
        [PIDOF]: PROBE_STOPPED,
        [metadataOf(".MainActivity", userId)]: activityInfo(".MainActivity", process),
        [PROCESSES]: {
          stdout: `  *APP* UID ${userId * 100000 + 10213} ProcessRecord{abc 8123:${process}/u${userId}a213}\n  *APP* UID ${userId * 100000 + 10213} ProcessRecord{def 8111:dev.probe:sync/u${userId}a213}\n  *APP* UID ${other * 100000 + 10213} ProcessRecord{fed 9001:${process}/u${other}a213}\n`,
        },
        [FOREGROUND]: {
          stdout: `  ResumedActivity: ActivityRecord{abc u${userId} com.android.permissioncontroller/.Grant t8}\n`,
        },
      });
      const { toon, json, data } = await both(
        [
          "app",
          "start",
          "dev.probe/.MainActivity",
          ...(fresh ? ["--fresh"] : []),
          "--timeout",
          "1s",
        ],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toEqual({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: {
          activity: ".MainActivity",
          pid: 8123,
          launch: "cold",
          recreated: true,
          took_ms: 1102,
        },
        help: ["Run `adb-axi app current` to see what is in front"],
      });
      expect(toon.durationMs).toBeLessThan(3000);
      expect(json.durationMs).toBeLessThan(3000);
      expect(
        f.calls().filter((call) => call.argv[3] === FOREGROUND && call.exit === 0).length,
      ).toBeGreaterThanOrEqual(2);
      expectClean(f);
    },
  );

  it.each(["process", "foreground"])(
    "keeps the complete observation when a later %s read times out",
    async (step) => {
      const f = deviceWithRules([
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
        { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
        {
          match: shell(PROCESSES),
          when: { observation: "first" },
          respond: ui,
          set: { observation: "first-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "first-front" },
          respond: permission,
          set: { observation: "later" },
        },
        {
          match: shell(PROCESSES),
          when: { observation: "later" },
          respond: step === "process" ? { delayMs: 5000 } : {},
          set: { observation: "later-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "later-front" },
          respond: { delayMs: 5000 },
        },
      ]);
      const { toon, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", "1s"],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toMatchObject({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: { activity: ".MainActivity", pid: 8123 },
      });
      expectClean(f);
    },
  );

  it.each(
    [PROCESSES, FOREGROUND].flatMap((command) =>
      ["1s", "6s"].map((timeout) => ({ command, timeout })),
    ),
  )(
    "fails when $command expires before any complete observation with timeout=$timeout",
    async ({ command, timeout }) => {
      const f = device({
        [PACKAGE]: INSTALLED,
        [START]: AM_START.cold,
        [METADATA]: activityInfo(".MainActivity", "dev.probe:ui"),
        [PROCESSES]: ui,
        [FOREGROUND]: permission,
        [command]: { delayMs: 5000 },
      });
      const { toon, json, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", timeout],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(4000);
      expect(json.durationMs).toBeLessThan(4000);
      expect(data).toMatchObject({
        code: "TIMEOUT",
        step:
          command === PROCESSES
            ? "reading the processes of dev.probe"
            : "reading the foreground activity",
      });
      expect(data).not.toHaveProperty("app");
      expect(data).not.toHaveProperty("ok");
      expectClean(f);
    },
  );

  it.each(["process", "foreground"])(
    "bounds a stalled later %s read to the settle window rather than the command timeout",
    async (step) => {
      const f = deviceWithRules([
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
        { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
        {
          match: shell(PROCESSES),
          when: { observation: "first" },
          respond: ui,
          set: { observation: "first-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "first-front" },
          respond: permission,
          set: { observation: "later" },
        },
        {
          match: shell(PROCESSES),
          when: { observation: "later" },
          respond: step === "process" ? { delayMs: 10000 } : {},
          set: { observation: "later-front" },
        },
        {
          match: shell(FOREGROUND),
          when: { observation: "later-front" },
          respond: { delayMs: 10000 },
        },
      ]);
      const { toon, json, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", "6s"],
        f,
      );
      expect(toon.exitCode).toBe(0);
      expect(toon.durationMs).toBeLessThan(4000);
      expect(json.durationMs).toBeLessThan(4000);
      expect(data).toMatchObject({
        ok: "start dev.probe -> running, com.android.permissioncontroller in front",
        app: { activity: ".MainActivity", pid: 8123 },
      });
      expectClean(f);
    },
  );

  it("does not hide a later non-timeout read failure behind an earlier observation", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "first-front" },
      },
      {
        match: shell(FOREGROUND),
        when: { observation: "first-front" },
        respond: permission,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { exit: 2, stderr: "Permission denied\n" },
      },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", "2s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading the processes of dev.probe" });
    expect(data).not.toHaveProperty("app");
    expectClean(f);
  });

  it("recognizes process death in a later complete observation despite an earlier live state", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { stdout: "  *APP* UID 10213 ProcessRecord{def 8111:dev.probe:sync/u0a213}\n" },
      },
      { match: shell(FOREGROUND), respond: permission },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", "2s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "APP_DIED_ON_START", last: { state: "stopped", pid: "-" } });
    expect(data).not.toHaveProperty("app");
    expectClean(f);
  });

  it("returns the latest complete observation rather than the first one", async () => {
    const f = deviceWithRules([
      { match: shell(PACKAGE), respond: INSTALLED },
      { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
      { match: shell(START), respond: AM_START.cold, set: { observation: "first" } },
      {
        match: shell(PROCESSES),
        when: { observation: "first" },
        respond: ui,
        set: { observation: "later" },
      },
      {
        match: shell(PROCESSES),
        when: { observation: "later" },
        respond: { stdout: "  *APP* UID 10213 ProcessRecord{def 9123:dev.probe:ui/u0a213}\n" },
      },
      { match: shell(FOREGROUND), respond: permission },
    ]);
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", "--timeout", "5s"],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({
      ok: "start dev.probe -> running, com.android.permissioncontroller in front",
      app: { pid: 9123 },
    });
    expectClean(f);
  }, 20000);
});

describe("launched activity process identity", () => {
  it.each(
    [0, 10].flatMap((userId) =>
      [false, true].flatMap((fresh) =>
        ["dev.probe", "dev.probe:ui"].map((process) => ({ userId, fresh, process })),
      ),
    ),
  )(
    "reports launch death despite surviving unrelated processes, user=$userId, fresh=$fresh, process=$process",
    async ({ userId, fresh, process }) => {
      const other = userId === 0 ? 10 : 0;
      const uid = userId * 100000 + 10213;
      const start = START.replace("--user 0", `--user ${userId}`);
      const front = fresh
        ? "dev.probe/.MainActivity"
        : "com.google.android.apps.nexuslauncher/.NexusLauncherActivity";
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [start]: AM_START.cold,
        [FORCE_STOP.replace("--user 0", `--user ${userId}`)]: {},
        [PIDOF]: PROBE_STOPPED,
        [metadataOf(".MainActivity", userId)]: activityInfo(".MainActivity", process),
        [PROCESSES]: {
          stdout: [
            `  *APP* UID ${uid} ProcessRecord{abc 8111:dev.probe:sync/u${userId}a213}`,
            ...(process === "dev.probe:ui"
              ? [`  *APP* UID ${uid} ProcessRecord{def 8235:dev.probe/u${userId}a213}`]
              : []),
            `  *APP* UID ${other * 100000 + 10213} ProcessRecord{fed 9001:${process}/u${other}a213}`,
            "",
          ].join("\n"),
        },
        [FOREGROUND]: { stdout: `  ResumedActivity: ActivityRecord{abc u${userId} ${front} t8}\n` },
      });
      const { toon, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", ...(fresh ? ["--fresh"] : [])],
        f,
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "APP_DIED_ON_START",
        error: `the ${process} process of dev.probe/.MainActivity is gone right after its start`,
        last: { state: "stopped", pid: "-" },
      });
      expect(data).not.toHaveProperty("app");
      expectClean(f);
    },
  );

  it.each([false, true])("reports the live UI process in user 10, fresh=%s", async (fresh) => {
    const f = device({
      [CURRENT_USER]: { stdout: "10\n" },
      [PACKAGE]: {
        stdout:
          "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
      },
      [START.replace("--user 0", "--user 10")]: AM_START.cold,
      [FORCE_STOP.replace("--user 0", "--user 10")]: {},
      [PIDOF]: PROBE_STOPPED,
      [metadataOf(".MainActivity", 10)]: activityInfo(".MainActivity", "dev.probe:ui"),
      [PROCESSES]: {
        stdout:
          "  *APP* UID 10213 ProcessRecord{abc 9001:dev.probe:ui/u0a213}\n  *APP* UID 1010213 ProcessRecord{def 8235:dev.probe/u10a213}\n  *APP* UID 1010213 ProcessRecord{fed 8123:dev.probe:ui/u10a213}\n",
      },
      [FOREGROUND]: {
        stdout:
          "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.MainActivity t2}\n  ResumedActivity: ActivityRecord{def u10 dev.probe/.MainActivity t8}\n",
      },
    });
    const { toon, data } = await both(
      ["app", "start", "dev.probe/.MainActivity", ...(fresh ? ["--fresh"] : [])],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({
      ok: "start dev.probe -> foreground (cold start)",
      app: { activity: ".MainActivity", pid: 8123 },
    });
    expectClean(f);
  });

  it("correlates an alias launch to the actual activity reported by am", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [startOf(".IconAlias")]: AM_START.cold,
      [METADATA]: activityInfo(".MainActivity", "dev.probe:ui"),
      [PROCESSES]: {
        stdout:
          "  *APP* UID 10213 ProcessRecord{abc 8111:dev.probe:sync/u0a213}\n  *APP* UID 10213 ProcessRecord{def 8123:dev.probe:ui/u0a213}\n",
      },
      [FOREGROUND]: PROBE_FRONT,
    });
    const { toon, data } = await both(["app", "start", "dev.probe/.IconAlias"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.app).toMatchObject({ activity: ".MainActivity", pid: 8123 });
    expect(shellCommands(f)).toContain(METADATA);
    expect(shellCommands(f)).not.toContain(metadataOf(".IconAlias"));
    expectClean(f);
  });

  it("uses the explicitly selected activity when am omits Activity", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [startOf("dev.probe.MainActivity")]: { stdout: "Status: ok\nLaunchState: COLD\nComplete\n" },
      [metadataOf("dev.probe.MainActivity")]: activityInfo(".MainActivity", "dev.probe:ui"),
      [PROCESSES]: {
        stdout:
          "  *APP* UID 10213 ProcessRecord{abc 8111:dev.probe:sync/u0a213}\n  *APP* UID 10213 ProcessRecord{def 8123:dev.probe:ui/u0a213}\n",
      },
      [FOREGROUND]: PROBE_FRONT,
    });
    const { toon, data } = await both(
      ["app", "start", "dev.probe", "--activity", "dev.probe.MainActivity"],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(data.app).toMatchObject({ activity: ".MainActivity", pid: 8123 });
    expectClean(f);
  });

  it.each([
    ["No activity found\n", 0, "INVALID_OUTPUT"],
    ["ActivityInfo:\n name=dev.probe.Other\n packageName=dev.probe\n", 0, "INVALID_OUTPUT"],
    ["", 1, "REMOTE_EXIT"],
  ])(
    "does not guess a process when ActivityInfo is unavailable (%s)",
    async (stdout, exit, code) => {
      const f = device({
        [PACKAGE]: INSTALLED,
        [START]: AM_START.cold,
        [METADATA]: { stdout, exit },
      });
      const { toon, data } = await both(["app", "start", "dev.probe"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code,
        step: "reading the process of activity dev.probe/.MainActivity",
      });
      expect(data).not.toHaveProperty("app");
      expectClean(f);
    },
  );
});

describe("help for the shipped app lifecycle commands", () => {
  it("lists app start, stop and clear, and no unshipped command", async () => {
    const f = device({});
    const app = decode((await runCli(["app", "--help"], f.env)).stdout.trimEnd()) as {
      subcommands: { command: string }[];
    };
    const listed = app.subcommands.map((s) => s.command);
    expect(listed).toEqual(
      expect.arrayContaining(["adb-axi app start", "adb-axi app stop", "adb-axi app clear"]),
    );
    const unshipped = allCommands(REGISTRY)
      .filter((command) => !command.shipped)
      .map((command) => `adb-axi ${command.path.join(" ")}`);
    expect(listed.filter((command) => unshipped.includes(command))).toEqual([]);
    expect(f.calls()).toEqual([]);
  });

  it("describes the full-output escape for clear errors", async () => {
    const f = device({});
    const clear = await runCli(["app", "clear", "--help"], f.env);
    expect(clear.exitCode).toBe(0);
    expect(clear.stdout).toContain("--full");
    expect(f.calls()).toEqual([]);
  });

  it("describes app start's flags", async () => {
    const f = device({});
    const start = await runCli(["app", "start", "--help"], f.env);
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain("--fresh");
    expect(start.stdout).toContain("--activity <name>");
    expect(start.stdout).toContain("--timeout");
    expect(f.calls()).toEqual([]);
  });
});
