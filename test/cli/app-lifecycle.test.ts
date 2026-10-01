import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const PACKAGE = "dumpsys package dev.probe";
const FOREGROUND = "dumpsys activity activities";
const PIDOF = "pidof dev.probe";
const FORCE_STOP = "am force-stop dev.probe";
const CLEAR = "pm clear dev.probe";
const DATA_FILES = "run-as dev.probe find . -type f";
const startOf = (activity: string): string => `am start -W -n 'dev.probe/${activity}'`;
const START = startOf(".MainActivity");

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
    rules: [{ match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } }, ...rules],
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
  expect(toon.exitCode).toBe(json.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  // The two runs take different times; every other field must match exactly.
  expect(withoutTime(decoded)).toEqual(withoutTime(data));
  return { toon, json, data };
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, START, PIDOF, FOREGROUND]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, FORCE_STOP, PIDOF, START, PIDOF, FOREGROUND]));
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
      ["app", "start", "dev.probe/.MainActivity", "--activity", ".MainActivity"],
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
  });

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
    expect(shellCommands(f)).toEqual(twice(["dumpsys package dev.probe.missing"]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, START]));
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
      [PIDOF]: PROBE_STOPPED,
      [FOREGROUND]: LAUNCHER_FRONT,
    });
    const { toon, data } = await both(["app", "start", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe has no process right after its start",
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

  it("rejects a bad package, a bad activity and two different activities with exit 2, before any device call", async () => {
    const f = device({});
    for (const args of [
      ["app", "start", "dev.probe; reboot"],
      ["app", "start", "dev.probe/.Main; reboot"],
      ["app", "start", "dev.probe", "--activity", "'.Main'"],
      ["app", "start", "dev.probe/.MainActivity", "--activity", ".OtherActivity"],
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
    expect(shellCommands(f)).toEqual([PACKAGE, PIDOF, FORCE_STOP, PIDOF]);
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
    expect(shellCommands(f)).toEqual([PACKAGE, PIDOF, FORCE_STOP]);
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
    expect(shellCommands(f)).toEqual(twice(["dumpsys package dev.probe.missing"]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, CLEAR, PIDOF, DATA_FILES]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, CLEAR, PIDOF]));
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
    expect(shellCommands(f)).toEqual(twice([PACKAGE, CLEAR, PIDOF, DATA_FILES]));
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
    expect(shellCommands(f)).toEqual(twice(["dumpsys package dev.probe.missing"]));
  });
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
