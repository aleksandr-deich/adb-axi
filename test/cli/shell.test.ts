import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import {} from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
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
  expect(data).toEqual(joinedStreams(decode(toon.stdout.trimEnd())));
  return { toon, data };
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

describe("shell", () => {
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
          respond: { stderr: "error: closed\n", exit: 1 },
        },
      ],
    });
    const result = await runCli(["shell", "--json", "--", "sleep 30"], fake.env);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "DEVICE_OFFLINE",
      error: "emulator-5554 went offline while running the command",
    });
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
