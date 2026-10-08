import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { runCli } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

import {
  lifecycleDevices,
  COMMAND_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  TIMING_MARGIN_MS,
  SERIAL,
  ONE_ONLINE,
  CURRENT_USER,
  KERNEL_UIDS,
  PROCESSES,
  PROCESS_RUNNING,
  PACKAGE,
  FOREGROUND,
  PIDOF,
  FORCE_STOP,
  CLEAR,
  DATA_FILES,
  startOf,
  START,
  metadataOf,
  METADATA,
  activityInfo,
  INSTALLED,
  INSTALLED_RELEASE,
  ABSENT,
  PROBE_FRONT,
  LAUNCHER_FRONT,
  PROBE_RUNNING,
  PROBE_STOPPED,
  AM_START,
  shell,
  both,
  withoutTime,
  twice,
  shellCommands,
  expectClean,
} from "../helpers/app-lifecycle.js";

// Parity cases run two CLI deadlines sequentially, plus process startup and cleanup.
vi.setConfig({ testTimeout: 40_000 });

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

const { device, deviceWithRules, liveDevice } = lifecycleDevices((value) => {
  fake = value;
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
    const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
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
    const { toon, json, data } = await both(
      ["app", "stop", "dev.probe", "--timeout", `${STOP_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(json.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe was still running at the 15 s deadline after am force-stop in `adb-axi app stop dev.probe`",
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
    const { toon, data } = await both(
      ["app", "clear", "dev.probe", "--timeout", `${STOP_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error:
        "dev.probe was still running at the 15 s deadline after pm clear in `adb-axi app clear dev.probe`",
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
  it.each([
    ["WAIT_TIMEOUT", { stdout: "Status: timeout\n" }, false],
    ["WAIT_TIMEOUT", { hang: true }, false],
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
          `${COMMAND_TIMEOUT_MS}ms`,
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
      if (code === "APP_DIED_ON_START") {
        expect(help).toContain(
          `Run \`adb-axi app start dev.probe/.Editor --fresh --device ${SERIAL}\` to try a cold start`,
        );
        expect(help).toContain(
          `Run \`adb-axi logs crash --pkg dev.probe --since 1m --device ${SERIAL}\` for the crash`,
        );
      }
      expectClean(f);
    },
  );
});

describe("launched activity process identity", () => {
  it.each([0, 10].flatMap((userId) => [true, false].map((alive) => ({ userId, alive }))))(
    "does not adopt am's permission-controller activity, user=$userId, alive=$alive",
    async ({ userId, alive }) => {
      const controller = "com.google.android.permissioncontroller";
      const permissionActivity =
        "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity";
      const component = `${controller}/${permissionActivity}`;
      const foreignMetadata = `cmd package resolve-activity --user ${userId} -n '${component}'`;
      const foreignProcesses = `dumpsys activity processes ${controller}`;
      const otherUser = userId === 0 ? 10 : 0;
      const f = device({
        [CURRENT_USER]: { stdout: `${userId}\n` },
        [PACKAGE]: {
          stdout:
            "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
        },
        [startOf(".UiActivity").replace("--user 0", `--user ${userId}`)]: {
          stdout: `Starting: Intent { cmp=dev.probe/.UiActivity }\nWarning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\nLaunchState: UNKNOWN (0)\nActivity: ${component}\nTotalTime: 0\nWaitTime: 5\nComplete\n`,
        },
        [metadataOf(".UiActivity", userId)]: activityInfo(".UiActivity", "dev.probe:ui"),
        [PROCESSES]: {
          stdout: [
            `  *APP* UID ${userId * 100000 + 10213} ProcessRecord{abc 8111:dev.probe:sync/u${userId}a213}`,
            `  *APP* UID ${otherUser * 100000 + 10213} ProcessRecord{def 9001:dev.probe:ui/u${otherUser}a213}`,
            ...(alive
              ? [
                  `  *APP* UID ${userId * 100000 + 10213} ProcessRecord{fed 19758:dev.probe:ui/u${userId}a213}`,
                ]
              : []),
            "",
          ].join("\n"),
        },
        [FOREGROUND]: {
          stdout: `  ResumedActivity: ActivityRecord{abc u${userId} ${component} t43}\n`,
        },
        [foreignMetadata]: {
          stdout: `ActivityInfo:\n name=${permissionActivity}\n packageName=${controller}\n processName=${controller}\n ApplicationInfo:\n`,
        },
        [foreignProcesses]: {
          stdout: `  *APP* UID ${userId * 100000 + 10250} ProcessRecord{abc 19312:${controller}/u${userId}a250}\n`,
        },
      });
      const { toon, data } = await both(["app", "start", "dev.probe/.UiActivity"], f);
      expect(toon.exitCode).toBe(alive ? 0 : 1);
      if (alive) {
        expect(data).toEqual({
          ok: `start dev.probe -> running, ${controller} in front`,
          app: { activity: ".UiActivity", pid: 19758, launch: "unknown", recreated: false },
          help: ["Run `adb-axi app current` to see what is in front"],
        });
      } else {
        expect(data).toMatchObject({
          code: "APP_DIED_ON_START",
          error: "the dev.probe:ui process of dev.probe/.UiActivity is gone right after its start",
          last: { state: "stopped", pid: "-", foreground: controller },
        });
        expect(data).not.toHaveProperty("app");
      }
      const calls = shellCommands(f);
      expect(calls).toContain(metadataOf(".UiActivity", userId));
      expect(calls).toContain(PROCESSES);
      expect(calls).not.toContain(foreignMetadata);
      expect(calls).not.toContain(foreignProcesses);
      expectClean(f);
    },
    10000,
  );

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

  it.each(
    [0, 10].flatMap((userId) =>
      ["dev.probe", "dev.probe:ui"].map((process) => ({ userId, process })),
    ),
  )(
    "reports a singleTop alias started twice as foreground without settling, user=$userId, process=$process",
    async ({ userId, process }) => {
      const aliasStart = startOf(".IconAlias").replace("--user 0", `--user ${userId}`);
      const aliasMetadata = metadataOf(".IconAlias", userId);
      const targetMetadata = metadataOf(".MainActivity", userId);
      const other = userId === 0 ? 10 : 0;
      const f = deviceWithRules([
        { match: shell(CURRENT_USER), respond: { stdout: `${userId}\n` } },
        {
          match: shell(PACKAGE),
          respond: {
            stdout:
              "Packages:\n  Package [dev.probe] (abc):\n    appId=10213\n    User 0: installed=true hidden=false\n    User 10: installed=true hidden=false\n",
          },
        },
        {
          match: shell(aliasStart),
          times: 1,
          respond: {
            stdout:
              "Starting: Intent { cmp=dev.probe/.IconAlias }\nStatus: ok\nActivity: dev.probe/.IconAlias\nTotalTime: 40\nWaitTime: 40\nComplete\n",
          },
          then: {
            stdout:
              "Starting: Intent { cmp=dev.probe/.IconAlias }\nWarning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\nLaunchState: UNKNOWN (0)\nActivity: dev.probe/.MainActivity\nTotalTime: 0\nWaitTime: 5\nComplete\n",
          },
        },
        { match: shell(aliasMetadata), respond: activityInfo(".IconAlias", process) },
        { match: shell(targetMetadata), respond: activityInfo(".MainActivity", process) },
        {
          match: shell(PROCESSES),
          respond: {
            stdout: `  *APP* UID ${userId * 100000 + 10213} ProcessRecord{abc 8111:dev.probe:sync/u${userId}a213}\n  *APP* UID ${other * 100000 + 10213} ProcessRecord{def 9001:${process}/u${other}a213}\n  *APP* UID ${userId * 100000 + 10213} ProcessRecord{fed 8123:${process}/u${userId}a213}\n`,
          },
        },
        {
          match: shell(FOREGROUND),
          respond: {
            stdout: `  ResumedActivity: ActivityRecord{abc u${other} dev.probe/.MainActivity t2}\n  ResumedActivity: ActivityRecord{def u${userId} dev.probe/.IconAlias t8}\n`,
          },
        },
      ]);
      const args = ["app", "start", "dev.probe/.IconAlias"];
      const first = await runCli(args, f.env);
      expect(first.exitCode).toBe(0);
      expect(decode(first.stdout.trimEnd())).toEqual({
        ok: "start dev.probe -> foreground (started)",
        app: {
          activity: ".IconAlias",
          pid: 8123,
          launch: "unknown",
          recreated: true,
          took_ms: 40,
        },
      });
      const { toon, data } = await both(args, f);
      expect(toon.exitCode).toBe(0);
      expect(data).toEqual({
        ok: "start dev.probe -> foreground (already on top, intent delivered to it)",
        app: { activity: ".IconAlias", pid: 8123, launch: "unknown", recreated: false },
        help: [
          "Run `adb-axi app start dev.probe/.IconAlias --fresh` to kill the process and cold-start",
        ],
      });
      expect(shellCommands(f)).toEqual([
        CURRENT_USER,
        PACKAGE,
        aliasStart,
        aliasMetadata,
        PROCESSES,
        FOREGROUND,
        ...twice([CURRENT_USER, PACKAGE, aliasStart, targetMetadata, PROCESSES, FOREGROUND]),
      ]);
      expectClean(f);
    },
  );

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
