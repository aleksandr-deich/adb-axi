import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import {} from "../../src/core/exec.js";
import { createFakeAdb, FIXTURES_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Response } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function withFake(scenario = "shell.json"): FakeAdb {
  fake = createFakeAdb(scenario);
  return fake;
}

/**
 * Run `shell` in both formats; they must carry the same data, field for field, apart from
 * the paths of `--full` files, which each run names afresh.
 */
async function both(
  f: FakeAdb,
  args: string[],
): Promise<{ toon: CliRun; data: Record<string, unknown> }> {
  const toon = await runCli(["shell", ...args], f.env);
  const json = await runCli(
    ["shell", ...args.slice(0, args.indexOf("--")), "--json", ...args.slice(args.indexOf("--"))],
    f.env,
  );
  expect(json.exitCode).toBe(toon.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(withoutPaths(data)).toEqual(withoutPaths(joinedStreams(decode(toon.stdout.trimEnd()))));
  return { toon, data };
}

function withoutPaths(data: unknown): unknown {
  const copy = { ...(data as Record<string, unknown>) };
  for (const key of ["full", "stderr_full"]) if (key in copy) copy[key] = typeof copy[key];
  return copy;
}

/** TOON lists a stream of several lines one per row; JSON keeps it as one string. */
function joinedStreams(decoded: unknown): unknown {
  const data = { ...(decoded as Record<string, unknown>) };
  for (const key of ["stdout", "stderr"]) {
    const value = data[key];
    if (Array.isArray(value)) data[key] = value.join("\n");
  }
  return data;
}

const DEVICES = "List of devices attached\nemulator-5554          device transport_id:1\n\n";

/** One online emulator answering each command with its response. */
function withOutputs(outputs: Record<string, Response>): FakeAdb {
  fake = createFakeAdb({
    synthetic: true,
    source:
      "Long am instrument -r transcripts under fixtures/instrument; the other output is made up",
    rules: [
      { match: ["devices", "-l"], respond: { stdout: DEVICES } },
      ...Object.entries(outputs).map(([command, respond]) => ({
        match: ["-s", "emulator-5554", "shell", command],
        respond,
      })),
    ],
  });
  return fake;
}

const fixtureLines = (file: string): string[] =>
  readFileSync(join(FIXTURES_DIR, file), "utf8").trimEnd().split("\n");

const rows = (stdout: unknown): string[] => String(stdout).split("\n");

const FAILED_RUN = "instrument/am-instrument-r-6-1fail.txt";
const PASSED_RUN = "instrument/am-instrument-r-3-pass.txt";

describe("shell", () => {
  it("shows the verdict at the end of a long am instrument run, and --full shows the rest of the end", async () => {
    const f = withOutputs({
      "am instrument -w -r failing": { stdoutFile: FAILED_RUN },
      "am instrument -w -r passing": { stdoutFile: PASSED_RUN },
    });
    const all = fixtureLines(FAILED_RUN);
    expect(all).toHaveLength(193);

    const { data } = await both(f, ["--", "am instrument -w -r failing"]);
    expect(data).toEqual({
      exit: 0,
      stdout: [...all.slice(0, 20), "... 143 lines omitted ...", ...all.slice(163)].join("\n"),
      shown: "50 of 193 lines (first 20 and last 30)",
      help: [
        "Run `adb-axi shell --device emulator-5554 --full -- 'am instrument -w -r failing'` to write the complete output to a file",
      ],
    });
    expect(rows(data.stdout).slice(-5)).toEqual([
      "FAILURES!!!",
      "Tests run: 6,  Failures: 1",
      "",
      "",
      "INSTRUMENTATION_CODE: -1",
    ]);

    const full = await both(f, ["--full", "--", "am instrument -w -r failing"]);
    expect(full.data).toMatchObject({
      exit: 0,
      stdout: ["... 143 lines omitted ...", ...all.slice(143)].join("\n"),
      shown: "50 of 193 lines (last 50)",
    });
    expect(full.data).not.toHaveProperty("help");
    expect(readFileSync(String(full.data.full), "utf8")).toBe(
      readFileSync(join(FIXTURES_DIR, FAILED_RUN), "utf8"),
    );

    const passed = fixtureLines(PASSED_RUN);
    const just = await both(f, ["--", "am instrument -w -r passing"]);
    expect(just.data).toMatchObject({
      stdout: [...passed.slice(0, 20), "... 1 line omitted ...", ...passed.slice(21)].join("\n"),
      shown: "50 of 51 lines (first 20 and last 30)",
    });
    expect(rows(just.data.stdout).slice(-4)).toEqual([
      "OK (3 tests)",
      "",
      "",
      "INSTRUMENTATION_CODE: -1",
    ]);
    expect(f.unmatched()).toEqual([]);
  });

  it("shows output inside the caps whole, with or without --full", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const f = withOutputs({ "seq 50": { stdout: `${fifty}\n` } });
    expect((await both(f, ["--", "seq 50"])).data).toEqual({ exit: 0, stdout: fifty });
    const full = await both(f, ["--full", "--", "seq 50"]);
    expect(full.data).toEqual({ exit: 0, stdout: fifty, full: full.data.full });
  });

  it("holds the 4 kB cap for long lines and still shows the last line, with or without --full", async () => {
    const long = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")}${"x".repeat(194)}`);
    const huge = `end${"y".repeat(99_997)}`;
    const f = withOutputs({
      "long 45": { stdout: `${long(45).join("\n")}\n` },
      // 200 kB: more than the end that --full reads back from its file.
      "long 1000": { stdout: `${long(1000).join("\n")}\n` },
      "huge last": { stdout: `a\nb\nc\n${huge}\n` },
    });
    const fits = (stdout: unknown): void => {
      const shown = rows(stdout).filter((row) => !row.endsWith(" omitted ..."));
      expect(Buffer.byteLength(shown.join("\n"))).toBeLessThanOrEqual(4096);
    };

    const window = (await both(f, ["--", "long 45"])).data;
    fits(window.stdout);
    expect(rows(window.stdout)[0]).toBe(long(45)[0]);
    expect(rows(window.stdout).at(-1)).toBe(long(45)[44]);
    expect(window.shown).toMatch(/^20 of 45 lines \(first \d+ and last \d+\)$/);

    const tail = (await both(f, ["--full", "--", "long 1000"])).data;
    fits(tail.stdout);
    expect(rows(tail.stdout)).toEqual(["... 980 lines omitted ...", ...long(1000).slice(980)]);
    expect(tail.shown).toBe("20 of 1000 lines (last 20)");

    const cut = (await both(f, ["--full", "--", "huge last"])).data;
    expect(cut.stdout).toBe(`... 3 lines omitted ...\n${huge.slice(0, 4096)}`);
    expect(cut.shown).toBe("1 of 4 lines (last 1), cut at 4096 of 100000 bytes");
  });

  it("still reports adb's own failure on the device, not a remote exit", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "echo gone"]);
    expect(data).toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });

  it("needs a command after --, as exit 2, without touching adb", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["shell"], f.env);
    expect(exitCode).toBe(2);
    expect(decode(stdout.trimEnd())).toMatchObject({
      error: "missing <cmd> for `adb-axi shell`",
      code: "VALIDATION_ERROR",
    });
    expect(f.calls()).toEqual([]);
  });

  it("rejects a device flag before the command with the corrected command line", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["-s", "emulator-5554", "shell", "--", "id"], f.env);
    expect(exitCode).toBe(2);
    expect(decode(stdout.trimEnd())).toMatchObject({
      help: ["Run `adb-axi shell --device emulator-5554 -- id`"],
    });
    expect(f.calls()).toEqual([]);
  });

  it("never echoes text after -- in a help line, even a misplaced device flag", async () => {
    const f = withFake("multi-device.json");
    const run = await runCli(["shell", "--", "cmd uimode night", "-s", "emulator-5554"], f.env);
    expect(run.exitCode).toBe(1);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      code: "DEVICE_AMBIGUOUS",
      help: [
        "Run `adb-axi shell --device <serial or avd> -- '<command>'`",
        "Or export ANDROID_SERIAL=<serial> in this shell",
      ],
    });
    const help = await runCli(["shell", "--help"], f.env);
    expect(help.stdout).toContain("Flags such as --device go before `--`");
  });

  it("names the serial only once when a command loses its device", async () => {
    fake = createFakeAdb({
      synthetic: true,
      state: { state: "online" },
      rules: [
        {
          match: ["devices", "-l"],
          when: { state: "online" },
          respond: { stdout: "List of devices attached\nemulator-5554 device\n" },
        },
        {
          match: ["devices", "-l"],
          when: { state: "offline" },
          respond: { stdout: "List of devices attached\nemulator-5554 offline\n" },
        },
        {
          match: ["-s", "emulator-5554", "shell", "sleep 30"],
          set: { state: "offline" },
          respond: { stdout: "x".repeat(100000), stderr: "error: closed\n", exit: 1 },
        },
      ],
    });
    const result = await runCli(["shell", "--json", "--", "sleep 30"], fake.env);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "DEVICE_OFFLINE",
      error: "emulator-5554 went offline while running the command",
    });
    fake.resetVars();
    const streamed = await runCli(["shell", "--full", "--json", "--", "sleep 30"], fake.env);
    expect(JSON.parse(streamed.stdout)).toMatchObject({ code: "DEVICE_OFFLINE" });
  });

  it("fails an offline device at once without sending the command", async () => {
    const f = withFake("multi-device.json");
    const { stdout, exitCode, durationMs } = await runCli(
      ["shell", "--device", "emulator-5558", "--", "id"],
      f.env,
    );
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({ code: "DEVICE_OFFLINE" });
    expect(durationMs).toBeLessThan(2000);
    expect(f.calls().some((call) => call.argv.includes("id"))).toBe(false);
  });

  it("fails with ADB_NOT_FOUND when there is no adb", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["shell", "--", "id"], {
      ...f.env,
      PATH: "/nonexistent-bin",
      HOME: f.dir,
    });
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({ code: "ADB_NOT_FOUND" });
  });
});
