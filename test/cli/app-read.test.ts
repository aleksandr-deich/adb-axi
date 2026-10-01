import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const FOREGROUND = "dumpsys activity activities";
const PIDOF = "pidof dev.probe";
const PACKAGES_ALL = "pm list packages --show-versioncode -U";
const PACKAGES_USER = "pm list packages --show-versioncode -U -3";
const PACKAGE_DUMP = "dumpsys package packages";

const PROBE_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt" };
const LAUNCHER_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-launcher-front.txt" };
const PROBE_RUNNING = { stdoutFile: "captured/35/pidof-running.txt" };
const PROBE_STOPPED = { stdoutFile: "captured/35/pidof-not-running.txt", exit: 1 };

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** One online emulator whose shell answers the given commands; anything else is unmatched. */
function device(answers: Record<string, Response>): FakeAdb {
  return deviceWithRules(
    Object.entries(answers).map(([command, respond]) => ({
      match: ["-s", SERIAL, "shell", command],
      respond,
    })),
  );
}

function deviceWithRules(rules: Rule[]): FakeAdb {
  fake = createFakeAdb({
    description: "One online emulator answering the app read commands",
    synthetic: true,
    rules: [{ match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } }, ...rules],
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
  // Two runs wait for different times; every other field must match exactly.
  expect(withoutWaitTime(decoded)).toEqual(withoutWaitTime(data));
  return { toon, json, data };
}

function withoutWaitTime(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.waited_ms !== "number") return data;
  return {
    ...data,
    ok: String(data.ok).replace(/ after \d+ ms$/, " after <n> ms"),
    waited_ms: "<n>",
  };
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

/** A package record as the `Packages:` section of `dumpsys package` prints it. */
function record(
  name: string,
  options: { versionName?: string; versionCode?: number; debuggable?: boolean } = {},
): string {
  return [
    `  Package [${name}] (4f2a9c1):`,
    "    appId=10123",
    ...(options.versionCode === undefined
      ? []
      : [`    versionCode=${options.versionCode} minSdk=29`]),
    `    versionName=${options.versionName ?? "null"}`,
    `    flags=[ ${options.debuggable === true ? "DEBUGGABLE " : ""}HAS_CODE ]`,
    "    User 0: ceDataInode=1 installed=true hidden=false stopped=false",
    "",
  ].join("\n");
}

const DEVICE_PACKAGES = {
  user: [
    "package:com.example.notes versionCode:57 uid:10124",
    "package:com.example.notes.test uid:10125",
    "package:com.example.tracker versionCode:9 uid:10126",
  ],
  system: [
    "package:android versionCode:35 uid:1000",
    "package:com.android.settings versionCode:35 uid:1000",
    "package:com.google.android.apps.nexuslauncher versionCode:2 uid:10080",
  ],
  dump:
    "Packages:\n" +
    [
      record("com.example.notes", { versionName: "1.4.0", versionCode: 57, debuggable: true }),
      record("com.example.notes.test", { debuggable: true }),
      record("com.example.tracker", { versionName: "2.0.1", versionCode: 9 }),
      record("android", { versionName: "15", versionCode: 35 }),
      record("com.android.settings", { versionName: "15", versionCode: 35 }),
      record("com.google.android.apps.nexuslauncher", { versionName: "2.0", versionCode: 2 }),
    ].join(""),
};

function packageDevice(options: { user?: string[]; system?: string[] } = {}): FakeAdb {
  const user = options.user ?? DEVICE_PACKAGES.user;
  const system = options.system ?? DEVICE_PACKAGES.system;
  return device({
    [PACKAGES_ALL]: { stdout: [...system, ...user].join("\n") + "\n" },
    [PACKAGES_USER]: { stdout: user.length === 0 ? "" : user.join("\n") + "\n" },
    [PACKAGE_DUMP]: { stdout: DEVICE_PACKAGES.dump },
  });
}

describe("app current", () => {
  it("reports the app in front with its activity and pid", async () => {
    const f = device({ [FOREGROUND]: PROBE_FRONT, [PIDOF]: PROBE_RUNNING });
    const { toon, data } = await both(["app", "current"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      "app:\n  package: dev.probe\n  activity: .MainActivity\n  pid: 8235\n",
    );
    expect(data).toEqual({ app: { package: "dev.probe", activity: ".MainActivity", pid: 8235 } });
    expectClean(f);
  });

  it("reports a launcher in front as the launcher package", async () => {
    const f = device({
      [FOREGROUND]: LAUNCHER_FRONT,
      "pidof com.google.android.apps.nexuslauncher": { stdout: "1456\n" },
    });
    const { toon, data } = await both(["app", "current"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      app: {
        package: "com.google.android.apps.nexuslauncher",
        activity: ".NexusLauncherActivity",
        pid: 1456,
      },
    });
    expectClean(f);
  });

  it("says so, with exit 0, when nothing is resumed", async () => {
    const f = device({
      [FOREGROUND]: { stdoutFile: "synthetic/30/dumpsys-activity-activities-asleep.txt" },
    });
    const { toon, data } = await both(["app", "current"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      app: { package: "-", activity: "-", pid: "-" },
      note: "no activity is resumed, the screen may be off",
    });
    expect(shellCommands(f)).toEqual(twice([FOREGROUND]));
  });

  it("prints a dash for the pid when the process is not found by name", async () => {
    const f = device({ [FOREGROUND]: PROBE_FRONT, [PIDOF]: PROBE_STOPPED });
    const { data } = await both(["app", "current"], f);
    expect(data).toEqual({ app: { package: "dev.probe", activity: ".MainActivity", pid: "-" } });
  });

  it("fails with REMOTE_EXIT when the activity dump fails, never an empty answer", async () => {
    const f = device({ [FOREGROUND]: { stderr: "Can't find service: activity\n", exit: 20 } });
    const { toon, data } = await both(["app", "current"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "REMOTE_EXIT",
      step: "reading the foreground activity",
      exit: 20,
      stderr: "Can't find service: activity",
    });
  });

  it("fails with TIMEOUT when the device does not answer within --timeout", async () => {
    const f = device({ [FOREGROUND]: { ...PROBE_FRONT, delayMs: 5000 } });
    const { toon, data } = await both(["app", "current", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "TIMEOUT", step: "reading the foreground activity" });
  });

  it("fails with DEVICE_AMBIGUOUS when two devices are online and none is selected", async () => {
    fake = createFakeAdb("multi-device.json");
    const { toon, data } = await both(["app", "current"], fake);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "DEVICE_AMBIGUOUS" });
  });
});

describe("app list", () => {
  it("lists user packages with the count and the total including system packages", async () => {
    const f = packageDevice();
    const { toon, data } = await both(["app", "list"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        'count: "3 user packages (6 with system, use --all)"',
        "packages[3]{package,version,debuggable}:",
        "  com.example.notes,1.4.0 (57),true",
        '  com.example.notes.test,"-",true',
        "  com.example.tracker,2.0.1 (9),false",
        'help[1]: "Run `adb-axi app info com.example.notes` for its pid, foreground state and data size"',
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ count: "3 user packages (6 with system, use --all)" });
    expect(shellCommands(f)).toEqual(twice([PACKAGES_ALL, PACKAGES_USER, PACKAGE_DUMP]));
    expectClean(f);
  });

  it("includes system packages with --all", async () => {
    const f = packageDevice();
    const { toon, data } = await both(["app", "list", "--all"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({ count: "6 packages (3 user)" });
    expect((data.packages as { package: string }[]).map((p) => p.package)).toEqual([
      "android",
      "com.android.settings",
      "com.example.notes",
      "com.example.notes.test",
      "com.example.tracker",
      "com.google.android.apps.nexuslauncher",
    ]);
    expect(toon.stdout).toContain("  android,15 (35),false\n");
    expectClean(f);
  });

  it("states 0 user packages correctly while counting the system ones", async () => {
    const f = packageDevice({ user: [] });
    const { toon, data } = await both(["app", "list"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe('count: "0 user packages (3 with system, use --all)"\npackages: []\n');
    expect(data).toEqual({ count: "0 user packages (3 with system, use --all)", packages: [] });
    // Nothing to describe, so the package dump is never read.
    expect(shellCommands(f)).toEqual(twice([PACKAGES_ALL, PACKAGES_USER]));
  });

  it("filters names with --grep and counts the matches on both sides", async () => {
    const f = packageDevice();
    const { toon, data } = await both(["app", "list", "--grep", "tracker"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.count).toBe("1 user package (1 with system, use --all)");
    expect(data.packages).toEqual([
      { package: "com.example.tracker", version: "2.0.1 (9)", debuggable: false },
    ]);

    const system = await both(["app", "list", "--grep", "^android$", "--all"], f);
    expect(system.data.count).toBe("1 package (0 user)");

    const none = await both(["app", "list", "--grep", "nothing-matches"], f);
    expect(none.data).toEqual({
      count: "0 user packages (0 with system, use --all)",
      packages: [],
    });
    expectClean(f);
  });

  it("falls back to the listed version code when the dump has no record", async () => {
    const f = device({
      [PACKAGES_ALL]: { stdout: "package:com.example.notes versionCode:57 uid:10124\n" },
      [PACKAGES_USER]: { stdout: "package:com.example.notes versionCode:57 uid:10124\n" },
      [PACKAGE_DUMP]: { stdout: "Packages:\n" },
    });
    const { data } = await both(["app", "list"], f);
    expect(data.packages).toEqual([
      { package: "com.example.notes", version: "- (57)", debuggable: "-" },
    ]);
  });

  it("rejects a regex that does not compile with exit 2, before touching the device", async () => {
    const f = packageDevice();
    const { toon, data } = await both(["app", "list", "--grep", "("], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR", error: "`(` is not a valid regex" });
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails with REMOTE_EXIT when the package manager fails", async () => {
    const f = device({
      [PACKAGES_ALL]: { stderr: "cmd: Can't find service: package\n", exit: 20 },
    });
    const { toon, data } = await both(["app", "list"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "listing packages", exit: 20 });
  });

  it("fails with TIMEOUT when the device does not answer within --timeout", async () => {
    const f = device({ [PACKAGES_ALL]: { stdout: "", delayMs: 5000 } });
    const { toon, data } = await both(["app", "list", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "TIMEOUT", step: "listing packages" });
  });
});

describe("app info", () => {
  const DEBUG_DUMP = { stdoutFile: "captured/35/dumpsys-package-debug.txt" };
  const RELEASE_DUMP = { stdoutFile: "captured/35/dumpsys-package-release.txt" };
  const DU = "run-as dev.probe du -sk .";

  it("reports a running, foreground, debuggable app with its data size", async () => {
    const f = device({
      "dumpsys package dev.probe": DEBUG_DUMP,
      [PIDOF]: PROBE_RUNNING,
      [FOREGROUND]: PROBE_FRONT,
      [DU]: { stdout: "56\t.\n" },
    });
    const { toon, data } = await both(["app", "info", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      [
        "app:",
        "  package: dev.probe",
        "  installed: true",
        "  version: 1.0 (1)",
        "  debuggable: true",
        "  pid: 8235",
        "  foreground: true",
        "  data_size: 56 KB",
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      app: {
        package: "dev.probe",
        installed: true,
        version: "1.0 (1)",
        debuggable: true,
        pid: 8235,
        foreground: true,
        data_size: "56 KB",
      },
    });
    expectClean(f);
  });

  it("reports a stopped release app behind the launcher, with the data size unknown", async () => {
    const f = device({
      "dumpsys package dev.probe": RELEASE_DUMP,
      [PIDOF]: PROBE_STOPPED,
      [FOREGROUND]: LAUNCHER_FRONT,
    });
    const { toon, data } = await both(["app", "info", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({
      app: {
        package: "dev.probe",
        installed: true,
        version: "1.0 (1)",
        debuggable: false,
        pid: "-",
        foreground: false,
        data_size: "-",
      },
    });
    // run-as would be refused on a release build, so it is never tried.
    expect(shellCommands(f)).not.toContain(DU);
    expectClean(f);
  });

  it("prints megabytes for a large data directory", async () => {
    const f = device({
      "dumpsys package dev.probe": DEBUG_DUMP,
      [PIDOF]: PROBE_RUNNING,
      [FOREGROUND]: PROBE_FRONT,
      [DU]: { stdout: "5120\t.\n" },
    });
    const { data } = await both(["app", "info", "dev.probe"], f);
    expect(data.app).toMatchObject({ data_size: "5.0 MB" });
  });

  it("keeps an unknown data size when run-as is refused", async () => {
    const f = device({
      "dumpsys package dev.probe": DEBUG_DUMP,
      [PIDOF]: PROBE_RUNNING,
      [FOREGROUND]: PROBE_FRONT,
      [DU]: { stderr: "run-as: package not debuggable: dev.probe\n", exit: 1 },
    });
    const { toon, data } = await both(["app", "info", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.app).toMatchObject({ installed: true, debuggable: true, data_size: "-" });
  });

  it("answers installed: false with exit 0 for a package that is not installed", async () => {
    const f = device({
      "dumpsys package dev.probe.missing": { stdoutFile: "captured/35/dumpsys-package-absent.txt" },
    });
    const { toon, data } = await both(["app", "info", "dev.probe.missing"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe("app:\n  package: dev.probe.missing\n  installed: false\n");
    expect(data).toEqual({ app: { package: "dev.probe.missing", installed: false } });
    expect(shellCommands(f)).toEqual(twice(["dumpsys package dev.probe.missing"]));
  });

  it("answers installed: false for a package uninstalled with its data kept", async () => {
    const f = device({
      "dumpsys package dev.probe": { stdoutFile: "synthetic/30/dumpsys-package-kept-data.txt" },
    });
    const { toon, data } = await both(["app", "info", "dev.probe"], f);
    expect(toon.exitCode).toBe(0);
    expect(data).toEqual({ app: { package: "dev.probe", installed: false } });
  });

  it("rejects a package name that is not one with exit 2, before any shell call", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "info", "dev.probe; reboot"], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });

  it("requires the package argument", async () => {
    const f = device({});
    const { toon, data } = await both(["app", "info"], f);
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails with REMOTE_EXIT when the package dump fails", async () => {
    const f = device({
      "dumpsys package dev.probe": { stderr: "Can't find service: package\n", exit: 20 },
    });
    const { toon, data } = await both(["app", "info", "dev.probe"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", step: "reading package dev.probe" });
  });

  it("fails with TIMEOUT when the device does not answer within --timeout", async () => {
    const f = device({ "dumpsys package dev.probe": { ...DEBUG_DUMP, delayMs: 5000 } });
    const { toon, data } = await both(["app", "info", "dev.probe", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "TIMEOUT", step: "reading package dev.probe" });
  });
});

describe("wait app", () => {
  /**
   * One run of a wait whose answers change with each call: a second run would start from
   * the changed state, so these are checked in TOON only (parity is covered elsewhere).
   */
  async function once(args: string[], f: FakeAdb): Promise<Both> {
    const toon = await runCli(args, f.env);
    const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    return { toon, json: toon, data };
  }

  /** The wait line and its `waited_ms` agree. */
  function expectWaited(result: Both, pkg: string, state: string): number {
    const waited = result.data.waited_ms;
    expect(typeof waited).toBe("number");
    expect(result.data).toEqual({
      ok: `wait app ${pkg} -> ${state} after ${String(waited)} ms`,
      waited_ms: waited,
    });
    return waited as number;
  }

  it("returns at once, with waited_ms, when the app is already in front", async () => {
    const f = device({ [FOREGROUND]: PROBE_FRONT, [PIDOF]: PROBE_RUNNING });
    const result = await both(["wait", "app", "dev.probe", "--state", "foreground"], f);
    expect(result.toon.exitCode).toBe(0);
    expect(result.toon.stdout).toMatch(
      /^ok: wait app dev\.probe -> foreground after \d+ ms\nwaited_ms: \d+\n$/,
    );
    expectWaited(result, "dev.probe", "foreground");
    expectClean(f);
  });

  it("polls until the app comes to the foreground", async () => {
    const f = deviceWithRules([
      {
        match: ["-s", SERIAL, "shell", FOREGROUND],
        respond: LAUNCHER_FRONT,
        times: 2,
        then: PROBE_FRONT,
      },
      { match: ["-s", SERIAL, "shell", PIDOF], respond: PROBE_RUNNING },
    ]);
    const result = await once(["wait", "app", "dev.probe", "--state", "foreground"], f);
    expect(result.toon.exitCode).toBe(0);
    // Two polls saw the launcher, so the third came two poll intervals in.
    expect(expectWaited(result, "dev.probe", "foreground")).toBeGreaterThanOrEqual(500);
    const reads = shellCommands(f).filter((command) => command === FOREGROUND);
    expect(reads).toHaveLength(3);
    expectClean(f);
  });

  it("waits for a running app without reading the foreground", async () => {
    const f = deviceWithRules([
      {
        match: ["-s", SERIAL, "shell", PIDOF],
        respond: PROBE_STOPPED,
        times: 1,
        then: PROBE_RUNNING,
      },
    ]);
    const result = await once(["wait", "app", "dev.probe", "--state", "running"], f);
    expect(result.toon.exitCode).toBe(0);
    expect(expectWaited(result, "dev.probe", "running")).toBeGreaterThanOrEqual(250);
    expect(shellCommands(f)).not.toContain(FOREGROUND);
    expectClean(f);
  });

  it("waits for a stopped app", async () => {
    const f = deviceWithRules([
      {
        match: ["-s", SERIAL, "shell", PIDOF],
        respond: PROBE_RUNNING,
        times: 1,
        then: PROBE_STOPPED,
      },
    ]);
    const result = await once(["wait", "app", "dev.probe", "--state", "stopped"], f);
    expect(result.toon.exitCode).toBe(0);
    expect(expectWaited(result, "dev.probe", "stopped")).toBeGreaterThanOrEqual(250);
    expectClean(f);
  });

  it("succeeds at once for a stopped app that is already stopped", async () => {
    const f = device({ [PIDOF]: PROBE_STOPPED });
    const result = await both(["wait", "app", "dev.probe", "--state", "stopped"], f);
    expect(result.toon.exitCode).toBe(0);
    expect(expectWaited(result, "dev.probe", "stopped")).toBeLessThan(250);
  });

  it("fails with WAIT_TIMEOUT carrying the last observation when the state is never reached", async () => {
    const f = device({ [FOREGROUND]: LAUNCHER_FRONT, [PIDOF]: PROBE_RUNNING });
    const { toon, data } = await both(
      ["wait", "app", "dev.probe", "--state", "foreground", "--timeout", "1s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: dev.probe did not reach foreground within 1 s",
        "code: WAIT_TIMEOUT",
        "last:",
        "  state: running",
        "  pid: 8235",
        "  foreground: com.google.android.apps.nexuslauncher",
        "help[2]: Run `adb-axi app info dev.probe` for its pid and foreground state,Run `adb-axi app current` to see what is in front",
        "",
      ].join("\n"),
    );
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT" });
    expectClean(f);
  });

  it("keeps the deadline: a wait for a stop that never comes ends within the timeout plus a margin", async () => {
    const f = device({ [PIDOF]: PROBE_RUNNING });
    const run = await runCli(
      ["wait", "app", "dev.probe", "--state", "stopped", "--timeout", "1s"],
      f.env,
    );
    expect(run.exitCode).toBe(1);
    expect(run.durationMs).toBeLessThan(2500);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      code: "WAIT_TIMEOUT",
      last: { state: "running", pid: 8235 },
    });
  });

  it("reports an unknown last observation when the first read hangs past the deadline", async () => {
    const f = device({ [PIDOF]: { ...PROBE_RUNNING, delayMs: 5000 } });
    const { toon, data } = await both(
      ["wait", "app", "dev.probe", "--state", "running", "--timeout", "1s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT", last: { state: "unknown" } });
  });

  it("fails with REMOTE_EXIT when a read fails, instead of waiting it out", async () => {
    const f = device({ [PIDOF]: { stderr: "/system/bin/sh: pidof: inaccessible\n", exit: 126 } });
    const { toon, data } = await both(
      ["wait", "app", "dev.probe", "--state", "running", "--timeout", "5s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 126 });
    expect(toon.durationMs).toBeLessThan(2500);
  });

  it("rejects a bad state, a missing state and a bad package name with exit 2", async () => {
    const f = device({});
    for (const args of [
      ["wait", "app", "dev.probe", "--state", "sleeping"],
      ["wait", "app", "dev.probe"],
      ["wait", "app", "dev.probe; reboot", "--state", "running"],
    ]) {
      const { toon, data } = await both(args, f);
      expect(toon.exitCode).toBe(2);
      expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails with DEVICE_AMBIGUOUS when two devices are online and none is selected", async () => {
    fake = createFakeAdb("multi-device.json");
    const { toon, data } = await both(["wait", "app", "dev.probe", "--state", "running"], fake);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "DEVICE_AMBIGUOUS" });
  });
});

describe("help for the shipped app read commands", () => {
  it("lists the shipped app and wait commands and no unshipped one", async () => {
    const f = device({});
    const app = decode((await runCli(["app", "--help"], f.env)).stdout.trimEnd()) as {
      subcommands: { command: string }[];
    };
    expect(app.subcommands.map((s) => s.command)).toEqual([
      "adb-axi app current",
      "adb-axi app list",
      "adb-axi app info",
    ]);
    const wait = decode((await runCli(["wait", "--help"], f.env)).stdout.trimEnd()) as {
      subcommands: { command: string }[];
    };
    expect(wait.subcommands.map((s) => s.command)).toEqual(["adb-axi wait app"]);
    expect(f.calls()).toEqual([]);
  });

  it("describes each command's usage and flags", async () => {
    const f = device({});
    const list = await runCli(["app", "list", "--help"], f.env);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("--grep <re>");
    const wait = await runCli(["wait", "app", "--help"], f.env);
    expect(wait.stdout).toContain("--state <foreground|running|stopped> (required)");
    expect(f.calls()).toEqual([]);
  });
});
