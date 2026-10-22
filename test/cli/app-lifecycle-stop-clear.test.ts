import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeAdb } from "../fake-adb/harness.js";

import {
  lifecycleDevices,
  COMMAND_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  TIMING_MARGIN_MS,
  SERIAL,
  CURRENT_USER,
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
  PROBE_FRONT,
  LAUNCHER_FRONT,
  PROBE_RUNNING,
  PROBE_STOPPED,
  AM_START,
  both,
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

const { device } = lifecycleDevices((value) => {
  fake = value;
});

describe("app stop", () => {
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

  it("rejects a package name that is not one with exit 2, before any shell call", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "stop", "dev.probe; reboot"], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });
});

describe("app clear", () => {
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
    expectClean(f);
  });

  it("fails with REMOTE_EXIT, never a cleared claim, when the package manager refuses", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [CLEAR]: { stdout: "Failed\n", exit: 1 } });
    const { toon, data } = await both(["app", "clear", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "clearing the data of dev.probe" });
    expect(shellCommands(f)).not.toContain(PIDOF);
  });
});

describe("lifecycle review regressions", () => {
  it.each([
    ["STOP_FAILED", AM_START.cold, true],
    ["APP_DIED_ON_START", AM_START.cold, false],
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
      if (code === "STOP_FAILED")
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
  it.each(
    [0].flatMap((userId) =>
      [false].flatMap((fresh) => ["dev.probe"].map((process) => ({ userId, fresh, process }))),
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

  it.each([false])("reports the live UI process in user 10, fresh=%s", async (fresh) => {
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

  it.each([["No activity found\n", 0, "INVALID_OUTPUT"]])(
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
