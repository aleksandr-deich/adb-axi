import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, SCENARIOS_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Rule, Scenario } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";

const MARGIN_MS = 750;

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function withFake(scenario: string, extraRules: Rule[] = []): FakeAdb {
  if (extraRules.length === 0) {
    fake = createFakeAdb(scenario);
    return fake;
  }
  const base = JSON.parse(readFileSync(join(SCENARIOS_DIR, scenario), "utf8")) as Scenario;
  fake = createFakeAdb({ ...base, rules: [...base.rules, ...extraRules] });
  return fake;
}

/** `adb -s <serial> shell 'echo hi'` answered on each online emulator. */
const ECHO_RULES: Rule[] = ["emulator-5554", "emulator-5556"].map((serial) => ({
  match: ["-s", serial, "shell", "echo hi"],
  respond: { stdout: `hi from ${serial}\n` },
}));

/** Device calls after the device list, which must all carry `-s <serial>`. */
function deviceCalls(f: FakeAdb): string[][] {
  return f
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[0] !== "devices");
}

describe("device selection through a command", () => {
  it("fails with DEVICE_AMBIGUOUS when two devices are online and none is selected", async () => {
    const f = withFake("multi-device.json");
    const toon = await runCli(["logs", "--pkg", "com.example.notes"], f.env);
    expect(toon.exitCode).toBe(1);
    expect(toon.stdout).toMatchInlineSnapshot(`
      "error: 2 devices are online and none is selected
      code: DEVICE_AMBIGUOUS
      devices[2]{serial,avd,form}:
        emulator-5554,Pixel_10_Pro_XL,phone
        emulator-5556,Pixel_Tablet,tablet
      help[2]: Run \`adb-axi logs --pkg com.example.notes --device <serial or avd>\`,Or export ANDROID_SERIAL=<serial> in this shell
      "
    `);
    const json = await runCli(["logs", "--pkg", "com.example.notes", "--json"], f.env);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    for (const argv of deviceCalls(f)) expect(argv[0]).toBe("-s");
    expect(f.unmatched()).toEqual([]);
  });

  it("targets a device by AVD name and by serial", async () => {
    const f = withFake("multi-device.json", ECHO_RULES);
    for (const selector of ["Pixel_Tablet", "emulator-5556"]) {
      const { stdout, exitCode } = await runCli(
        ["shell", "--device", selector, "--", "echo hi"],
        f.env,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("hi from emulator-5556");
    }
    const viaEnv = await runCli(["shell", "--", "echo hi"], {
      ...f.env,
      ANDROID_SERIAL: "emulator-5554",
    });
    expect(viaEnv.stdout).toContain("hi from emulator-5554");
    expect(f.unmatched()).toEqual([]);
  });

  it("fails an offline target at once, never calling it", async () => {
    const f = withFake("hang-missing-offline.json");
    const { stdout, exitCode, durationMs } = await runCli(["logs", "-s", "emulator-5556"], f.env);
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toEqual({
      error: "emulator-5556 is offline",
      code: "DEVICE_OFFLINE",
      state: "offline",
      help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
    });
    expect(durationMs).toBeLessThan(2000);
    expect(f.calls().map((call) => call.argv)).toEqual([["devices", "-l"]]);
  });

  it("fails a missing serial with DEVICE_NOT_FOUND instead of hanging", async () => {
    const f = withFake("multi-device.json");
    const { stdout, exitCode, durationMs } = await runCli(
      ["shell", "--device", "bogus-9999", "--", "echo", "hi"],
      f.env,
    );
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({
      error: "no attached device has the serial or AVD name bogus-9999",
      code: "DEVICE_NOT_FOUND",
    });
    expect(durationMs).toBeLessThan(2000);
    expect(f.calls().some((call) => call.argv[1] === "bogus-9999")).toBe(false);
  });

  it("kills a hung device call at --timeout and leaves no process behind", async () => {
    const f = withFake("hang-missing-offline.json");
    const { stdout, exitCode, durationMs } = await runCli(
      ["logs", "--device", "Pixel_10_Pro_XL", "--timeout", "1s"],
      f.env,
    );
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({
      error: "reading the AVD name of emulator-5556 did not finish before the 1 s deadline",
      code: "TIMEOUT",
      step: "reading the AVD name of emulator-5556",
    });
    expect(durationMs).toBeLessThan(1000 + MARGIN_MS + 500);
    for (const call of f.calls()) {
      expect(isProcessAlive(call.pid)).toBe(false);
      if (call.end !== null) expect(call.end - call.start).toBeLessThan(1000 + MARGIN_MS);
    }
  });

  it("prints every adb argv on stderr with --debug, and nothing else", async () => {
    const f = withFake("one-online.json", ECHO_RULES);
    const { stdout, stderr } = await runCli(["shell", "--debug", "--", "echo hi"], f.env);
    expect(stdout).toContain("hi from emulator-5554");
    expect(stderr.split("\n")[0]).toBe("debug: adb devices -l");
    expect(stderr).toContain("debug: adb -s emulator-5554 shell 'echo hi'");
    const quiet = await runCli(["shell", "--", "echo hi"], f.env);
    expect(quiet.stderr).toBe("");
  });

  it("fails with ADB_NOT_FOUND listing the places searched when there is no adb", async () => {
    const f = withFake("one-online.json");
    const home = mkdtempSync(join(tmpdir(), "adb-axi-nohome-"));
    const { stdout, exitCode } = await runCli(["logs"], {
      ...f.env,
      PATH: "/nonexistent-bin",
      HOME: home,
    });
    expect(exitCode).toBe(1);
    const error = decode(stdout.trimEnd()) as Record<string, unknown>;
    expect(error).toMatchObject({ error: "adb was not found", code: "ADB_NOT_FOUND" });
    expect(error.searched).toEqual([
      "PATH (1 directories)",
      "$ANDROID_HOME/platform-tools ($ANDROID_HOME is not set)",
      "$ANDROID_SDK_ROOT/platform-tools ($ANDROID_SDK_ROOT is not set)",
      join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    ]);
    expect(f.calls()).toEqual([]);
  });

  it("never touches adb for commands that need no device, or for usage errors", async () => {
    const f = withFake("multi-device.json");
    await runCli(["--help"], f.env);
    await runCli(["logs", "--bogus"], f.env);
    await runCli(["-s", "emulator-5554", "logs"], f.env);
    expect(f.calls()).toEqual([]);
  });

  it("keeps per-device state apart for two devices", async () => {
    const f = withFake("multi-device.json");
    await runCli(["logs"], f.env);
    const cached = (serial: string): unknown =>
      JSON.parse(readFileSync(join(f.home, serial, "avd.json"), "utf8"));
    expect(readdirSync(f.home).sort()).toEqual(["emulator-5554", "emulator-5556"]);
    expect(cached("emulator-5554")).toEqual({
      boot_id: "3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81",
      avd: "Pixel_10_Pro_XL",
    });
    expect(cached("emulator-5556")).toMatchObject({ avd: "Pixel_Tablet" });

    // A second run reads the names from the cache instead of the emulator console.
    const before = f.calls().filter((call) => call.argv[2] === "emu").length;
    await runCli(["logs"], f.env);
    expect(f.calls().filter((call) => call.argv[2] === "emu").length).toBe(before);
  });
});
