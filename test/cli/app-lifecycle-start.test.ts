import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

import {
  lifecycleDevices,
  COMMAND_TIMEOUT_MS,
  SHORT_TIMEOUT_MS,
  SHORT_START_DELAY_MS,
  STOP_TIMEOUT_MS,
  TIMING_MARGIN_MS,
  SERIAL,
  ONE_ONLINE,
  CURRENT_USER,
  RESOLVE,
  KERNEL_UIDS,
  PROCESSES,
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

const { device, liveDevice } = lifecycleDevices((value) => {
  fake = value;
});

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
    const { toon, json, data } = await both(
      ["app", "start", "dev.probe", "--fresh", "--timeout", `${STOP_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(json.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe was still running at the 15 s deadline after am force-stop in `adb-axi app start dev.probe --fresh`",
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
      ["app", "start", "dev.probe/.MainActivity", "--fresh", "--timeout", `${STOP_TIMEOUT_MS}ms`],
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
        "help[2]: Run `adb-axi app list --grep missing` to find the package,Run `adb-axi app install <apk>` to install it",
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
        "help[2]: Run `adb-axi app current` to see what is in front (on a physical phone a system dialog such as Play Protect or a permission request can block the launch),Run `adb-axi app start dev.probe --timeout 30s` to give it longer",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT" });
    // The timed-out start is never read as a launched app.
    expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE, RESOLVE, START]));
  });

  it("fails with WAIT_TIMEOUT when am start does not answer within --timeout", async () => {
    const f = device({ [PACKAGE]: INSTALLED, [START]: { hang: true } });
    const { toon, json, data } = await both(
      ["app", "start", "dev.probe", "--timeout", `${STOP_TIMEOUT_MS}ms`],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(toon.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(json.durationMs).toBeLessThan(STOP_TIMEOUT_MS + TIMING_MARGIN_MS);
    expect(data).toMatchObject({
      code: "WAIT_TIMEOUT",
      error: "dev.probe did not finish launching within 15 s",
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
        "help[2]: Run `adb-axi logs crash --pkg dev.probe --since 1m` for the crash,Run `adb-axi app start dev.probe --fresh` to try a cold start",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "APP_DIED_ON_START" });
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
    ["app", "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.MainActivity t8}\n", "foreground"],
    [
      "app with full class name",
      "  ResumedActivity: ActivityRecord{abc u0 dev.probe/dev.probe.MainActivity t8}\n",
      "foreground",
    ],
    [
      "another activity of the same app",
      "  ResumedActivity: ActivityRecord{abc u0 dev.probe/.OtherActivity t8}\n",
      "foreground",
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
          : front.includes("dev.probe/.OtherActivity")
            ? ".OtherActivity"
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
    "scopes %s data and observations to current user 10, allowing Android's clear process stop",
    async (command) => {
      let previous: Record<string, unknown> | undefined;
      for (const json of [false, true]) {
        const stop = "am force-stop --user 10 dev.probe";
        const clear = "pm clear --user 10 dev.probe";
        const start = "am start --user 10 -W -n 'dev.probe/.MainActivity'";
        const resolve = RESOLVE.replace("--user 0", "--user 10");
        const files = DATA_FILES.replace("--user 0", "--user 10");
        fake = createFakeAdb({
          description: "Current-user data scope with Android's cross-user process stop on clear",
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
              set: { current: "stopped", currentData: "empty", other: "stopped" },
            },
            { match: shell(start), respond: AM_START.cold, set: { current: "running" } },
            { match: shell(files), when: { currentData: "empty" }, respond: {} },
            {
              match: shell(PIDOF),
              when: { current: "stopped", other: "stopped" },
              respond: PROBE_STOPPED,
            },
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
        const data = (
          json ? sharedWithToon(JSON.parse(result.stdout)) : decode(result.stdout.trimEnd())
        ) as Record<string, unknown>;
        if (previous !== undefined) expect(withoutTime(data)).toEqual(withoutTime(previous));
        previous = data;
        expect(fake.vars()).toMatchObject({
          other: command === "clear" ? "stopped" : "running",
          otherData: "present",
          current: command === "start" ? "running" : "stopped",
          currentData: command === "clear" ? "empty" : "present",
        });
        if (command === "start")
          expect(data.app).toMatchObject({ pid: 8235, activity: ".MainActivity" });
        if (command === "stop") expect(data.ok).toMatch(/pid 8235 gone/);
        if (command === "clear") {
          expect(data.confirmed_by).toEqual(["pm clear", "run-as"]);
          expect(shellCommands(fake)).toEqual([CURRENT_USER, PACKAGE, clear, PIDOF, files]);
        }
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
        help: [
          `Run \`adb-axi app list --grep probe --device ${SERIAL}\` to find the package`,
          `Run \`adb-axi app install <apk> --device ${SERIAL}\` to install it`,
        ],
      });
      expect(shellCommands(f)).toEqual(twice([CURRENT_USER, PACKAGE]));
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

// Keep the initial-observation matrix separate from the retained-observation matrix
// so their real deadlines do not accumulate in one file.
describe("app start settle deadlines", () => {
  const ui: Response = {
    stdout: "  *APP* UID 10213 ProcessRecord{abc 8123:dev.probe:ui/u0a213}\n",
  };
  const permission: Response = {
    stdout:
      "  ResumedActivity: ActivityRecord{abc u0 com.android.permissioncontroller/.Grant t8}\n",
  };

  it.each(
    [PROCESSES, FOREGROUND].flatMap((command) =>
      [SHORT_TIMEOUT_MS, COMMAND_TIMEOUT_MS].map((timeout) => ({ command, timeout })),
    ),
  )(
    "fails when $command expires before any complete observation with timeout=$timeout",
    async ({ command, timeout }) => {
      const f = device({
        [PACKAGE]: INSTALLED,
        [START]: {
          ...AM_START.cold,
          ...(timeout === SHORT_TIMEOUT_MS ? { delayMs: SHORT_START_DELAY_MS } : {}),
        },
        [METADATA]: activityInfo(".MainActivity", "dev.probe:ui"),
        [PROCESSES]: ui,
        [FOREGROUND]: permission,
        [command]: { hang: true },
      });
      const { toon, json, data } = await both(
        ["app", "start", "dev.probe/.MainActivity", "--timeout", `${timeout}ms`],
        f,
      );
      expect(toon.exitCode).toBe(1);
      const durationLimit =
        timeout === SHORT_TIMEOUT_MS ? timeout + TIMING_MARGIN_MS : timeout - TIMING_MARGIN_MS;
      expect(toon.durationMs).toBeLessThan(durationLimit);
      expect(json.durationMs).toBeLessThan(durationLimit);
      expect(data).toMatchObject({
        code: "TIMEOUT",
        step:
          command === PROCESSES
            ? "reading the processes of dev.probe"
            : "reading the foreground activity",
      });
      expect(data).not.toHaveProperty("app");
      expect(data).not.toHaveProperty("ok");
      expect(
        f.calls().filter((call) => call.argv[3] === command && call.end === null),
      ).toHaveLength(2);
      expectClean(f);
    },
  );
});
