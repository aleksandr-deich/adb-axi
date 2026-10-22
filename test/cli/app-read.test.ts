import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdb, FIXTURES_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

// Parity cases run the CLI twice, and a loaded runner can take over 5 s for the pair.
vi.setConfig({ testTimeout: 40_000 });

const SERIAL = "emulator-5554";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

const FOREGROUND = "dumpsys activity activities";
const PIDOF = "pidof 'dev.probe'";
const PROCESS_TABLE = "ps -A -o PID,UID,NAME";
const NO_PROCESSES = { stdout: "  PID   UID NAME\n" };
const PACKAGE = "dumpsys package dev.probe";
const INSTALLED = { stdoutFile: "captured/35/dumpsys-package-debug.txt" };
const PACKAGES_ALL = "pm list packages --show-versioncode -U --user 0";
const PACKAGES_USER = "pm list packages --show-versioncode -U -3 --user 0";
const PACKAGE_DUMP = "dumpsys package packages";

const PROBE_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt" };
const LAUNCHER_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-launcher-front.txt" };
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
    rules: [
      { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
      ...rules,
      ...[0, 10].map((userId) => ({
        match: ["-s", SERIAL, "shell", `pm path --user ${userId} dev.probe`],
        respond: { stdout: "package:/data/app/probe/base.apk\n" },
      })),
      { match: ["-s", SERIAL, "shell", "am get-current-user"], respond: { stdout: "0\n" } },
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
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
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
  });

  it("prints a dash for the pid when the process is not found by name", async () => {
    const f = device({
      [FOREGROUND]: PROBE_FRONT,
      [PACKAGE]: INSTALLED,
      [PROCESS_TABLE]: NO_PROCESSES,
      [PIDOF]: PROBE_STOPPED,
    });
    const { data } = await both(["app", "current"], f);
    expect(data).toEqual({ app: { package: "dev.probe", activity: ".MainActivity", pid: "-" } });
  });
});

describe("a device that goes away mid-command", () => {
  const CLOSED = { stderr: "error: closed\n", exit: 1 };

  /** The first listing finds the device online; `after` is what later ones say. */
  function goingAway(after: string, command: Response = CLOSED): FakeAdb {
    fake = createFakeAdb({
      description: "The emulator is killed while a command runs on it",
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: { stdout: ONE_ONLINE },
          times: 1,
          then: { stdout: after },
        },
        { match: ["-s", SERIAL, "shell", "am get-current-user"], respond: { stdout: "0\n" } },
        { match: ["-s", SERIAL, "shell", FOREGROUND], respond: command },
      ],
    });
    return fake;
  }

  /** Both formats, each from a device that is online when the command starts. */
  async function bothFresh(f: FakeAdb): Promise<Both> {
    const toon = await runCli(["app", "current"], f.env);
    f.resetVars();
    const json = await runCli(["app", "current", "--json"], f.env);
    const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
    expect(decode(toon.stdout.trimEnd())).toEqual(data);
    expect(toon.exitCode).toBe(json.exitCode);
    return { toon, json, data };
  }

  it("is DEVICE_OFFLINE with the usual recovery hints when it is offline now", async () => {
    const f = goingAway(`List of devices attached\n${SERIAL}          offline transport_id:1\n\n`);
    const { toon, data } = await bothFresh(f);
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: `${SERIAL} went offline while reading the foreground activity`,
      code: "DEVICE_OFFLINE",
      step: "reading the foreground activity",
      state: "offline",
      help: [
        `Run \`adb-axi wait boot --device ${SERIAL}\` to wait until it is back`,
        `Run \`adb-axi doctor --device ${SERIAL}\` to see why`,
      ],
    });
    // The command itself is never sent again.
  });

  it("is DEVICE_NOT_FOUND when it is gone from the list", async () => {
    const f = goingAway("List of devices attached\n\n");
    const { data } = await bothFresh(f);
    expect(data).toEqual({
      error: `${SERIAL} went away while reading the foreground activity`,
      code: "DEVICE_NOT_FOUND",
      step: "reading the foreground activity",
      state: "not attached",
      help: [
        "Start the emulator or connect the device, then run the command again",
        "Run `adb-axi devices` to see what is attached",
      ],
    });
  });

  it("reads adb's silent exit 255 the same way, as the emulator dies", async () => {
    const f = goingAway("List of devices attached\n\n", { exit: 255 });
    const { data } = await bothFresh(f);
    expect(data).toMatchObject({ code: "DEVICE_NOT_FOUND", state: "not attached" });
  });
});

describe("app list", () => {
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
});

describe("app info", () => {
  it("measures the resolved current user's data, not the owner's", async () => {
    const dump = readFileSync(
      join(FIXTURES_DIR, "captured/35/dumpsys-package-debug.txt"),
      "utf8",
    ).replace("User 0:", "User 10:");
    const f = device({
      "am get-current-user": { stdout: "10\n" },
      "dumpsys package dev.probe": { stdout: dump },
      [PROCESS_TABLE]: NO_PROCESSES,
      [PIDOF]: PROBE_STOPPED,
      [FOREGROUND]: LAUNCHER_FRONT,
      "run-as dev.probe --user 10 du -sk .": { stdout: "72\t.\n" },
    });
    const run = await runCli(["app", "info", "dev.probe", "--json"], f.env);
    expect(run.exitCode).toBe(0);
    expect((JSON.parse(run.stdout) as Record<string, unknown>).app).toMatchObject({
      installed: true,
      data_size: "72 KB",
    });
    expect(shellCommands(f)).toContain("run-as dev.probe --user 10 du -sk .");
    expectClean(f);
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
});

describe("wait app", () => {
  it("reports an unknown last observation when the first read hangs past the deadline", async () => {
    const f = device({
      [PACKAGE]: INSTALLED,
      [PROCESS_TABLE]: { ...NO_PROCESSES, delayMs: 5000 },
    });
    const { toon, data } = await both(
      ["wait", "app", "dev.probe", "--state", "running", "--timeout", "1s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "WAIT_TIMEOUT", last: { state: "unknown" } });
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
});
