import { LAUNCH_CRASH_COMMAND } from "../../src/android/launch-crash.js";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

import {
  lifecycleDevices,
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
  START,
  metadataOf,
  METADATA,
  activityInfo,
  INSTALLED,
  LAUNCHER_FRONT,
  PROBE_RUNNING,
  PROBE_STOPPED,
  AM_START,
  shell,
  both,
  withoutTime,
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

describe("app start", () => {
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
    expect(
      shellCommands(f)
        .filter((command) => command !== LAUNCH_CRASH_COMMAND)
        .at(-1),
    ).toBe(START);
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
});

describe("lifecycle review regressions", () => {
  it.each([["android/com.android.internal.app.ResolverActivity\n", "INVALID_OUTPUT"]])(
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

  it.each([1])("rejects remaining files even when find exits %s", async (exit) => {
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

  it.each([true])("offers full remaining-file output, full=%s", async (full) => {
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

  it.each(["start", "clear"])(
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
            {
              match: shell(LAUNCH_CRASH_COMMAND),
              respond: { stdoutFile: "captured/29/launch-events-running.txt" },
            },
            {
              match: shell("pm path --user 10 dev.probe"),
              respond: { stdout: "package:/data/app/probe/base.apk\n" },
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
          expect(shellCommands(fake)).toContain(clear);
        }
        expectClean(fake);
        fake.cleanup();
      }
    },
  );

  it.each(["start"])("does not %s a package installed only for another user", async (command) => {
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
    expect(shellCommands(f).some((command) => command.startsWith("am start"))).toBe(false);
    expectClean(f);
  });

  it.each([10])(
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

  it.each([[RESOLVE, "unexpected\n", "resolving the launcher activity of dev.probe"]])(
    "rejects unreadable output from %s without mutating",
    async (command, stdout, step) => {
      const f = device({ [PACKAGE]: INSTALLED, [command]: { stdout } });
      const { toon, data } = await both(["app", "start", "dev.probe", "--fresh"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INVALID_OUTPUT", step });
      expect(shellCommands(f)).not.toContain(FORCE_STOP);
      expect(shellCommands(f)).not.toContain(START);
      expectClean(f);
    },
  );

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
    [PROCESSES].flatMap((command) => [SHORT_TIMEOUT_MS].map((timeout) => ({ command, timeout }))),
  )(
    "fails when $command expires before any complete observation with timeout=$timeout",
    async ({ command, timeout }) => {
      const f = deviceWithRules([
        { match: shell(PACKAGE), respond: INSTALLED, set: { launched: "no" } },
        {
          match: shell(START),
          respond: {
            ...AM_START.cold,
            ...(timeout === SHORT_TIMEOUT_MS ? { delayMs: SHORT_START_DELAY_MS } : {}),
          },
          set: { launched: "yes" },
        },
        { match: shell(command), when: { launched: "yes" }, respond: { hang: true } },
        { match: shell(METADATA), respond: activityInfo(".MainActivity", "dev.probe:ui") },
        { match: shell(PROCESSES), respond: ui },
        { match: shell(FOREGROUND), respond: permission },
      ]);
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
