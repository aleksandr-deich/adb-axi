import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec, isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { UNMATCHED_EXIT, type Scenario } from "../fake-adb/scenario.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function setup(scenario: Scenario | string, baseDir?: string): FakeAdb {
  fake = createFakeAdb(scenario, baseDir === undefined ? {} : { baseDir });
  return fake;
}

function adb(f: FakeAdb, args: string[], deadlineMs = 10_000, tool = "adb") {
  return exec({ file: tool, args, env: f.env, deadlineMs });
}

describe("fake adb", () => {
  it("answers an exact argv and logs the call", async () => {
    const f = setup({
      rules: [{ match: ["devices", "-l"], respond: { stdout: "List of devices attached\n" } }],
    });
    const result = await adb(f, ["devices", "-l"]);
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("List of devices attached\n");
    const calls = f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "adb", argv: ["devices", "-l"], exit: 0, rule: 0 });
    expect(calls[0]?.end).not.toBeNull();
    expect(f.unmatched()).toEqual([]);
  });

  it("matches regex elements and a rest marker", async () => {
    const f = setup({
      rules: [
        {
          match: ["-s", { re: "emulator-\\d+" }, "shell", { rest: true }],
          respond: { stdout: "matched\n", stderr: "warn\n", exit: 3 },
        },
      ],
    });
    const result = await adb(f, ["-s", "emulator-5554", "shell", "pidof", "com.example"]);
    if (result.kind !== "exited") throw new Error(result.kind);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.toString()).toBe("matched\n");
    expect(result.stderr.toString()).toBe("warn\n");

    // A regex matches the whole element, not a substring.
    const miss = await adb(f, ["-s", "xemulator-5554", "shell"]);
    if (miss.kind !== "exited") throw new Error(miss.kind);
    expect(miss.exitCode).toBe(UNMATCHED_EXIT);
  });

  it("fails an unmatched call loudly and reports it", async () => {
    const f = setup({ rules: [] });
    const result = await adb(f, ["-s", "bogus", "logcat", "-d"]);
    if (result.kind !== "exited") throw new Error(result.kind);
    expect(result.exitCode).toBe(UNMATCHED_EXIT);
    expect(result.stderr.toString()).toContain(
      'FAKE_ADB_UNMATCHED adb ["-s","bogus","logcat","-d"]',
    );
    expect(f.unmatched().map((call) => call.argv)).toEqual([["-s", "bogus", "logcat", "-d"]]);
  });

  it("answers `times` times, then switches to `then`", async () => {
    const f = setup({
      rules: [
        {
          match: ["shell", "pidof", "com.example"],
          times: 3,
          respond: { stdout: "5120\n" },
          then: { exit: 1 },
        },
      ],
    });
    const outputs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await adb(f, ["shell", "pidof", "com.example"]);
      if (result.kind !== "exited") throw new Error(result.kind);
      outputs.push(`${result.exitCode}:${result.stdout.toString().trim()}`);
    }
    expect(outputs).toEqual(["0:5120", "0:5120", "0:5120", "1:", "1:"]);
  });

  it("skips a used-up rule without `then` and falls through", async () => {
    const f = setup({
      rules: [
        { match: ["get-state"], times: 1, respond: { stdout: "offline\n" } },
        { match: ["get-state"], respond: { stdout: "device\n" } },
      ],
    });
    const first = await adb(f, ["get-state"]);
    const second = await adb(f, ["get-state"]);
    expect(first.stdout.toString()).toBe("offline\n");
    expect(second.stdout.toString()).toBe("device\n");
  });

  it("drives rules from named state variables", async () => {
    const f = setup({
      state: { process: "foreground" },
      rules: [
        {
          match: ["shell", "input", "keyevent", "HOME"],
          set: { process: "cached" },
          respond: {},
        },
        {
          match: ["shell", "am", "kill", "com.example"],
          when: { process: "cached" },
          set: { process: "dead" },
          respond: {},
        },
        {
          match: ["shell", "am", "kill", "com.example"],
          when: { process: "foreground" },
          respond: {},
        },
        {
          match: ["shell", "pidof", "com.example"],
          when: { process: "dead" },
          respond: { exit: 1 },
        },
        { match: ["shell", "pidof", "com.example"], respond: { stdout: "5120\n" } },
      ],
    });
    await adb(f, ["shell", "am", "kill", "com.example"]);
    expect(f.vars()).toEqual({ process: "foreground" });
    expect((await adb(f, ["shell", "pidof", "com.example"])).stdout.toString()).toBe("5120\n");

    await adb(f, ["shell", "input", "keyevent", "HOME"]);
    await adb(f, ["shell", "am", "kill", "com.example"]);
    expect(f.vars()).toEqual({ process: "dead" });
    const after = await adb(f, ["shell", "pidof", "com.example"]);
    if (after.kind !== "exited") throw new Error(after.kind);
    expect(after.exitCode).toBe(1);
    expect(after.stdout.length).toBe(0);
  });

  it("copies stdoutFile bytes exactly", async () => {
    const base = mkdtempSync(join(tmpdir(), "adb-axi-bytes-"));
    const bytes = Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0x0a, 0x80]);
    writeFileSync(join(base, "blob.bin"), bytes);
    const f = setup(
      { rules: [{ match: ["exec-out", "cat", "x"], respond: { stdoutFile: "blob.bin" } }] },
      base,
    );
    const result = await adb(f, ["exec-out", "cat", "x"]);
    expect(Buffer.compare(result.stdout, bytes)).toBe(0);
  });

  it("delays an answer by delayMs", async () => {
    const f = setup({ rules: [{ match: ["version"], respond: { stdout: "v\n", delayMs: 300 } }] });
    const result = await adb(f, ["version"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });

  it("hangs like adb on a missing device until killed", async () => {
    const f = setup({
      rules: [{ match: ["-s", "bogus", "logcat", "-d"], respond: { hang: true } }],
    });
    const result = await adb(f, ["-s", "bogus", "logcat", "-d"], 600);
    expect(result.kind).toBe("timeout");
    expect(result.stderr.toString()).toBe("- waiting for device -\n");
    expect(result.durationMs).toBeLessThan(600 + 750);
    const [call] = f.calls();
    expect(call?.end).toBeNull();
    expect(call?.pid).toBeDefined();
    expect(isProcessAlive(call?.pid ?? 0)).toBe(false);
  });

  it("serves agent-device from the same scenario by tool", async () => {
    const f = setup({
      rules: [{ tool: "agent-device", match: ["snapshot", "--json"], respond: { stdout: "{}\n" } }],
    });
    const result = await adb(f, ["snapshot", "--json"], 10_000, "agent-device");
    expect(result.stdout.toString()).toBe("{}\n");
    expect(f.calls()[0]?.tool).toBe("agent-device");
    const asAdb = await adb(f, ["snapshot", "--json"]);
    if (asAdb.kind !== "exited") throw new Error(asAdb.kind);
    expect(asAdb.exitCode).toBe(UNMATCHED_EXIT);
  });

  it("records ANDROID_SERIAL and keeps it out of the environment by default", async () => {
    const f = setup({ rules: [{ match: ["get-serialno"], respond: { stdout: "x\n" } }] });
    expect(f.env.ANDROID_SERIAL).toBeUndefined();
    expect(f.env.ANDROID_HOME).toBeUndefined();
    await exec({
      file: "adb",
      args: ["get-serialno"],
      env: { ...f.env, ANDROID_SERIAL: "emulator-5556" },
      deadlineMs: 10_000,
    });
    expect(f.calls()[0]?.androidSerial).toBe("emulator-5556");
  });

  it("recovers a state lock left by a killed fake call", async () => {
    const f = setup({
      rules: [{ match: ["version"], respond: { stdout: "v\n" } }],
    });
    // An exited process cannot release a lock left behind at a command deadline.
    writeFileSync(`${f.env.FAKE_ADB_STATE}.lock`, "2147483647");
    const result = await adb(f, ["version"]);
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("v\n");
    expect(f.unmatched()).toEqual([]);
  });

  it("serializes state across concurrent calls", async () => {
    const f = setup({
      rules: [
        { match: ["shell", "true"], times: 10, respond: { stdout: "ok\n" }, then: { exit: 9 } },
      ],
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => adb(f, ["shell", "true"])));
    const codes = results.map((r) => (r.kind === "exited" ? r.exitCode : -1)).sort();
    expect(codes.filter((code) => code === 0)).toHaveLength(10);
    expect(codes.filter((code) => code === 9)).toHaveLength(2);
  });
});
