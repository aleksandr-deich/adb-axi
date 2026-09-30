import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { BIN_PATH, runCli } from "../helpers/run.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function withFake(scenario = "misplaced-device-flag.json"): FakeAdb {
  fake = createFakeAdb(scenario);
  return fake;
}

describe("adb-axi bin", () => {
  it.each(["--version", "-v", "-V"])("prints the bare version for %s", async (flag) => {
    const f = withFake();
    const { stdout, stderr, exitCode } = await runCli([flag], f.env);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(stderr).toBe("");
    expect(f.calls()).toEqual([]);
  });

  it("answers --version without loading the command graph", async () => {
    // A resolve hook reports every module the version path loads.
    const hook = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(
        "export async function resolve(s, c, next) { const r = await next(s, c); process.stderr.write('LOADED ' + r.url + '\\\\n'); return r; }"
      ));
    `)}`;
    const result = await exec({
      file: process.execPath,
      args: ["--import", hook, BIN_PATH, "--version"],
      deadlineMs: 20_000,
    });
    const loaded = result.stderr
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("LOADED "));
    expect(loaded.some((line) => line.includes("/dist/src/version.js"))).toBe(true);
    expect(loaded.filter((line) => line.includes("/dist/src/cli.js"))).toEqual([]);
    expect(loaded.filter((line) => line.includes("@toon-format"))).toEqual([]);
    expect(loaded.filter((line) => line.includes("axi-sdk-js/dist/index.js"))).toEqual([]);
  });

  it("answers --version about as fast as a bare node process", async () => {
    // AXI 10: measured against the `node -e` floor in the same process, not an absolute budget.
    const time = async (args: string[]): Promise<number> => {
      const result = await exec({ file: process.execPath, args, deadlineMs: 20_000 });
      expect(result.kind).toBe("exited");
      return result.durationMs;
    };
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Infinity;
    const floor: number[] = [];
    const version: number[] = [];
    await time(["-e", "console.log(1)"]);
    for (let i = 0; i < 7; i++) {
      floor.push(await time(["-e", "console.log(1)"]));
      version.push(await time([BIN_PATH, "--version"]));
    }
    const floorMs = median(floor);
    const versionMs = median(version);
    // The fast path costs little over the floor. The module-graph test above is the
    // deterministic guard; this one catches a slow import creeping into the leaf path.
    expect(versionMs).toBeLessThan(floorMs * 1.5 + 25);
  });

  it("rejects `-s <serial>` before the command with the corrected command and never calls adb", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["-s", "emulator-5554", "logs"], f.env);
    expect(exitCode).toBe(2);
    expect(stdout).toBe(
      [
        "error: `-s emulator-5554` must come after the command",
        "code: VALIDATION_ERROR",
        "help[1]: Run `adb-axi logs --device emulator-5554`",
        "",
      ].join("\n"),
    );
    expect(f.calls()).toEqual([]);
  });

  it("rejects the same misplaced flag in JSON with the same keys", async () => {
    const f = withFake();
    const toon = await runCli(["-s", "emulator-5554", "logs"], f.env);
    const json = await runCli(["--json", "-s", "emulator-5554", "logs"], f.env);
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    expect(Object.keys(JSON.parse(json.stdout) as object)).toEqual(["error", "code", "help"]);
    expect(f.calls()).toEqual([]);
  });

  it("exits 2 on an unknown flag and lists that command's valid flags", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["logs", "--bogus"], f.env);
    expect(exitCode).toBe(2);
    const error = decode(stdout.trimEnd()) as Record<string, unknown>;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.error).toBe("unknown flag --bogus for `adb-axi logs`");
    expect(error.valid_flags).toContain("--pkg <pkg>");
    expect(error.valid_flags).toContain("--device <serial|avd>");
    expect(f.calls()).toEqual([]);
  });

  it("exits 2 on an unknown command and lists the shipped commands", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["lease", "acquire"], f.env);
    expect(exitCode).toBe(2);
    const error = decode(stdout.trimEnd()) as Record<string, unknown>;
    expect(error).toMatchObject({ error: "unknown command `lease`", code: "VALIDATION_ERROR" });
    expect(error.commands).toContain("update");
    expect(error.commands).not.toContain("lease");
    expect(f.calls()).toEqual([]);
  });

  it("answers an unshipped command with NOT_IMPLEMENTED and never calls adb", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["app", "kill", "com.example.notes"], f.env);
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toEqual({
      error: "`adb-axi app kill` is not available in this build",
      code: "NOT_IMPLEMENTED",
      help: ["Run `adb-axi --help` to see the commands this build ships"],
    });
    expect(f.calls()).toEqual([]);
  });

  it("keeps unshipped commands out of --help", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["--help"], f.env);
    expect(exitCode).toBe(0);
    const help = decode(stdout.trimEnd()) as { commands: { command: string }[] };
    expect(help.commands.map((c) => c.command)).toEqual(["adb-axi update"]);
    const json = await runCli(["--json", "--help"], f.env);
    expect(JSON.parse(json.stdout)).toEqual(help);
  });

  it("routes bare --json to the home view", async () => {
    const f = withFake();
    const { stdout, exitCode } = await runCli(["--json"], f.env);
    // The home view is a stub until it ships; the JSON error proves the route.
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("prints progress-free stdout: nothing on stderr for usage errors", async () => {
    const f = withFake();
    const { stderr } = await runCli(["logs", "--bogus"], f.env);
    expect(stderr).toBe("");
  });
});
