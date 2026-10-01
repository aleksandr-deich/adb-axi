import { existsSync, readFileSync } from "node:fs";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { runCli, type CliRun } from "../helpers/run.js";

const MARGIN_MS = 750;

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function withFake(scenario = "shell.json"): FakeAdb {
  fake = createFakeAdb(scenario);
  return fake;
}

/** Run `shell` in both formats; they must carry the same data, field for field. */
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
  expect(data).toEqual(decode(toon.stdout.trimEnd()));
  return { toon, data };
}

describe("shell", () => {
  it("prints the exit code and stdout of a command", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--", "getprop ro.build.version.sdk"]);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toBe('exit: 0\nstdout: "36"\n');
    expect(data).toEqual({ exit: 0, stdout: "36" });
    expect(f.unmatched()).toEqual([]);
  });

  it("runs the command through shell_v2 on the resolved device, never legacy shell (S2)", async () => {
    const f = withFake();
    await runCli(["shell", "--", "getprop ro.build.version.sdk"], f.env);
    expect(f.calls().map((call) => call.argv)).toEqual([
      ["devices", "-l"],
      ["-s", "emulator-5554", "shell", "getprop ro.build.version.sdk"],
    ]);
  });

  it("joins several words after -- into one command string", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "ls", "-la", "/data/local/tmp"]);
    expect(data).toEqual({ exit: 0, stdout: "total 0" });
  });

  it("leaves --json after -- to the remote command", async () => {
    const f = withFake();
    const toon = await runCli(["shell", "--", "echo", "--json"], f.env);
    expect(toon.stdout).toBe('exit: 0\nstdout: "--json"\n');
  });

  it("prints an empty stdout explicitly", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--", "true"]);
    expect(toon.stdout).toBe('exit: 0\nstdout: ""\n');
    expect(data).toEqual({ exit: 0, stdout: "" });
  });

  it("keeps stderr of a successful command apart from stdout", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "echo warn >&2"]);
    expect(data).toEqual({ exit: 0, stdout: "", stderr: "warn" });
  });

  it("fails a non-zero remote exit with REMOTE_EXIT, exit 1, carrying exit and stderr", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--", "ls /data/local/tmp/missing"]);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toBe(
      [
        "error: remote command exited 1",
        "code: REMOTE_EXIT",
        "exit: 1",
        'stderr: "ls: /data/local/tmp/missing: No such file or directory"',
        "",
      ].join("\n"),
    );
    expect(data).toEqual({
      error: "remote command exited 1",
      code: "REMOTE_EXIT",
      exit: 1,
      stderr: "ls: /data/local/tmp/missing: No such file or directory",
    });
  });

  it("reports the real exit code and both streams of a failing command", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--", "echo out; echo err >&2; exit 3"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: "remote command exited 3",
      code: "REMOTE_EXIT",
      exit: 3,
      stdout: "out",
      stderr: "err",
    });
  });

  it("reports remote output that reads like an adb error as the remote command's own failure", async () => {
    const f = withFake();
    const { data } = await both(f, [
      "--",
      "echo 'Device offline'; echo 'more than one device' >&2; exit 3",
    ]);
    expect(data).toEqual({
      error: "remote command exited 3",
      code: "REMOTE_EXIT",
      exit: 3,
      stdout: "Device offline",
      stderr: "more than one device",
    });
  });

  it.each([
    ["error: device unauthorized.", 4, "", "echo 'error: device unauthorized.' >&2; exit 4"],
    [
      "adb: error: failed to check server version: cannot connect to daemon",
      2,
      "",
      "echo 'adb: error: failed to check server version: cannot connect to daemon' >&2; exit 2",
    ],
    [
      "error: no devices/emulators found",
      1,
      "out",
      "echo out; echo 'error: no devices/emulators found' >&2; exit 1",
    ],
  ])(
    "reports remote stderr copying adb's line %j as the remote exit %i",
    async (stderr, exit, stdout, command) => {
      const f = withFake();
      const { data } = await both(f, ["--", command]);
      expect(data).toEqual({
        error: `remote command exited ${exit}`,
        code: "REMOTE_EXIT",
        exit,
        ...(stdout === "" ? {} : { stdout }),
        stderr,
      });
    },
  );

  it("still reports adb's own failure on the device, not a remote exit", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "echo gone"]);
    expect(data).toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });

  it("prints an empty stderr for a silent failure", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "false"]);
    expect(data).toEqual({
      error: "remote command exited 1",
      code: "REMOTE_EXIT",
      exit: 1,
      stderr: "",
    });
  });

  it("stops at 50 lines, says how many there were, and points at --full", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--", "seq 1 120"]);
    expect(toon.exitCode).toBe(0);
    const lines = (data.stdout as string).split("\n");
    expect(lines).toHaveLength(50);
    expect(lines.at(-1)).toBe("50");
    expect(data.shown).toBe("50 of 120 lines");
    expect(data.help).toEqual([
      "Run `adb-axi shell --device emulator-5554 --full -- 'seq 1 120'` to write the complete output to a file",
    ]);
  });

  it("stops at 4 kB even when there are fewer than 50 lines", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "cat /data/local/tmp/wide"]);
    const shown = (data.stdout as string).split("\n").length;
    expect(shown).toBeLessThan(30);
    expect(Buffer.byteLength(data.stdout as string)).toBeLessThanOrEqual(4096);
    expect(data.shown).toBe(`${shown} of 30 lines`);
  });

  it("says how much of a single line longer than 4 kB is shown", async () => {
    const f = withFake();
    const { data } = await both(f, ["--", "cat /data/local/tmp/config.json"]);
    expect(Buffer.byteLength(data.stdout as string)).toBe(4096);
    expect(data.shown).toBe("1 of 1 lines, cut at 4096 of 5011 bytes");
  });

  it("keeps the given --timeout in the --full hint", async () => {
    const f = withFake();
    const { data } = await both(f, ["--timeout", "60s", "--", "seq 1 120"]);
    expect(data.help).toEqual([
      "Run `adb-axi shell --device emulator-5554 --timeout 60s --full -- 'seq 1 120'` to write the complete output to a file",
    ]);
  });

  it("writes the complete output to a file with --full and prints its path", async () => {
    const f = withFake();
    const toon = await runCli(["shell", "--full", "--", "seq 1 120"], f.env);
    const data = decode(toon.stdout.trimEnd()) as Record<string, string>;
    expect(data.shown).toBe("50 of 120 lines");
    expect(data).not.toHaveProperty("help");
    const full = data.full ?? "";
    expect(full.startsWith(f.home)).toBe(true);
    expect(full).toMatch(/shell-emulator-5554-\d{6}-stdout\.txt$/);
    const written = readFileSync(full, "utf8").split("\n");
    expect(written.slice(0, 120)).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)));

    const json = await runCli(["shell", "--full", "--json", "--", "seq 1 120"], f.env);
    const parsed = JSON.parse(json.stdout) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(Object.keys(data));
    expect(existsSync(parsed.full ?? "")).toBe(true);
  });

  it("truncates and saves stdout and stderr of a failure separately", async () => {
    const f = withFake();
    const toon = await runCli(
      ["shell", "--full", "--", "cat /data/local/tmp/noisy; exit 2"],
      f.env,
    );
    expect(toon.exitCode).toBe(1);
    const data = decode(toon.stdout.trimEnd()) as Record<string, string>;
    expect(data).toMatchObject({
      code: "REMOTE_EXIT",
      exit: 2,
      shown: "50 of 60 lines",
      stderr_shown: "50 of 60 lines",
    });
    expect(readFileSync(data.stderr_full ?? "", "utf8")).toContain("warn 60");
    expect(readFileSync(data.full ?? "", "utf8")).toContain("line 60");
    expect(data.stdout).not.toContain("line 51");
  });

  it("fails with TIMEOUT at the deadline, keeps the partial output and kills the call", async () => {
    const f = withFake();
    const { toon, data } = await both(f, ["--timeout", "1s", "--", "sleep 30"]);
    expect(toon.exitCode).toBe(1);
    expect(data).toEqual({
      error: "running the command on emulator-5554 did not finish before the 1 s deadline",
      code: "TIMEOUT",
      step: "running the command on emulator-5554",
      stdout: "starting",
      stderr: "still waiting",
      help: ["Run the same command with a longer `--timeout`, for example `--timeout 60s`"],
    });
    expect(toon.durationMs).toBeLessThan(1000 + MARGIN_MS + 500);
    for (const call of f.calls()) {
      expect(isProcessAlive(call.pid)).toBe(false);
    }
  });

  it("truncates partial output of a timed-out command too", async () => {
    const f = withFake();
    const { data } = await both(f, ["--timeout", "1s", "--", "sleep 30; seq 1 80"]);
    expect(data.code).toBe("TIMEOUT");
    expect((data.stdout as string).split("\n")).toHaveLength(50);
    expect(data.shown).toBe("50 of 80 lines");
    expect(data.help).toEqual([
      "Run the same command with a longer `--timeout`, for example `--timeout 60s`",
      "Run `adb-axi shell --device emulator-5554 --timeout 1s --full -- 'sleep 30; seq 1 80'` to write the complete output to a file",
    ]);
  });

  it("does not point at --full on a timeout that already has it", async () => {
    const f = withFake();
    const toon = await runCli(
      ["shell", "--full", "--timeout", "1s", "--", "sleep 30; seq 1 80"],
      f.env,
    );
    const data = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    expect(data.code).toBe("TIMEOUT");
    expect(data.shown).toBe("50 of 80 lines");
    expect(existsSync(data.full as string)).toBe(true);
    expect(data.help).toEqual([
      "Run the same command with a longer `--timeout`, for example `--timeout 60s`",
    ]);
  });

  it("uses a 15 s default deadline", async () => {
    const f = withFake();
    const help = await runCli(["shell", "--help"], f.env);
    expect(help.stdout).toContain("--timeout <dur>");
    expect(help.stdout).toContain("15s");
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

  it("refuses to guess between two online devices, and runs on the one chosen", async () => {
    const f = withFake("multi-device.json");
    const ambiguous = await runCli(["shell", "--", "id"], f.env);
    expect(ambiguous.exitCode).toBe(1);
    expect(decode(ambiguous.stdout.trimEnd())).toMatchObject({
      code: "DEVICE_AMBIGUOUS",
      help: [
        "Run `adb-axi shell --device <serial or avd> -- id`",
        "Or export ANDROID_SERIAL=<serial> in this shell",
      ],
    });
    expect(f.calls().some((call) => call.argv.includes("id"))).toBe(false);
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

  it("fails with DEVICE_NOT_FOUND for a serial that is not attached", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["shell", "-s", "emulator-9999", "--", "id"], f.env);
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({
      code: "DEVICE_NOT_FOUND",
      help: ["Run `adb-axi shell --device <serial or avd> -- id` with one of the devices above"],
    });
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

  it("is listed in help with its examples", async () => {
    const f = withFake();
    const top = await runCli(["--help"], f.env);
    expect(top.stdout).toContain("adb-axi shell");
    const help = await runCli(["shell", "--help"], f.env);
    expect(help.stdout).toContain("--full");
    expect(help.stdout).toContain("adb-axi shell -- 'getprop ro.build.version.sdk'");
    expect(f.calls()).toEqual([]);
  });
});
