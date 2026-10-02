import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { parseLogcat } from "../../src/android/logcat.js";
import { FIXTURES_DIR, createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const A = "emulator-5554";
const B = "emulator-5556";

const CLOCK = "date '+%s.%N %z'";
const PS = "ps -A -o PID,NAME";
const PACKAGE_DUMP = "dumpsys package dev.probe";

/** The device clock when a mark is taken, and later when a log window is read (-0700). */
const MARK_CLOCK = "1790834110.420707948 -0700\n";
const LATER_CLOCK = "1790834140.000000000 -0700\n";
const MARK_START = "1790834110.420";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

interface Device {
  serial: string;
  api: number;
  /** Shell commands the device answers, besides facts; the clock is added by `device`. */
  shell?: Record<string, Response>;
  /** Clock answers in order; the last one answers every later call. */
  clocks?: string[];
}

function deviceRules(device: Device): Rule[] {
  const facts = `@sdk\n${device.api}\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n`;
  const clocks = device.clocks ?? [LATER_CLOCK];
  return [
    {
      match: ["-s", device.serial, "shell", { re: "echo @sdk; .*" }],
      respond: { stdout: facts },
    },
    ...clocks.map((stdout, i): Rule => ({
      match: ["-s", device.serial, "shell", CLOCK],
      respond: { stdout },
      ...(i < clocks.length - 1 ? { times: 1 } : {}),
    })),
    ...Object.entries(device.shell ?? {}).map(([command, respond]) => ({
      match: ["-s", device.serial, "shell", command],
      respond,
    })),
  ];
}

function devices(...list: Device[]): FakeAdb {
  const listing = list
    .map((d, i) => `${d.serial}          device product:sdk_gphone64_arm64 transport_id:${i + 1}\n`)
    .join("");
  fake = createFakeAdb({
    description: "Online emulators answering the log commands",
    synthetic: true,
    rules: [
      { match: ["devices", "-l"], respond: { stdout: `List of devices attached\n${listing}\n` } },
      ...list.flatMap(deviceRules),
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

function logcatCommands(f: FakeAdb): string[] {
  return shellCommands(f).filter((command) => command.startsWith("logcat"));
}

/** Every call was answered, and every device call named its device. */
function expectClean(f: FakeAdb): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices") expect(call.argv[0]).toBe("-s");
  }
}

/** Every logcat call is one bounded dump: `-d` is always there, so nothing streams. */
function expectBounded(f: FakeAdb): void {
  for (const command of logcatCommands(f)) expect(command.split(" ")).toContain("-d");
}

const fixture = (path: string): { stdoutFile: string } => ({ stdoutFile: path });
const fixtureText = (path: string): string => readFileSync(join(FIXTURES_DIR, path), "utf8");

const PROBE_DUMP_35 = fixture("captured/35/dumpsys-package-debug.txt");
const PROBE_DUMP_30 = fixture("synthetic/30/dumpsys-package-release.txt");

/** A log line as `logcat -v epoch` prints it. */
function logLine(
  epochMs: number,
  pid: number,
  level: string,
  tag: string,
  message: string,
): string {
  const seconds = Math.floor(epochMs / 1000);
  const millis = String(epochMs - seconds * 1000).padStart(3, "0");
  return `${String(seconds).padStart(19)}.${millis} ${String(pid).padStart(5)} ${String(pid).padStart(5)} ${level} ${tag.padEnd(8)}: ${message}`;
}

const rowsOf = (data: Record<string, unknown>): Record<string, string>[] =>
  data.lines as Record<string, string>[];

describe("logs mark", () => {
  it("stores the device clock, not the host clock, and prints it in device local time", async () => {
    const f = devices({ serial: A, api: 35, clocks: [MARK_CLOCK] });
    const { toon, data } = await both(["logs", "mark", "before-save"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe(
      'ok: "mark before-save -> 2026-09-30 22:55:10.420 on emulator-5554"\n',
    );
    expect(Object.keys(data)).toEqual(["ok"]);
    const marks = JSON.parse(readFileSync(join(f.home, A, "marks.json"), "utf8")) as {
      marks: Record<string, unknown>;
    };
    expect(marks.marks["before-save"]).toEqual({
      epoch_ms: 1790834110420,
      utc_offset_minutes: -420,
    });
    expect(shellCommands(f)).not.toContain(PS);
    expectClean(f);
  });

  it("names an unnamed mark mark-<HHMMSS> from device time and prints the name", async () => {
    const f = devices({ serial: A, api: 35, clocks: [MARK_CLOCK] });
    const { toon } = await both(["logs", "mark"], f);
    expect(toon.stdout).toBe(
      'ok: "mark mark-225510 -> 2026-09-30 22:55:10.420 on emulator-5554"\n',
    );
    expectClean(f);
  });

  it("replaces an earlier mark of the same name", async () => {
    const f = devices({ serial: A, api: 35, clocks: [MARK_CLOCK, LATER_CLOCK] });
    await runCli(["logs", "mark", "run"], f.env);
    await runCli(["logs", "mark", "run"], f.env);
    const marks = JSON.parse(readFileSync(join(f.home, A, "marks.json"), "utf8")) as {
      marks: Record<string, { epoch_ms: number }>;
    };
    expect(Object.keys(marks.marks)).toEqual(["run"]);
    expect(marks.marks.run?.epoch_ms).toBe(1790834140000);
  });

  it("records the app processes on API 30, for the pid-list fallback", async () => {
    const f = devices({
      serial: A,
      api: 30,
      clocks: [MARK_CLOCK],
      shell: { [PS]: fixture("synthetic/30/ps-pid-name.txt") },
    });
    const { toon } = await both(["logs", "mark", "before-save"], f);
    expect(toon.exitCode).toBe(0);
    const marks = JSON.parse(readFileSync(join(f.home, A, "marks.json"), "utf8")) as {
      marks: Record<string, { processes: unknown }>;
    };
    expect(marks.marks["before-save"]?.processes).toEqual([
      { pid: 4400, name: "com.other.app" },
      { pid: 6044, name: "dev.probe" },
      { pid: 6050, name: "dev.probe:remote" },
    ]);
    expectClean(f);
  });

  it("keeps marks per serial: a mark on one device is not found on another", async () => {
    const f = devices(
      { serial: A, api: 35, clocks: [MARK_CLOCK] },
      {
        serial: B,
        api: 35,
        clocks: [LATER_CLOCK],
        shell: { [logcatFor(MARK_START)]: { stdout: "" } },
      },
    );
    await runCli(["logs", "mark", "before-save", "--device", A], f.env);
    expect(existsSync(join(f.home, A, "marks.json"))).toBe(true);
    expect(existsSync(join(f.home, B, "marks.json"))).toBe(false);

    const { toon, data } = await both(["logs", "--since", "before-save", "--device", B], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "MARK_NOT_FOUND", marks: [] });
    expect(logcatCommands(f)).toEqual([]);
  });

  it("rejects names that are unsafe or that read as a duration, before touching a device", async () => {
    const f = devices({ serial: A, api: 35 });
    for (const name of ["30s", "5m", "a b", "../x", "-x", "x".repeat(65)]) {
      const { stdout, exitCode } = await runCli(["logs", "mark", name], f.env);
      expect(exitCode, name).toBe(2);
      expect(decode(stdout.trimEnd()), name).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails INVALID_OUTPUT when the device clock prints something else", async () => {
    const f = devices({ serial: A, api: 35, clocks: ["not a clock\n"] });
    const { data, toon } = await both(["logs", "mark", "x"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading the device clock" });
    expect(existsSync(join(f.home, A, "marks.json"))).toBe(false);
  });
});

function logcatFor(start: string, uid?: number): string {
  const base = `logcat -d -v epoch -T ${start}`;
  return uid === undefined ? base : `${base} --uid ${uid}`;
}

describe("logs", () => {
  it("scopes to the app with logcat --uid on API 35 and reports the window, counts and lines", async () => {
    const dump = fixtureText("captured/35/logcat-epoch-uid.txt");
    const parsed = parseLogcat(dump).lines;
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790834222.000000000 +0000\n", "1790834250.000000000 +0000\n"],
      shell: {
        [PACKAGE_DUMP]: PROBE_DUMP_35,
        [logcatFor("1790834222.000", 10213)]: fixture("captured/35/logcat-epoch-uid.txt"),
      },
    });
    await runCli(["logs", "mark", "before-run"], f.env);
    const { toon, data } = await both(
      ["logs", "--pkg", "dev.probe", "--since", "before-run", "--level", "W"],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(Object.keys(data)).toEqual(["window", "scope", "counts", "lines"]);
    expect(data.window).toBe(`before-run -> now (28 s), ${parsed.length} lines scanned`);
    expect(data.scope).toBe("dev.probe (uid 10213)");

    const warnings = parsed.filter((line) => ["W", "E", "F"].includes(line.level));
    const counts = data.counts as Record<string, number>;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(warnings.length);
    expect(Object.keys(rowsOf(data)[0] ?? {})).toEqual(["time", "level", "tag", "message"]);
    expect(rowsOf(data)[0]).toEqual({
      time: "05:57:02.843",
      level: "W",
      tag: "ziparchive",
      message: expect.stringContaining("Unable to open") as string,
    });
    // Nothing was cut, so there is no `shown` line and no `--full` help.
    expect(data).not.toHaveProperty("shown");
    expect(data).not.toHaveProperty("help");
    expect(toon.stdout).not.toContain("--full");
    expect(logcatCommands(f)).toEqual([
      logcatFor("1790834222.000", 10213),
      logcatFor("1790834222.000", 10213),
    ]);
    expectBounded(f);
    expectClean(f);
  });

  it("never sends --uid to an API 30 device, and scopes by the union of three pid sources", async () => {
    // The mark is taken while the probe runs as pid 6011; the process list has since moved on.
    fake = createFakeAdb({
      description: "API 30 emulator: the process list changes between the mark and the read",
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: { stdout: `List of devices attached\n${A}          device transport_id:1\n\n` },
        },
        ...deviceRules({
          serial: A,
          api: 30,
          clocks: [MARK_CLOCK, LATER_CLOCK],
          shell: {
            [PACKAGE_DUMP]: PROBE_DUMP_30,
            [logcatFor(MARK_START)]: fixture("synthetic/30/logcat-epoch-window.txt"),
          },
        }),
        {
          match: ["-s", A, "shell", PS],
          respond: {
            stdout:
              "  PID NAME\n    1 init\n  517 system_server\n 4400 com.other.app\n 6011 dev.probe\n",
          },
          times: 1,
        },
        { match: ["-s", A, "shell", PS], respond: fixture("synthetic/30/ps-pid-name.txt") },
      ],
    });
    const f = fake;
    await runCli(["logs", "mark", "before-kill"], f.env);
    const { toon, data } = await both(["logs", "--pkg", "dev.probe", "--since", "before-kill"], f);
    expect(toon.exitCode).toBe(0);

    // 6011 was recorded at the mark, 6030 only appears in a "Start proc" line, and 6044
    // and 6050 (the second process) are running now.
    expect(data.scope).toBe("dev.probe (pids 6011, 6030, 6044, 6050)");
    expect(data.window).toBe("before-kill -> now (30 s), 17 lines scanned");
    expect(rowsOf(data).map((row) => `${row.time} ${row.level} ${row.tag} ${row.message}`)).toEqual(
      [
        "22:55:10.900 I dev.probe Resumed MainActivity",
        "22:55:12.000 D ProbeState event=inc saved=1 volatile=1 rows=0 restored=false pid=6011",
        "22:55:14.900 I dev.probe Late-enabling -Xcheck:jni",
        "22:55:15.100 W Choreographer Skipped 31 frames!  The application may be doing too much work on its main thread. (repeated 3x)",
        "22:55:18.000 E AndroidRuntime FATAL EXCEPTION: main",
        "22:55:18.000 E AndroidRuntime java.lang.IllegalStateException: probe crash requested",
        "22:55:18.000 E AndroidRuntime \tat dev.probe.MainActivity.dispatch(MainActivity.kt:67)",
        "22:55:18.500 I ProbeState event=start saved=1 volatile=0 rows=0 restored=true pid=6044",
        "22:55:19.000 D ProbeRemote remote process ready",
      ],
    );
    expect(data.counts).toEqual({ E: 3, W: 3, I: 3, D: 2 });

    // The fake-adb log: `--uid` never reached the device, and every logcat call was a bounded dump.
    expect(logcatCommands(f).length).toBeGreaterThan(0);
    for (const call of f.calls()) expect(call.argv.join(" ")).not.toContain("--uid");
    expectBounded(f);
    expectClean(f);
  });

  it("reads the whole window unscoped without --pkg, from 15 minutes back by default", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790834100.000")]: {
          stdout: [
            logLine(1790834999000, 100, "I", "Tag", "recent one"),
            logLine(1790834999500, 200, "E", "Other", "recent two"),
          ].join("\n"),
        },
      },
    });
    const { data } = await both(["logs"], f);
    expect(data.window).toBe("15m ago -> now (900 s), 2 lines scanned");
    expect(data).not.toHaveProperty("scope");
    expect(rowsOf(data)).toHaveLength(2);
    // No package means no package lookup and no process list.
    expect(shellCommands(f).filter((c) => !c.startsWith("logcat") && c !== CLOCK)).toHaveLength(0);
    expectClean(f);
  });

  it("counts a duration back from the device clock, never the host clock", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.250000000 +0000\n"],
      shell: { [logcatFor("1790834970.250")]: { stdout: "" } },
    });
    const { data } = await both(["logs", "--since", "30s"], f);
    expect(data.window).toBe("30s ago -> now (30 s), 0 lines scanned");
    expect(rowsOf(data)).toEqual([]);
    expect(data.counts).toEqual({});
    expectClean(f);
  });

  it("filters by minimum level and by message regex, and counts what passes", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790834100.000")]: {
          stdout: [
            logLine(1790834990000, 1, "D", "Room", "Migration from 3 to 4 not found"),
            logLine(1790834991000, 1, "W", "Room", "Migration from 4 to 5 not found"),
            logLine(1790834992000, 1, "E", "Room", "Migration failed"),
            logLine(1790834993000, 1, "E", "Other", "unrelated"),
            logLine(1790834994000, 1, "F", "Room", "Migration fatal"),
          ].join("\n"),
        },
      },
    });
    const { data } = await both(["logs", "--level", "W", "--grep", "^Migration (from|fail)"], f);
    expect(data.window).toBe("15m ago -> now (900 s), 5 lines scanned");
    expect(rowsOf(data).map((row) => row.message)).toEqual([
      "Migration from 4 to 5 not found",
      "Migration failed",
    ]);
    expect(data.counts).toEqual({ E: 1, W: 1 });
  });

  it("collapses runs of identical lines and says how often they repeated", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790834100.000")]: {
          stdout: [
            logLine(1790834990000, 1, "W", "Choreo", "Skipped 31 frames"),
            logLine(1790834990100, 2, "W", "Choreo", "Skipped 31 frames"),
            logLine(1790834990200, 1, "I", "Choreo", "Skipped 31 frames"),
            logLine(1790834990300, 1, "W", "Choreo", "Skipped 31 frames"),
          ].join("\n"),
        },
      },
    });
    const { data } = await both(["logs"], f);
    expect(rowsOf(data).map((row) => row.message)).toEqual([
      "Skipped 31 frames (repeated 2x)",
      "Skipped 31 frames",
      "Skipped 31 frames",
    ]);
    // Counts are lines, not rows.
    expect(data.counts).toEqual({ W: 3, I: 1 });
  });

  describe("truncation", () => {
    const many = (n: number): string =>
      Array.from({ length: n }, (_, i) =>
        logLine(1790834900000 + i * 10, 1, "I", "Tag", `line number ${i}`),
      ).join("\n");

    it("keeps the last 50 lines, says how many were cut and points at --full", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: { [logcatFor("1790834100.000")]: { stdout: many(120) } },
      });
      const { toon, data } = await both(["logs"], f);
      expect(rowsOf(data)).toHaveLength(50);
      expect(rowsOf(data)[0]?.message).toBe("line number 70");
      expect(rowsOf(data).at(-1)?.message).toBe("line number 119");
      expect(data.shown).toBe("50 of 120 lines");
      expect(data.help).toEqual([
        "Run the same command with `--full` to write all 120 lines to a file",
      ]);
      expect(toon.stdout).toContain("shown: 50 of 120 lines");
      expect(data.counts).toEqual({ I: 120 });
    });

    it("counts uncollapsed lines in the --full hint", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [logcatFor("1790834100.000")]: {
            stdout: [
              logLine(1790834900000, 1, "I", "Tag", "repeat"),
              logLine(1790834900100, 1, "I", "Tag", "repeat"),
              many(60),
            ].join("\n"),
          },
        },
      });
      const { data } = await both(["logs"], f);
      expect(data.shown).toBe("50 of 61 lines");
      expect(data.help).toEqual([
        "Run the same command with `--full` to write all 62 lines to a file",
      ]);
    });

    it("writes every line to a file with --full and prints its path, without the --full help", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: { [logcatFor("1790834100.000")]: { stdout: many(120) } },
      });
      const toon = await runCli(["logs", "--full"], f.env);
      const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
      expect(data.shown).toBe("50 of 120 lines");
      expect(data).not.toHaveProperty("help");
      const path = data.full as string;
      expect(path.startsWith(join(f.home, "out"))).toBe(true);
      const written = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(written).toHaveLength(120);
      expect(written[0]).toBe("06:08:20.000 I Tag: line number 0");
      expect(written.at(-1)).toBe("06:08:21.190 I Tag: line number 119");
    });

    it("writes an empty file and prints its path when --full matches no lines", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: { [logcatFor("1790834100.000")]: { stdout: "" } },
      });
      const toon = await runCli(["logs", "--full"], f.env);
      const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
      expect(toon.exitCode).toBe(0);
      expect(rowsOf(data)).toEqual([]);
      expect(data.counts).toEqual({});
      expect(data.full).toEqual(expect.stringContaining(join(f.home, "out")));
      expect(readFileSync(data.full as string, "utf8")).toBe("");
      expect(toon.stdout).toContain("full:");
    });

    it("keeps distinct timestamps for identical messages in the --full file", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [logcatFor("1790834100.000")]: {
            stdout: [
              logLine(1790834990000, 1, "W", "Tag", "repeat"),
              logLine(1790834990500, 1, "W", "Tag", "repeat"),
            ].join("\n"),
          },
        },
      });
      const toon = await runCli(["logs", "--full"], f.env);
      const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
      expect(toon.exitCode).toBe(0);
      expect(rowsOf(data)).toHaveLength(1);
      expect(rowsOf(data)[0]?.message).toBe("repeat (repeated 2x)");
      expect(readFileSync(data.full as string, "utf8")).toBe(
        "06:09:50.000 W Tag: repeat\n06:09:50.500 W Tag: repeat\n",
      );
    });

    it("prints neither shown nor the --full help when nothing was cut", async () => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: { [logcatFor("1790834100.000")]: { stdout: many(50) } },
      });
      const { data } = await both(["logs"], f);
      expect(rowsOf(data)).toHaveLength(50);
      expect(data).not.toHaveProperty("shown");
      expect(data).not.toHaveProperty("help");
    });

    it("cuts a long message and says how long it was, keeping it whole in the file", async () => {
      const long = "x".repeat(900);
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [logcatFor("1790834100.000")]: { stdout: logLine(1790834900000, 1, "E", "Tag", long) },
        },
      });
      const toon = await runCli(["logs", "--full"], f.env);
      const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
      expect(rowsOf(data)[0]?.message).toBe(`${"x".repeat(500)}... (truncated, 900 chars total)`);
      expect(readFileSync(data.full as string, "utf8")).toContain(long);
    });
  });

  it("fails MARK_NOT_FOUND when no mark has that name, listing the marks the device has", async () => {
    const f = devices({ serial: A, api: 35, clocks: [MARK_CLOCK, LATER_CLOCK] });
    await runCli(["logs", "mark", "before-save"], f.env);
    const { toon, data } = await both(["logs", "--since", "nope"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: "no log mark named nope on emulator-5554",
      code: "MARK_NOT_FOUND",
      marks: ["before-save"],
      help: [
        "Run `adb-axi logs mark nope` to record it now",
        "Or pass one of the marks listed above, or a duration such as `5m`",
      ],
    });
    expect(logcatCommands(f)).toEqual([]);
  });

  it("fails APP_NOT_INSTALLED for a package the device does not have", async () => {
    const f = devices({
      serial: A,
      api: 35,
      shell: {
        "dumpsys package dev.probe.missing": fixture("captured/35/dumpsys-package-absent.txt"),
      },
    });
    const { toon, data } = await both(["logs", "--pkg", "dev.probe.missing"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      error: "dev.probe.missing is not installed on emulator-5554",
      code: "APP_NOT_INSTALLED",
    });
    expect(logcatCommands(f)).toEqual([]);
  });

  it("rejects a regex that does not compile and a bad package name with exit 2", async () => {
    const f = devices({ serial: A, api: 35 });
    const badRegex = await runCli(["logs", "--grep", "("], f.env);
    expect(badRegex.exitCode).toBe(2);
    expect(decode(badRegex.stdout.trimEnd())).toMatchObject({ code: "VALIDATION_ERROR" });
    const badPkg = await runCli(["logs", "--pkg", "not a package"], f.env);
    expect(badPkg.exitCode).toBe(2);
    const badLevel = await runCli(["logs", "--level", "X"], f.env);
    expect(badLevel.exitCode).toBe(2);
    expect(shellCommands(f)).toEqual([]);
  });

  it("fails INVALID_OUTPUT when logcat prints text that is no log at all", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: { [logcatFor("1790834100.000")]: { stdout: "this is not logcat output\n" } },
    });
    const { toon, data } = await both(["logs"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading the log" });
  });

  it("fails REMOTE_EXIT when logcat itself fails, never reading it as an empty log", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790834100.000")]: { stderr: "logcat: Unable to open log device", exit: 1 },
      },
    });
    const { toon, data } = await both(["logs"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
  });
});

describe("wait log", () => {
  it("is done when a line after the window start matches, and prints waited_ms and the line", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: [MARK_CLOCK, LATER_CLOCK],
      shell: {
        [logcatFor(MARK_START)]: {
          stdout: [
            logLine(1790834111000, 1, "I", "Other", "nothing yet"),
            logLine(
              1790834120000,
              2,
              "I",
              "ActivityTaskManager",
              "Displayed dev.probe/.MainActivity: +412ms",
            ),
          ].join("\n"),
        },
      },
    });
    await runCli(["logs", "mark", "before-start"], f.env);
    const { toon, data } = await both(
      ["wait", "log", "Displayed dev\\.probe", "--since", "before-start"],
      f,
    );
    expect(toon.exitCode).toBe(0);
    expect(Object.keys(data)).toEqual(["ok", "waited_ms", "match"]);
    expect(data.ok).toMatch(/^wait log Displayed dev\\.probe -> matched after \d+ ms$/);
    expect(typeof data.waited_ms).toBe("number");
    expect(data.match).toEqual({
      time: "22:55:20.000",
      level: "I",
      tag: "ActivityTaskManager",
      message: "Displayed dev.probe/.MainActivity: +412ms",
    });
    expectBounded(f);
    expectClean(f);
  });

  it("polls until the line shows up", async () => {
    const f = createFakeAdb({
      description: "The matching line appears on the third read",
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: { stdout: `List of devices attached\n${A}          device transport_id:1\n\n` },
        },
        ...deviceRules({ serial: A, api: 35, clocks: ["1790835000.000000000 +0000\n"] }),
        {
          match: ["-s", A, "shell", logcatFor("1790835000.000")],
          respond: { stdout: logLine(1790835000500, 1, "I", "Tag", "booting") },
          times: 2,
          then: { stdout: logLine(1790835001500, 1, "I", "Tag", "ready: done") },
        },
      ],
    });
    fake = f;
    const toon = await runCli(["wait", "log", "ready"], f.env);
    expect(toon.exitCode).toBe(0);
    const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    expect(data.waited_ms).toBeGreaterThanOrEqual(400);
    expect(logcatCommands(f)).toHaveLength(3);
    expectBounded(f);
  });

  it("opens the window at the start of the wait without --since, so older lines never match", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790835000.000")]: {
          stdout: [
            // Logged before the wait began: the device may still hand it out.
            logLine(1790834999900, 1, "I", "Tag", "ready"),
            logLine(1790835000100, 1, "I", "Tag", "starting"),
          ].join("\n"),
        },
      },
    });
    const { toon, data } = await both(["wait", "log", "^ready$", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: 'no log line matching "^ready$" within 1 s',
      code: "WAIT_TIMEOUT",
      last: { lines_scanned: 1, newest: "06:10:00.100 I Tag: starting" },
      help: ["Run `adb-axi logs --since 1m` to see what the device logged"],
    });
    expectBounded(f);
  });

  it("starts the window a duration back from the device clock", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: ["1790835000.000000000 +0000\n"],
      shell: {
        [logcatFor("1790834990.000")]: {
          stdout: logLine(1790834995000, 1, "I", "Tag", "seen 10 s ago"),
        },
      },
    });
    const { toon, data } = await both(["wait", "log", "seen", "--since", "10s"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.match).toMatchObject({ message: "seen 10 s ago" });
  });

  it("fails WAIT_TIMEOUT with the last observation when nothing matches", async () => {
    const f = devices({
      serial: A,
      api: 35,
      clocks: [MARK_CLOCK, LATER_CLOCK],
      shell: {
        [logcatFor(MARK_START)]: {
          stdout: [
            logLine(1790834111000, 1, "I", "Tag", "one"),
            logLine(1790834112000, 1, "W", "Tag", "two"),
          ].join("\n"),
        },
      },
    });
    await runCli(["logs", "mark", "m"], f.env);
    const { toon, data } = await both(
      ["wait", "log", "never", "--since", "m", "--timeout", "1s"],
      f,
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: 'no log line matching "never" within 1 s',
      code: "WAIT_TIMEOUT",
      last: { lines_scanned: 2, newest: "22:55:12.000 W Tag: two" },
      help: ["Run `adb-axi logs --since m` to see what the device logged"],
    });
    expectBounded(f);
  });

  it("fails MARK_NOT_FOUND for an unknown mark, before reading any log", async () => {
    const f = devices({ serial: A, api: 35 });
    const { toon, data } = await both(["wait", "log", "x", "--since", "nope"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({ code: "MARK_NOT_FOUND", marks: [] });
    expect(logcatCommands(f)).toEqual([]);
  });

  it("rejects a regex that does not compile with exit 2", async () => {
    const f = devices({ serial: A, api: 35 });
    const { stdout, exitCode } = await runCli(["wait", "log", "["], f.env);
    expect(exitCode).toBe(2);
    expect(decode(stdout.trimEnd())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });
});
