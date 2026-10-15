import { readFileSync } from "node:fs";
import {} from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import {} from "../../src/android/logcat.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const CLOCK = "date '+%s.%N %z'";

/** The device clock when the mark is taken, and when the window is read (+0200). */
const MARK_CLOCK = "1790834300.000000000 +0200\n";
const LATER_CLOCK = "1790834340.000000000 +0200\n";
let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

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

/**
 * One online emulator. Marks and reads are answered by the clock list (the last answer
 * repeats) and the window by `window`, both as the device would print them.
 */
function device(options: {
  api?: number;
  clocks?: string[];
  window?: Response;
  /** Device epoch seconds of the mark; the window is read 40 s later. Sets `clocks` and `start`. */
  markAt?: number;
  scenarioRules?: Rule[];
}): FakeAdb {
  const api = options.api ?? 35;
  const facts = `@sdk\n${api}\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n`;
  const clocks =
    options.markAt === undefined
      ? (options.clocks ?? [MARK_CLOCK, LATER_CLOCK])
      : [`${options.markAt}.000000000 +0200\n`, `${options.markAt + 40}.000000000 +0200\n`];
  fake = createFakeAdb({
    description: "Online emulator with a log window holding crashes",
    synthetic: true,
    rules: [
      {
        match: ["devices", "-l"],
        respond: {
          stdout: `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 transport_id:1\n\n`,
        },
      },
      { match: ["-s", SERIAL, "shell", { re: "echo @sdk; .*" }], respond: { stdout: facts } },
      ...clocks.map((stdout, i): Rule => ({
        match: ["-s", SERIAL, "shell", CLOCK],
        respond: { stdout },
        ...(i < clocks.length - 1 ? { times: 1 } : {}),
      })),
      ...(options.window === undefined
        ? []
        : [
            {
              match: ["-s", SERIAL, "shell", { re: "^logcat -d -v epoch -T [0-9]+\\.[0-9]{3}$" }],
              respond: options.window,
            },
          ]),
      ...(options.scenarioRules ?? []),
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
  expect(decode(toon.stdout.trimEnd())).toEqual(data);
  return { toon, json, data };
}

const shellCommands = (f: FakeAdb): string[] =>
  f
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[2] === "shell")
    .map((argv) => argv[3] ?? "");

const logcatCommands = (f: FakeAdb): string[] =>
  shellCommands(f).filter((command) => command.startsWith("logcat"));

/** Every call was answered and named its device, and every logcat call is one bounded dump. */
function expectClean(f: FakeAdb): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices") expect(call.argv[0]).toBe("-s");
  }
  for (const command of logcatCommands(f)) expect(command.split(" ")).toContain("-d");
}

/** Mark the device clock, then run `logs crash` as TOON and `--json`. */
async function crashSince(f: FakeAdb, ...args: string[]): Promise<Both> {
  await runCli(["logs", "mark", "before-run"], f.env);
  return both(["logs", "crash", "--since", "before-run", ...args], f);
}

describe("logs crash", () => {
  describe("matching by package name", () => {
    const window = [
      // The app's own crash, a second process of the app, a look-alike package, another app.
      ...[
        ["com.example.notes", 100],
        ["com.example.notes:sync", 101],
        ["com.example.notes2", 102],
        ["com.example.notes.debug", 103],
        ["com.other.app", 104],
      ].flatMap(([process, pid]) => [
        logLine(
          1790834320000 + Number(pid),
          Number(pid),
          "E",
          "AndroidRuntime",
          "FATAL EXCEPTION: main",
        ),
        logLine(
          1790834320000 + Number(pid),
          Number(pid),
          "E",
          "AndroidRuntime",
          `Process: ${String(process)}, PID: ${String(pid)}`,
        ),
        logLine(
          1790834320000 + Number(pid),
          Number(pid),
          "E",
          "AndroidRuntime",
          "java.lang.IllegalStateException: boom",
        ),
      ]),
      // An ANR of the app, printed by system_server (pid 552, another uid).
      logLine(
        1790834330000,
        552,
        "E",
        "ActivityManager",
        "ANR in com.example.notes (com.example.notes/.Main)",
      ),
      logLine(1790834330000, 552, "E", "ActivityManager", "PID: 100"),
      logLine(1790834330000, 552, "E", "ActivityManager", "Reason: Input dispatching timed out"),
    ].join("\n");

    it("counts the app's processes by the name in the report, not look-alikes, uids or pids", async () => {
      const f = device({ window: { stdout: window } });
      const { data } = await crashSince(f, "--pkg", "com.example.notes");
      expect((data.crash as Record<string, unknown>[]).map((c) => [c.kind, c.process])).toEqual([
        ["java", "com.example.notes"],
        ["java", "com.example.notes:sync"],
        ["anr", "com.example.notes"],
      ]);
      expect(data.crashes).toMatch(/^3 since before-run/);
      // No package lookup, process list or uid is needed: only the clock and the window.
      expect(
        shellCommands(f).filter(
          (c) => !c.startsWith("logcat") && !c.startsWith("echo @sdk") && c !== CLOCK,
        ),
      ).toEqual([]);
      expect(logcatCommands(f).join(" ")).not.toContain("--uid");
      expectClean(f);
    });
  });

  describe("the window", () => {
    it("does not count a crash from before the mark, nor the tail of one that began before it", async () => {
      const f = device({
        window: {
          stdout: [
            // A whole crash before the mark (1790834300.000), then one that straddles it.
            logLine(1790834100000, 100, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
            logLine(1790834100000, 100, "E", "AndroidRuntime", "Process: dev.probe, PID: 100"),
            logLine(
              1790834100000,
              100,
              "E",
              "AndroidRuntime",
              "java.lang.IllegalStateException: stale",
            ),
            logLine(1790834299999, 200, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
            logLine(1790834300000, 200, "E", "AndroidRuntime", "Process: dev.probe, PID: 200"),
            logLine(
              1790834300000,
              200,
              "E",
              "AndroidRuntime",
              "java.lang.IllegalStateException: straddling",
            ),
            logLine(
              1790834300001,
              200,
              "E",
              "AndroidRuntime",
              "\tat dev.probe.Main.run(Main.kt:1)",
            ),
            logLine(1790834310000, 300, "I", "Tag", "later activity, no crash"),
          ].join("\n"),
        },
      });
      const { toon, data } = await crashSince(f, "--pkg", "dev.probe");
      expect(toon.exitCode).toBe(0);
      expect(data).toEqual({ crashes: "0 since before-run (40 s, 4 lines scanned)" });
    });

    it("excludes a native crash raised before the mark even when its tombstone follows", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(
              1790834299900,
              9386,
              "F",
              "libc",
              "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.probe), pid 9386 (dev.probe)",
            ),
            logLine(1790834320200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(
              1790834320200,
              9409,
              "F",
              "DEBUG",
              "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<",
            ),
            logLine(1790834320200, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data).toEqual({ crashes: "0 since before-run (40 s, 3 lines scanned)" });
      expect(logcatCommands(f)).toEqual([
        "logcat -d -v epoch -T 1790834240.000",
        "logcat -d -v epoch -T 1790834240.000",
      ]);
      expectClean(f);
    });

    it("does not count an incomplete tombstone as a new crash", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(
              1790834299900,
              9386,
              "F",
              "libc",
              "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.probe), pid 9386 (dev.probe)",
            ),
            logLine(1790834300200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(
              1790834300200,
              9409,
              "F",
              "DEBUG",
              "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<",
            ),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data).toEqual({ crashes: "0 since before-run (40 s, 2 lines scanned)" });
    });

    it("keeps a tombstone in the window when its pid was reused by another process", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(
              1790834299900,
              9386,
              "F",
              "libc",
              "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.other), pid 9386 (dev.other)",
            ),
            logLine(1790834300200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(
              1790834300200,
              9409,
              "F",
              "DEBUG",
              "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<",
            ),
            logLine(1790834300200, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toBe("1 since before-run (40 s, 3 lines scanned)");
      expect(data.crash).toMatchObject({ kind: "native", at: "2026-10-01 07:58:20.200" });
    });

    it("counts a new native crash after the same pid and package restart", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(
              1790834299900,
              9386,
              "F",
              "libc",
              "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.probe), pid 9386 (dev.probe)",
            ),
            logLine(
              1790834300000,
              552,
              "I",
              "ActivityManager",
              "Start proc 9386:dev.probe/u0a213 for activity",
            ),
            logLine(1790834300200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(
              1790834300200,
              9409,
              "F",
              "DEBUG",
              "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<",
            ),
            logLine(1790834300200, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toBe("1 since before-run (40 s, 4 lines scanned)");
      expect(data.crash).toMatchObject({ kind: "native", at: "2026-10-01 07:58:20.200" });
    });
  });

  describe("truncation and --full", () => {
    it("keeps unrelated system-server activity out of an ANR's full trace", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(1790834310000, 552, "E", "ActivityManager", "ANR in dev.probe"),
            logLine(1790834310000, 552, "E", "ActivityManager", "PID: 123"),
            logLine(1790834310000, 552, "E", "ActivityManager", "Reason: blocked"),
            logLine(
              1790834310000,
              552,
              "E",
              "ActivityManager",
              "CPU usage from 100ms to -1ms ago:",
            ),
            logLine(1790834310000, 552, "E", "ActivityManager", "Reason: unrelated"),
          ].join("\n"),
        },
      });
      await runCli(["logs", "mark", "before-run"], f.env);
      const run = await runCli(
        ["logs", "crash", "--since", "before-run", "--pkg", "dev.probe", "--full", "--json"],
        f.env,
      );
      const data = JSON.parse(run.stdout) as Record<string, unknown>;
      expect(data.crash).toMatchObject({ message: "blocked" });
      expect(readFileSync(data.full as string, "utf8")).toContain("Reason: blocked");
      expect(readFileSync(data.full as string, "utf8")).not.toContain("Reason: unrelated");
    });
  });

  describe("errors", () => {
    it("rejects a bad package name with exit 2 before touching the device", async () => {
      const f = device({});
      const run = await runCli(["logs", "crash", "--pkg", "not a package"], f.env);
      expect(run.exitCode).toBe(2);
      expect(decode(run.stdout.trimEnd())).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(shellCommands(f)).toEqual([]);
    });

    it("fails INVALID_OUTPUT when logcat prints text that is no log at all", async () => {
      const f = device({ window: { stdout: "this is not logcat output\n" } });
      const { toon, data } = await crashSince(f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INVALID_OUTPUT", step: "reading the log" });
    });

    it("fails REMOTE_EXIT when logcat itself fails, never reading it as zero crashes", async () => {
      const f = device({ window: { stderr: "logcat: Unable to open log device", exit: 1 } });
      const { toon, data } = await crashSince(f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
    });
  });
});
