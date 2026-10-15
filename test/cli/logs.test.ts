import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { bindMarks, writeMark } from "../../src/commands/logs/marks.js";
import {} from "../../src/android/logcat.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

const A = "emulator-5554";
const B = "emulator-5556";

const CLOCK = "date '+%s.%N %z'";
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
  bootId?: string | null;
  /** Shell commands the device answers, besides facts; the clock is added by `device`. */
  shell?: Record<string, Response>;
  /** Clock answers in order; the last one answers every later call. */
  clocks?: string[];
}

function deviceRules(device: Device): Rule[] {
  const facts = `@sdk\n${device.api}\n@boot_completed\n1\n@boot_id\n${device.bootId === null ? "" : (device.bootId ?? "3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81")}\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n`;
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
    {
      match: ["-s", device.serial, "shell", "pm path --user 0 dev.probe"],
      respond: { stdout: "package:/data/app/probe/base.apk\n" },
    },
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
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
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

const fixture = (path: string): { stdoutFile: string } => ({ stdoutFile: path });
const PROBE_DUMP_35 = fixture("captured/35/dumpsys-package-debug.txt");
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
  it.each([true])(
    "does not use or delete unverified %s marks when the boot ID is unreadable",
    async (bound) => {
      const f = devices({
        serial: A,
        api: 35,
        bootId: null,
        shell: {
          "logcat -d -v epoch -T 1790833240.000": { stdout: "" },
        },
      });
      if (bound) bindMarks(A, f.env, "earlier-boot");
      writeMark(A, f.env, "old", { epochMs: 1790834110420, utcOffsetMinutes: -420, processes: [] });
      const path = join(f.home, A, "marks.json");
      const saved = readFileSync(path, "utf8");
      for (const args of [["logs"], ["logs", "crash"], ["wait", "log", "NEVERMATCH"]]) {
        const result = await runCli([...args, "--since", "old", "--json"], f.env);
        expect(JSON.parse(result.stdout)).toMatchObject({
          code: "MARK_UNVERIFIED",
          error: "log mark old could not be verified for this boot on emulator-5554",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("logs mark old");
        expect(result.stdout).toContain("--since 5m");
        expect(readFileSync(path, "utf8")).toBe(saved);
      }
      const duration = await runCli(["logs", "--since", "15m", "--json"], f.env);
      expect(duration.exitCode).toBe(0);
      expect(JSON.parse(duration.stdout)).toMatchObject({ counts: { matched: 0 } });
      const mark = await runCli(["logs", "mark", "new", "--json"], f.env);
      expect(JSON.parse(mark.stdout) as Record<string, unknown>).toMatchObject({
        code: "MARK_UNVERIFIED",
      });
      expect(readFileSync(path, "utf8")).toBe(saved);
    },
  );

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
  it.each([true])(
    "notes a late buffer start for an API 31+ uid scope from every app's first line (early other line: %s)",
    async (earlyOtherLine) => {
      const first = earlyOtherLine
        ? logLine(1790834701000, 1, "I", "System", "earlier")
        : logLine(1790834930000, 1, "I", "System", "first kept");
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [PACKAGE_DUMP]: PROBE_DUMP_35,
          [logcatFor("1790834700.000", 10213)]: {
            stdout: logLine(1790834950000, 2, "W", "Probe", "wanted"),
          },
          [`${logcatFor("1790834700.000")} -m 1`]: { stdout: first },
        },
      });
      const { toon, data } = await both(["logs", "--since", "5m", "--pkg", "dev.probe"], f);
      expect(toon.exitCode).toBe(0);
      expect(rowsOf(data)).toHaveLength(1);
      if (earlyOtherLine) expect(data).not.toHaveProperty("note");
      else
        expect(data.note).toBe(
          "first log line in this window is at 06:08:50.000, after the window start; the device log buffer may have dropped earlier lines",
        );
      // Only the app's own lines are scanned; the other app's line only dates the buffer.
      expect(data.window).toBe("5m ago -> now (300 s), 1 lines scanned");
      expect(logcatCommands(f)).toEqual([
        logcatFor("1790834700.000", 10213),
        `${logcatFor("1790834700.000")} -m 1`,
        logcatFor("1790834700.000", 10213),
        `${logcatFor("1790834700.000")} -m 1`,
      ]);
      expectClean(f);
    },
  );

  it.each([2000, 2001])(
    "notes a late first scanned line only beyond the 2s tolerance (%s ms)",
    async (gap) => {
      const f = devices({
        serial: A,
        api: 35,
        clocks: [MARK_CLOCK, LATER_CLOCK],
        shell: {
          [logcatFor(MARK_START)]: {
            stdout: logLine(1790834110420 + gap, 1, "I", "ProbeState", "ready"),
          },
        },
      });
      await runCli(["logs", "mark", "m"], f.env);
      const { toon, data } = await both(["logs", "--since", "m"], f);
      expect(toon.exitCode).toBe(0);
      if (gap > 2000) {
        expect(data.note).toBe(
          "first log line in this window is at 22:55:12.421, after the window start; the device log buffer may have dropped earlier lines",
        );
      } else expect(data).not.toHaveProperty("note");
      expectClean(f);
    },
  );

  describe("truncation", () => {
    it("applies a single-row byte cut to the displayed tag but not the full file", async () => {
      const tag = "T".repeat(5000);
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [logcatFor("1790834100.000")]: {
            stdout: logLine(1790834900000, 1, "E", tag, "original message"),
          },
        },
      });
      const { data } = await both(["logs"], f);
      const row = rowsOf(data)[0];
      expect(row).toBeDefined();
      expect(row?.tag?.length).toBeLessThan(tag.length);
      expect(row?.message).toBe("");
      expect(
        Buffer.byteLength(`${row?.time},${row?.level},${row?.tag},${row?.message}`),
      ).toBeLessThanOrEqual(4096);
      expect(data.shown).toEqual({
        rows: "1 of 1",
        lines: "1 matched",
        cut: expect.stringMatching(/^1 row at 4096 of \d+ bytes$/) as string,
      });
      const full = await runCli(["logs", "--full"], f.env);
      const path = (decode(full.stdout.trimEnd()) as Record<string, unknown>).full as string;
      expect(readFileSync(path, "utf8")).toContain(`${tag}: original message`);
    });
  });

  it("keeps the selected device in its help, and says which durations a duration-like value misses", async () => {
    const f = devices({ serial: A, api: 35 }, { serial: B, api: 35 });
    const { data } = await both(["logs", "--device", B, "--since", "nope"], f);
    expect(data.help).toEqual([`Run \`adb-axi logs mark nope --device ${B}\` to record it now`]);
    const typo = await both(["logs", "--device", B, "--since", "3potatoes"], f);
    expect(typo.data).toEqual({
      error: `no log mark named 3potatoes on ${B}`,
      code: "MARK_NOT_FOUND",
      marks: [],
      help: [
        "`3potatoes` is not a duration either: use a whole number with ms, s or m, for example `--since 30s` or `--since 5m`",
      ],
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
  it.each([true])(
    "ignores adbd command echoes but matches app logs (app line: %s)",
    async (appLine) => {
      const message = "logcat -d -v epoch";
      const f = devices({
        serial: A,
        api: 35,
        clocks: ["1790835000.000000000 +0000\n"],
        shell: {
          [logcatFor("1790835000.000")]: {
            stdout: [
              logLine(
                1790835000100,
                522,
                "I",
                "adbd",
                `adbd service requested 'shell,v2,TERM=xterm-256color,raw:${logcatFor("1790835000.000")}'`,
              ),
              ...(appLine ? [logLine(1790835000200, 1000, "I", "ProbeState", message)] : []),
            ].join("\n"),
          },
        },
      });
      const { toon, data } = await both(["wait", "log", message, "--timeout", "1s"], f);
      expect(toon.exitCode).toBe(appLine ? 0 : 1);
      if (appLine) expect(data.match).toMatchObject({ tag: "ProbeState", message });
      else expect(data.code).toBe("WAIT_TIMEOUT");
      expectClean(f);
    },
  );

  it("rejects a regex that does not compile with exit 2", async () => {
    const f = devices({ serial: A, api: 35 });
    const { stdout, exitCode } = await runCli(["wait", "log", "["], f.env);
    expect(exitCode).toBe(2);
    expect(decode(stdout.trimEnd())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shellCommands(f)).toEqual([]);
  });
});
