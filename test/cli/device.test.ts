import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../../src/core/exec.js";
import { deviceStateDir, writeJsonAtomic } from "../../src/core/state.js";
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

/** Device calls after the device list, which must all carry `-s <serial>`. */
function deviceCalls(f: FakeAdb): string[][] {
  return f
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[0] !== "devices");
}

/** A phone online, and a tablet going down: offline, with a console that no longer answers. */
function tabletGoingDown(tabletConsole: Rule["respond"], onlineFirst = false): FakeAdb {
  fake = createFakeAdb({
    description: "An online phone and an offline emulator whose console is gone",
    synthetic: true,
    rules: [
      ...(onlineFirst
        ? [
            {
              match: ["devices", "-l"],
              times: 1,
              respond: {
                stdout: "List of devices attached\nemulator-5554 device\nemulator-5556 device\n",
              },
            },
          ]
        : []),
      {
        match: ["devices", "-l"],
        respond: {
          stdout:
            "List of devices attached\nemulator-5554          device transport_id:1\nemulator-5556          offline transport_id:2\n\n",
        },
      },
      {
        match: ["-s", "emulator-5554", "shell", { re: "echo @sdk; .*" }],
        respond: {
          stdout:
            "@sdk\n37\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n",
        },
      },
      {
        match: ["-s", "emulator-5554", "emu", "avd", "name"],
        respond: { stdout: "Pixel_10_Pro_XL\r\nOK\r\n" },
      },
      { match: ["-s", "emulator-5556", "emu", "avd", "name"], respond: tabletConsole },
      {
        match: ["-s", "emulator-5556", "shell", "getprop ro.boot.qemu.avd_name"],
        respond: { stdout: "" },
      },
    ],
  });
  // What adb-axi cached when it last saw the tablet online.
  writeJsonAtomic(join(deviceStateDir("emulator-5556", fake.env), "avd.json"), {
    boot_id: "9b0e7d44-51a2-4c3e-8f6d-2c1b0a9e8d77",
    avd: "medium_tablet",
  });
  return fake;
}

describe("an offline emulator's last-known AVD name", () => {
  const GONE = {
    stderr: "error: could not connect to TCP port 5557: Connection refused\n",
    exit: 1,
  };

  it("selects it by that name as DEVICE_OFFLINE, saying the name is the last known one", async () => {
    const f = tabletGoingDown(GONE);
    const toon = await runCli(["logs", "--device", "medium_tablet"], f.env);
    expect(toon.exitCode).toBe(1);
    const json = await runCli(["logs", "--device", "medium_tablet", "--json"], f.env);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    expect(JSON.parse(json.stdout)).toEqual({
      error: "emulator-5556 (last known as medium_tablet) is offline",
      code: "DEVICE_OFFLINE",
      state: "offline",
      avd: "medium_tablet (last known)",
      help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
    });
    expect(f.unmatched()).toEqual([]);
  });

  it.each([{ command: ["logs"] }])(
    "rechecks a device that went offline during name resolution: $command",
    async ({ command }) => {
      const f = tabletGoingDown(GONE, true);
      const result = await runCli(
        [
          ...command,
          "--device",
          "medium_tablet",
          "--json",
          ...(command[0] === "shell" ? ["--", "echo hi"] : []),
        ],
        f.env,
      );
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      if (command.length === 0) {
        expect(data.target_note).toBe("emulator-5556 (last known as medium_tablet) is offline");
      } else {
        expect(data.code).toBe("DEVICE_OFFLINE");
        expect(result.exitCode).toBe(1);
      }
    },
  );

  it("labels it in the device list and in a DEVICE_NOT_FOUND table", async () => {
    const f = tabletGoingDown(GONE);
    const listed = decode((await runCli(["devices"], f.env)).stdout.trimEnd()) as {
      devices: unknown[];
    };
    expect(listed.devices).toEqual([
      { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", state: "device", api: 37, form: "phone" },
      {
        serial: "emulator-5556",
        avd: "medium_tablet (last known)",
        state: "offline",
        api: "-",
        form: "-",
      },
    ]);
    const missing = await runCli(["logs", "--device", "Pixel_Fold"], f.env);
    expect(decode(missing.stdout.trimEnd())).toMatchObject({
      code: "DEVICE_NOT_FOUND",
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", state: "device" },
        { serial: "emulator-5556", avd: "medium_tablet (last known)", state: "offline" },
      ],
    });
  });

  it("reports multiple offline last-known matches as ambiguous with serial guidance", async () => {
    fake = createFakeAdb({
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout:
              "List of devices attached\nemulator-5554          offline transport_id:1\nemulator-5556          offline transport_id:2\n\n",
          },
        },
        ...["emulator-5554", "emulator-5556"].flatMap((serial) => [
          { match: ["-s", serial, "emu", "avd", "name"], respond: GONE },
          {
            match: ["-s", serial, "shell", "getprop ro.boot.qemu.avd_name"],
            respond: { stdout: "" },
          },
        ]),
      ],
    });
    const f = fake;
    for (const serial of ["emulator-5554", "emulator-5556"]) {
      writeJsonAtomic(join(deviceStateDir(serial, f.env), "avd.json"), {
        boot_id: "9b0e7d44-51a2-4c3e-8f6d-2c1b0a9e8d77",
        avd: "medium_tablet",
      });
    }
    const toon = await runCli(["logs", "--device", "medium_tablet"], f.env);
    const json = await runCli(["logs", "--device", "medium_tablet", "--json"], f.env);
    expect(toon.exitCode).toBe(1);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    expect(JSON.parse(json.stdout)).toEqual({
      error: "2 unavailable emulators were last known as medium_tablet",
      code: "DEVICE_AMBIGUOUS",
      devices: [
        { serial: "emulator-5554", avd: "medium_tablet (last known)", form: "-" },
        { serial: "emulator-5556", avd: "medium_tablet (last known)", form: "-" },
      ],
      help: ["Run `adb-axi logs --device <serial>` to pick one by serial"],
    });
    expect(f.unmatched()).toEqual([]);
    expect(
      deviceCalls(f).every(
        (argv) =>
          argv[2] === "emu" || (argv[2] === "shell" && argv[3] === "getprop ro.boot.qemu.avd_name"),
      ),
    ).toBe(true);
  });

  it("does not label an online emulator with a previous occupant's name when its console fails", async () => {
    fake = createFakeAdb({
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout: "List of devices attached\nemulator-5556          device transport_id:2\n\n",
          },
        },
        {
          match: ["-s", "emulator-5556", "shell", { re: "echo @sdk; .*" }],
          respond: {
            stdout:
              "@sdk\n37\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n",
          },
        },
        {
          match: ["-s", "emulator-5556", "emu", "avd", "name"],
          respond: { stderr: "console unavailable", exit: 1 },
        },
        {
          match: ["-s", "emulator-5556", "shell", "getprop ro.boot.qemu.avd_name"],
          respond: { stdout: "" },
        },
      ],
    });
    const f = fake;
    writeJsonAtomic(join(deviceStateDir("emulator-5556", f.env), "avd.json"), {
      boot_id: "9b0e7d44-51a2-4c3e-8f6d-2c1b0a9e8d77",
      avd: "medium_tablet",
    });
    const listed = await runCli(["devices", "--json"], f.env);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      devices: [{ serial: "emulator-5556", avd: "-", state: "device" }],
    });
    const missing = await runCli(["logs", "--device", "not_here", "--json"], f.env);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      code: "DEVICE_NOT_FOUND",
      devices: [{ serial: "emulator-5556", avd: "-", state: "device" }],
    });
    expect(f.unmatched()).toEqual([]);
  });

  it("never claims the old name for a serial whose console now names another AVD", async () => {
    const f = tabletGoingDown({ stdout: "Pixel_Fold\r\nOK\r\n" });
    const run = await runCli(["logs", "--device", "medium_tablet"], f.env);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      code: "DEVICE_NOT_FOUND",
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", state: "device" },
        { serial: "emulator-5556", avd: "Pixel_Fold", state: "offline" },
      ],
    });
    const byNew = await runCli(["logs", "--device", "Pixel_Fold"], f.env);
    expect(decode(byNew.stdout.trimEnd())).toMatchObject({ code: "DEVICE_OFFLINE" });
  });
});

describe("device selection through a command", () => {
  it("refuses a lone physical device until it is explicitly selected", async () => {
    const serial = "physical-test-serial";
    fake = createFakeAdb({
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: { stdout: `List of devices attached\n${serial} device\n` },
        },
        {
          match: ["-s", serial, "shell", "getprop sys.boot_completed"],
          respond: { stdout: "1\n" },
        },
      ],
    });
    const refused = await runCli(["shell", "--", "getprop sys.boot_completed"], fake.env);
    expect(refused.exitCode).toBe(1);
    expect(decode(refused.stdout.trimEnd())).toEqual({
      error: `physical device ${serial} requires explicit selection; pass --device ${serial}`,
      code: "DEVICE_SELECTION_REQUIRED",
      serial,
      help: [`Run \`adb-axi shell --device ${serial} -- '<command>'\``],
    });
    expect(fake.calls().map((call) => call.argv)).toEqual([["devices", "-l"]]);

    for (const flag of ["--device", "-s"]) {
      const selected = await runCli(
        ["shell", flag, serial, "--", "getprop sys.boot_completed"],
        fake.env,
      );
      expect(selected.exitCode).toBe(0);
      expect(decode(selected.stdout.trimEnd())).toEqual({ exit: 0, stdout: "1" });
    }
    const fromEnv = await runCli(["shell", "--", "getprop sys.boot_completed"], {
      ...fake.env,
      ANDROID_SERIAL: serial,
    });
    expect(fromEnv.exitCode).toBe(0);
    expect(decode(fromEnv.stdout.trimEnd())).toEqual({ exit: 0, stdout: "1" });
    expect(fake.unmatched()).toEqual([]);
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

  it("kills a hung device call at --timeout and leaves no process behind", async () => {
    const f = withFake("hang-missing-offline.json");
    const { stdout, exitCode, durationMs } = await runCli(
      ["logs", "--device", "Pixel_10_Pro_XL", "--timeout", "1s"],
      f.env,
    );
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({
      error:
        "reading the AVD name property of emulator-5556 did not finish before the 1 s deadline",
      code: "TIMEOUT",
      step: "reading the AVD name property of emulator-5556",
    });
    expect(durationMs).toBeLessThan(1000 + MARGIN_MS + 500);
    for (const call of f.calls()) {
      expect(isProcessAlive(call.pid)).toBe(false);
      if (call.end !== null) expect(call.end - call.start).toBeLessThan(1000 + MARGIN_MS);
    }
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
});
