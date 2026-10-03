import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { parseLogcat } from "../../src/android/logcat.js";
import { FIXTURES_DIR, createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
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

const captured = (api: "35" | "37", file: string): string =>
  readFileSync(join(FIXTURES_DIR, "captured", api, file), "utf8");

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
              match: ["-s", SERIAL, "shell", "logcat -d -v epoch"],
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

const scanned = (text: string): number => parseLogcat(text).lines.length;

describe("logs crash", () => {
  describe("a Java crash", () => {
    it.each([
      { api: "35" as const, at: "2026-10-01 07:58:44.594", frames: 22 },
      { api: "37" as const, at: "2026-10-01 07:56:25.610", frames: 23 },
    ])("prints the crash recorded on API $api and the count in the window", async (c) => {
      const text = captured(c.api, "logcat-crash-java.txt");
      const f = device({
        api: Number(c.api),
        markAt: c.api === "35" ? 1790834300 : 1790834170,
        window: { stdout: text },
      });
      const { toon, data } = await crashSince(f, "--pkg", "dev.probe");
      expect(toon.exitCode).toBe(0);
      expect(data).toEqual({
        crashes: `1 since before-run (40 s, ${scanned(text)} lines scanned)`,
        crash: {
          kind: "java",
          at: c.at,
          process: "dev.probe",
          exception: "java.lang.IllegalStateException",
          message: "probe crash requested",
          app_frame: "dev.probe.MainActivity.dispatch(MainActivity.kt:67)",
          frames: c.frames,
        },
        help: ["Run the same command with `--full` to write the whole trace to a file"],
      });
      expect(toon.stdout).toContain("crash:\n  kind: java\n  at: ");
      expect(toon.stdout).toContain(
        "help[1]: Run the same command with `--full` to write the whole trace to a file",
      );
      // The bounded dump includes lead-in for native crash signals, without a uid filter.
      expect(logcatCommands(f)).toEqual(["logcat -d -v epoch", "logcat -d -v epoch"]);
      expectClean(f);
    });

    it("cuts a long message and says how long it was", async () => {
      const long = "x".repeat(900);
      const f = device({
        window: {
          stdout: [
            logLine(1790834324000, 100, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
            logLine(
              1790834324000,
              100,
              "E",
              "AndroidRuntime",
              "Process: com.example.notes, PID: 100",
            ),
            logLine(
              1790834324000,
              100,
              "E",
              "AndroidRuntime",
              `java.lang.IllegalStateException: ${long}`,
            ),
            logLine(
              1790834324000,
              100,
              "E",
              "AndroidRuntime",
              "\tat com.example.notes.Main.run(Main.kt:1)",
            ),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f);
      const crash = data.crash as Record<string, unknown>;
      expect(crash.message).toBe(`${"x".repeat(500)}... (truncated, 900 chars total)`);
    });
  });

  describe("a native crash and an ANR", () => {
    it.each(["35", "37"] as const)(
      "reads the tombstone and the ANR report of API %s",
      async (api) => {
        const text = [
          captured(api, "logcat-crash-native.txt"),
          captured(api, "logcat-anr-system.txt"),
        ].join("");
        const f = device({
          api: Number(api),
          markAt: api === "35" ? 1790834300 : 1790834170,
          window: { stdout: text },
        });
        const { toon, data } = await crashSince(f, "--pkg", "dev.probe");
        expect(toon.exitCode).toBe(0);
        expect(data.crashes).toBe(`2 since before-run (40 s, ${scanned(text)} lines scanned)`);
        const crashes = data.crash as Record<string, unknown>[];
        expect(crashes.map((c) => c.kind)).toEqual(["native", "anr"]);
        expect(crashes[0]).toMatchObject({
          process: "dev.probe",
          exception: "SIGSEGV",
          message: "signal 11 (SIGSEGV), code 0 (SI_USER), fault addr --------",
          app_frame: "dev.probe.MainActivity.dispatch+0 (base.apk)",
        });
        expect(crashes[1]).toMatchObject({
          process: "dev.probe",
          exception: "ANR",
          app_frame: "-",
          frames: 0,
        });
        expect(crashes[1]?.message).toContain("Input dispatching timed out");
        // Several crashes print as a table, one row each, with the same fields as a single one.
        expect(toon.stdout).toContain(
          "crash[2]{kind,at,process,exception,message,app_frame,frames}:",
        );
        expectClean(f);
      },
    );
  });

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

    it("counts every app's crash without --pkg, and none for a package that did not crash", async () => {
      const f = device({ window: { stdout: window } });
      const all = await crashSince(f);
      expect(all.data.crashes).toMatch(/^6 since before-run/);
      const none = await both(
        ["logs", "crash", "--since", "before-run", "--pkg", "com.example.never"],
        f,
      );
      expect(none.data.crashes).toMatch(/^0 since before-run/);
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
            logLine(1790834299900, 9386, "F", "libc", "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.probe), pid 9386 (dev.probe)"),
            logLine(1790834300200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(1790834300200, 9409, "F", "DEBUG", "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<"),
            logLine(1790834300200, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data).toEqual({ crashes: "0 since before-run (40 s, 3 lines scanned)" });
      expectClean(f);
    });

    it("keeps a tombstone in the window when its pid was reused by another process", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(1790834299900, 9386, "F", "libc", "Fatal signal 11 (SIGSEGV) in tid 9386 (dev.other), pid 9386 (dev.other)"),
            logLine(1790834300200, 9409, "F", "DEBUG", "*** *** *** ***"),
            logLine(1790834300200, 9409, "F", "DEBUG", "pid: 9386, tid: 9386, name: probe  >>> dev.probe <<<"),
            logLine(1790834300200, 9409, "F", "DEBUG", "signal 11 (SIGSEGV), code 0 (SI_USER)"),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toBe("1 since before-run (40 s, 3 lines scanned)");
      expect(data.crash).toMatchObject({ kind: "native", at: "2026-10-01 07:58:20.200" });
    });

    it("counts a crash at or after the mark", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(1790834300000, 100, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
            logLine(1790834300000, 100, "E", "AndroidRuntime", "Process: dev.probe, PID: 100"),
            logLine(
              1790834300000,
              100,
              "E",
              "AndroidRuntime",
              "java.lang.IllegalStateException: now",
            ),
          ].join("\n"),
        },
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toMatch(/^1 since before-run/);
    });

    it("says zero out loud, in one line, and still names the window", async () => {
      const f = device({
        clocks: ["1790834300.000000000 +0200\n", "1790834340.000000000 +0200\n"],
        window: { stdout: logLine(1790834310000, 1, "I", "Tag", "quiet") },
      });
      await runCli(["logs", "mark", "after-fix"], f.env);
      const toon = await runCli(
        ["logs", "crash", "--pkg", "dev.probe", "--since", "after-fix"],
        f.env,
      );
      expect(toon.exitCode).toBe(0);
      expect(toon.stdout).toBe('crashes: "0 since after-fix (40 s, 1 lines scanned)"\n');
      const json = await runCli(
        ["logs", "crash", "--pkg", "dev.probe", "--since", "after-fix", "--json"],
        f.env,
      );
      expect(JSON.parse(json.stdout)).toEqual({
        crashes: "0 since after-fix (40 s, 1 lines scanned)",
      });
      expectClean(f);
    });

    it("counts a duration back from the device clock, and defaults to 15 minutes", async () => {
      const f = device({
        clocks: ["1790835000.250000000 +0000\n"],
        window: { stdout: "" },

      });
      const seconds = await both(["logs", "crash", "--since", "30s"], f);
      expect(seconds.data.crashes).toBe("0 since 30s ago (30 s, 0 lines scanned)");
      const fallback = await both(["logs", "crash"], f);
      expect(fallback.data.crashes).toBe("0 since 15m ago (900 s, 0 lines scanned)");
      expectClean(f);
    });

    it("sends no --uid to an API 30 device, which does not have it", async () => {
      const text = readFileSync(join(FIXTURES_DIR, "synthetic/30/logcat-epoch-crash.txt"), "utf8");
      const f = device({
        api: 30,
        markAt: 1790834170,
        window: { stdout: text },
        // On API 30 a mark also records the app's processes.
        scenarioRules: [
          {
            match: ["-s", SERIAL, "shell", "ps -A -o PID,NAME"],
            respond: { stdoutFile: "synthetic/30/ps-pid-name.txt" },
          },
        ],
      });
      const { data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toMatch(/^1 since before-run/);
      expect(data.crash).toMatchObject({ process: "dev.probe", frames: 2 });
      for (const call of f.calls()) expect(call.argv.join(" ")).not.toContain("--uid");
      expectClean(f);
    });
  });

  describe("truncation and --full", () => {
    const loop = (n: number): string =>
      Array.from({ length: n }, (_, i) => [
        logLine(1790834310000 + i * 1000, 100 + i, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
        logLine(
          1790834310000 + i * 1000,
          100 + i,
          "E",
          "AndroidRuntime",
          `Process: dev.probe, PID: ${100 + i}`,
        ),
        logLine(
          1790834310000 + i * 1000,
          100 + i,
          "E",
          "AndroidRuntime",
          `java.lang.IllegalStateException: crash ${i}`,
        ),
        logLine(
          1790834310000 + i * 1000,
          100 + i,
          "E",
          "AndroidRuntime",
          `\tat dev.probe.Main.run(Main.kt:${i})`,
        ),
      ])
        .flat()
        .join("\n");

    it("describes the first five of a crash loop and counts the rest", async () => {
      const f = device({ window: { stdout: loop(7) } });
      const { toon, data } = await crashSince(f, "--pkg", "dev.probe");
      expect(data.crashes).toBe("7 since before-run (40 s, 28 lines scanned)");
      const crashes = data.crash as Record<string, unknown>[];
      expect(crashes.map((c) => c.message)).toEqual([0, 1, 2, 3, 4].map((i) => `crash ${i}`));
      expect(data.shown).toBe("5 of 7 crashes");
      expect(data.help).toEqual([
        "Run the same command with `--full` to write the whole trace to a file",
      ]);
      expect(toon.stdout).toContain("shown: 5 of 7 crashes");
    });

    it("writes the whole trace of every crash to a file, and prints its path", async () => {
      const text = [captured("35", "logcat-crash-java.txt"), loop(7)].join("");
      const f = device({ window: { stdout: text } });
      await runCli(["logs", "mark", "before-run"], f.env);
      const toon = await runCli(
        ["logs", "crash", "--pkg", "dev.probe", "--since", "before-run", "--full"],
        f.env,
      );
      expect(toon.exitCode).toBe(0);
      const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
      // The display is still capped; the file is not; the `--full` hint is gone.
      expect(data.shown).toBe("5 of 8 crashes");
      expect(data).not.toHaveProperty("help");
      const path = data.full as string;
      expect(path.startsWith(join(f.home, "out"))).toBe(true);
      const written = readFileSync(path, "utf8");
      expect(written.match(/^== java at /gm)).toHaveLength(8);
      expect(
        written.startsWith("== java at 2026-10-01 07:58:44.594 in dev.probe (pid 9328)\n"),
      ).toBe(true);
      // All 22 frames of the captured trace, which the output only counts.
      expect(written).toContain(
        "\tat com.android.internal.os.ZygoteInit.main(ZygoteInit.java:886)\n",
      );
      expect(written.match(/^\tat /gm)?.length).toBe(22 + 7);
      expect(written).toContain("java.lang.IllegalStateException: crash 6");
      expectClean(f);
    });

    it("gives the --full file the whole ANR block and a native tombstone", async () => {
      const f = device({
        api: 35,
        window: {
          stdout: [
            captured("35", "logcat-crash-native.txt"),
            captured("35", "logcat-anr-system.txt"),
          ].join(""),
        },
      });
      await runCli(["logs", "mark", "before-run"], f.env);
      const run = await runCli(["logs", "crash", "--since", "before-run", "--full"], f.env);
      const written = readFileSync(
        (decode(run.stdout.trimEnd()) as Record<string, unknown>).full as string,
        "utf8",
      );
      expect(written).toContain("== native at 2026-10-01 07:58:45.290 in dev.probe (pid 9386)\n");
      expect(written).toContain("backtrace:\n");
      expect(written).toContain("== anr at 2026-10-01 07:58:53.557 in dev.probe (pid 9448)\n");
      expect(written).toContain(
        "ANR in dev.probe (dev.probe/.MainActivity)\nPID: 9448\nReason: Input dispatching",
      );
    });

    it("keeps unrelated system-server activity out of an ANR's full trace", async () => {
      const f = device({
        window: {
          stdout: [
            logLine(1790834310000, 552, "E", "ActivityManager", "ANR in dev.probe"),
            logLine(1790834310000, 552, "E", "ActivityManager", "PID: 123"),
            logLine(1790834310000, 552, "E", "ActivityManager", "Reason: blocked"),
            logLine(1790834310001, 552, "E", "ActivityManager", "Reason: unrelated"),
          ].join("\n"),
        },
      });
      await runCli(["logs", "mark", "before-run"], f.env);
      const run = await runCli(["logs", "crash", "--since", "before-run", "--pkg", "dev.probe", "--full", "--json"], f.env);
      const data = JSON.parse(run.stdout) as Record<string, unknown>;
      expect(data.crash).toMatchObject({ message: "blocked" });
      expect(readFileSync(data.full as string, "utf8")).toContain("Reason: blocked");
      expect(readFileSync(data.full as string, "utf8")).not.toContain("Reason: unrelated");
    });

    it("writes an empty file and prints its path when there is no crash", async () => {
      const f = device({ window: { stdout: logLine(1790834310000, 1, "I", "Tag", "quiet") } });
      await runCli(["logs", "mark", "before-run"], f.env);
      const run = await runCli(["logs", "crash", "--since", "before-run", "--full"], f.env);
      const data = decode(run.stdout.trimEnd()) as Record<string, unknown>;
      expect(data.crashes).toBe("0 since before-run (40 s, 1 lines scanned)");
      expect(readFileSync(data.full as string, "utf8")).toBe("");
      expect(data).not.toHaveProperty("help");
    });

    it("gives overlapping --full runs separate files", async () => {
      const f = device({ window: { stdout: captured("35", "logcat-crash-java.txt") } });
      await runCli(["logs", "mark", "before-run"], f.env);
      const runs = await Promise.all([
        runCli(["logs", "crash", "--since", "before-run", "--full"], f.env),
        runCli(["logs", "crash", "--since", "before-run", "--full"], f.env),
      ]);
      const paths = runs.map(
        (run) => (decode(run.stdout.trimEnd()) as Record<string, unknown>).full as string,
      );
      expect(new Set(paths).size).toBe(2);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    });
  });

  describe("errors", () => {
    it("fails MARK_NOT_FOUND for an unknown mark, listing the marks the device has", async () => {
      const f = device({});
      await runCli(["logs", "mark", "before-save"], f.env);
      const { toon, data } = await both(["logs", "crash", "--since", "nope"], f);
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

    it("fails TIMEOUT at the deadline when logcat never returns, with no process left behind", async () => {
      const f = device({ window: { hang: true } });
      await runCli(["logs", "mark", "before-run"], f.env);
      const run = await runCli(
        ["logs", "crash", "--since", "before-run", "--timeout", "1s"],
        f.env,
      );
      expect(run.exitCode).toBe(1);
      expect(decode(run.stdout.trimEnd())).toMatchObject({
        code: "TIMEOUT",
        step: "reading the log",
      });
      expect(run.durationMs).toBeLessThan(5000);
    });
  });
});
