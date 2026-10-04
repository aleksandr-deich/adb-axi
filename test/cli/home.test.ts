import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMark } from "../../src/commands/logs/marks.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { unrunnableCommands } from "../helpers/help-lines.js";
import { runCli, type CliRun } from "../helpers/run.js";

// Parity cases run the CLI twice.
vi.setConfig({ testTimeout: 40_000 });

const SERIAL = "emulator-5554";
const CLOCK = "date '+%s.%N %z'";
const FOREGROUND = "dumpsys activity activities";
const LOGCAT = { re: "^logcat -d -v epoch -T [0-9]+\\.[0-9]{3}$" };
const FACTS = `@sdk\n37\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n`;

/** The device clock 15 s after the captured Java crash, at +0200. */
const NOW = "1790834340.000000000 +0200\n";
/** Captured on API 35: dev.probe throws at 1790834324.594. */
const JAVA_CRASH = { stdoutFile: "captured/35/logcat-crash-java.txt" };
const PROBE_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt" };

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** One online emulator, plus `extra` device lines, answering the home view's reads. */
function device(
  answers: { foreground?: Response; clock?: Response; logcat?: Response },
  extra: { lines?: string; rules?: Rule[] } = {},
): FakeAdb {
  const shell = (command: string | { re: string }, respond: Response | undefined): Rule[] =>
    respond === undefined ? [] : [{ match: ["-s", SERIAL, "shell", command], respond }];
  fake = createFakeAdb({
    description: "One online emulator answering the home view",
    synthetic: true,
    rules: [
      {
        match: ["devices", "-l"],
        respond: {
          stdout: `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 transport_id:1\n${extra.lines ?? ""}\n`,
        },
      },
      { match: ["-s", SERIAL, "shell", { re: "echo @sdk; .*" }], respond: { stdout: FACTS } },
      {
        match: ["-s", SERIAL, "emu", "avd", "name"],
        respond: { stdout: "Pixel_10_Pro_XL\r\nOK\r\n" },
      },
      ...shell(FOREGROUND, answers.foreground),
      ...shell(CLOCK, answers.clock),
      ...shell(LOGCAT, answers.logcat),
      ...(extra.rules ?? []),
    ],
  });
  return fake;
}

/** Run the home view as TOON and as JSON; the two must carry the same data. */
async function both(f: FakeAdb, env: NodeJS.ProcessEnv = f.env): Promise<CliRun> {
  const toon = await runCli([], env);
  const json = await runCli(["--json"], env);
  expect(json.exitCode).toBe(toon.exitCode);
  expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
  expect(unrunnableCommands(JSON.parse(json.stdout))).toEqual([]);
  return toon;
}

/** The home view without its `bin` line, which names where the build lives. */
function body(run: CliRun): string {
  return run.stdout.replace(/^bin: .*\n/, "");
}

describe("adb-axi (home view)", () => {
  it("shows the devices, the target, its foreground app and the crashes since the latest mark", async () => {
    const f = device({ foreground: PROBE_FRONT, clock: { stdout: NOW }, logcat: JAVA_CRASH });
    writeMark(SERIAL, f.env, "before-save", {
      epochMs: 1790834300_000,
      utcOffsetMinutes: 120,
      processes: [],
    });
    writeMark(SERIAL, f.env, "older", {
      epochMs: 1790834000_000,
      utcOffsetMinutes: 120,
      processes: [],
    });
    const run = await both(f);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^bin: .*adb-axi\.js\n/);
    expect(body(run)).toMatchInlineSnapshot(`
      "description: "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data"
      count: "1 attached, 1 online"
      devices[1]{serial,avd,state,api,form}:
        emulator-5554,Pixel_10_Pro_XL,device,37,phone
      target: emulator-5554
      foreground: dev.probe/.MainActivity
      crashes: "1 since 07:58:20 (latest mark before-save)"
      help[2]: Run \`adb-axi logs crash --since before-save\` to see what crashed,Run \`adb-axi logs --pkg dev.probe --since 1m\` for recent app logs
      "
    `);
    expect(run.stderr).toBe("");
    expect(f.unmatched()).toEqual([]);
    for (const call of f.calls()) {
      if (call.argv[0] !== "devices") expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
    }
  });

  it("says how long ago, by the host's clock, the latest mark was set", async () => {
    const f = device({ foreground: PROBE_FRONT, clock: { stdout: NOW }, logcat: JAVA_CRASH });
    writeMark(SERIAL, f.env, "t1", {
      epochMs: 1790834300_000,
      utcOffsetMinutes: 120,
      processes: [],
      hostEpochMs: Date.now() - 3 * 86_400_000,
    });
    const run = await both(f);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      crashes: "1 since 07:58:20 (latest mark t1, set 3 d ago)",
    });
  });

  it("counts crashes in the last 15 minutes when the target has no mark, and prints that window", async () => {
    const f = device({ foreground: PROBE_FRONT, clock: { stdout: NOW }, logcat: { stdout: "" } });
    const run = await both(f);
    expect(run.exitCode).toBe(0);
    const data = decode(run.stdout.trimEnd()) as Record<string, unknown>;
    expect(data.crashes).toBe("0 in the last 15m (no log mark yet)");
    expect(data.help).toEqual([
      "Run `adb-axi logs --pkg dev.probe --since 1m` for recent app logs",
    ]);
    // The window opens 15 minutes before the device clock, with a lead-in for tombstones.
    const logcat = f.calls().find((call) => call.argv[3]?.startsWith("logcat"));
    expect(logcat?.argv[3]).toBe("logcat -d -v epoch -T 1790833380.000");
    expect(f.unmatched()).toEqual([]);
  });

  it("prints a definitive empty state with exit 0 when nothing is attached", async () => {
    fake = createFakeAdb("devices-empty.json");
    const run = await both(fake);
    expect(run.exitCode).toBe(0);
    expect(body(run)).toMatchInlineSnapshot(`
      "description: "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data"
      count: "0 attached, 0 online"
      devices: []
      target: "-"
      target_note: no device is attached
      help[1]: "Start an emulator or connect a device, then run \`adb-axi\` again"
      "
    `);
    expect(fake.unmatched()).toEqual([]);
  });

  it("reports an ambiguous selection instead of failing, and points the offline device at doctor", async () => {
    fake = createFakeAdb("multi-device.json");
    const run = await both(fake);
    expect(run.exitCode).toBe(0);
    expect(body(run)).toMatchInlineSnapshot(`
      "description: "Truthful, token-efficient adb for agents: devices, app lifecycle, logs and app data"
      count: "3 attached, 2 online"
      devices[3]{serial,avd,state,api,form}:
        emulator-5554,Pixel_10_Pro_XL,device,37,phone
        emulator-5556,Pixel_Tablet,device,35,tablet
        emulator-5558,Pixel_Fold,offline,"-","-"
      target: "-"
      target_note: 2 devices are online and none is selected
      help[3]: Run \`adb-axi <command> --device <serial or avd>\`,Or export ANDROID_SERIAL=<serial> in this shell,Run \`adb-axi doctor --device emulator-5558\` to see why it is offline
      "
    `);
    // Nothing is read from a device that was not chosen.
    const reads = fake.calls().filter((call) => call.argv[2] === "shell");
    expect(reads.every((call) => call.argv[3]?.startsWith("echo @sdk;"))).toBe(true);
    expect(fake.unmatched()).toEqual([]);
  });

  it("reads the selected device before an unrelated inventory read times out", async () => {
    const f = device(
      { foreground: PROBE_FRONT, clock: { stdout: NOW }, logcat: { stdout: "" } },
      {
        lines: "other-device device transport_id:2\n",
        rules: [
          {
            match: ["-s", "other-device", "shell", { re: "echo @sdk; .*" }],
            respond: { hang: true },
          },
        ],
      },
    );
    const run = await runCli([], { ...f.env, ANDROID_SERIAL: SERIAL });
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      count: "2 attached, 2 online",
      target: SERIAL,
      foreground: "dev.probe/.MainActivity",
      crashes: "0 in the last 15m (no log mark yet)",
    });
    const other = f.calls().find((call) => call.argv[1] === "other-device");
    const foreground = f.calls().find((call) => call.argv[3] === FOREGROUND);
    expect(other?.end).toBeNull();
    expect(foreground?.start).toBeLessThan((other?.start ?? 0) + 5_000);
    expect(f.unmatched()).toEqual([]);
  });

  it("includes an attached recovery device when none is online", async () => {
    fake = createFakeAdb({
      description: "One device in recovery",
      synthetic: true,
      rules: [
        {
          match: ["devices", "-l"],
          respond: { stdout: "List of devices attached\nrecovery-1 recovery transport_id:1\n\n" },
        },
      ],
    });
    const run = await both(fake);
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      count: "1 attached, 0 online",
      devices: [{ serial: "recovery-1", state: "recovery", api: "-", form: "-" }],
      target: "-",
    });
    expect(fake.unmatched()).toEqual([]);
  });

  it("reports an ANDROID_SERIAL target that is offline without reading from it", async () => {
    fake = createFakeAdb("multi-device.json");
    const run = await both(fake, { ...fake.env, ANDROID_SERIAL: "emulator-5558" });
    expect(run.exitCode).toBe(0);
    const data = decode(run.stdout.trimEnd()) as Record<string, unknown>;
    expect(data).toMatchObject({ target: "-", target_note: "emulator-5558 is offline" });
    expect(data.help).toEqual(["Run `adb-axi doctor --device emulator-5558` to see why"]);
    // Only the emulator console is asked, for the AVD name; the offline device's shell never is.
    const touched = fake.calls().filter((call) => call.argv[1] === "emulator-5558");
    expect(touched.map((call) => call.argv.slice(2))).toEqual([
      ["emu", "avd", "name"],
      ["emu", "avd", "name"],
    ]);
  });

  it("leaves a field it could not read as `-` and points at doctor", async () => {
    const f = device({
      foreground: { stderr: "Can't find service: activity\n", exit: 1 },
      clock: { stdout: NOW },
      logcat: { stdout: "not a log line\n" },
    });
    const run = await both(f);
    expect(run.exitCode).toBe(0);
    const data = decode(run.stdout.trimEnd()) as Record<string, unknown>;
    expect(data).toMatchObject({ target: SERIAL, foreground: "-", crashes: "-" });
    // The reason comes first, and no placeholder package stands in for the unknown one.
    expect(data.help).toEqual([
      `Run \`adb-axi doctor --device ${SERIAL}\` to see why a read shows \`-\``,
    ]);
    expect(f.unmatched()).toEqual([]);
  });

  it("never outlives its deadline when the target hangs, and leaves no adb process behind", async () => {
    const f = device({ foreground: { hang: true }, clock: { hang: true } });
    const run = await runCli([], f.env);
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout.trimEnd())).toMatchObject({
      target: SERIAL,
      foreground: "-",
      crashes: "-",
    });
    expect(run.durationMs).toBeLessThan(15_000 + 1_250);
    expect(f.calls().some((call) => call.end === null)).toBe(true);
    for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
  });

  it("fails with ADB_SERVER_UNREACHABLE when the server does not answer", async () => {
    fake = createFakeAdb("devices-server-down.json");
    const toon = await runCli([], fake.env);
    expect(toon.exitCode).toBe(1);
    const error = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
    expect(error.code).toBe("ADB_SERVER_UNREACHABLE");
    const json = await runCli(["--json"], fake.env);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual(error);
  });

  it("targets the device named by --device or -s, and its help lines keep it", async () => {
    const f = device(
      { foreground: PROBE_FRONT, clock: { stdout: NOW }, logcat: { stdout: "" } },
      {
        lines: "emulator-5556 device transport_id:2\n",
        rules: [
          {
            match: ["-s", "emulator-5556", "shell", { re: "echo @sdk; .*" }],
            respond: { stdout: FACTS },
          },
          {
            match: ["-s", "emulator-5556", "emu", "avd", "name"],
            respond: { stdout: "Pixel_Tablet\r\nOK\r\n" },
          },
        ],
      },
    );
    for (const flag of ["--device", "-s"]) {
      const toon = await runCli([flag, SERIAL], f.env);
      const json = await runCli(["--json", flag, SERIAL], f.env);
      expect(toon.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
      expect(decode(toon.stdout.trimEnd())).toMatchObject({
        count: "2 attached, 2 online",
        target: SERIAL,
        foreground: "dev.probe/.MainActivity",
        help: [
          `Run \`adb-axi logs --pkg dev.probe --since 1m --device ${SERIAL}\` for recent app logs`,
        ],
      });
    }
    expect(f.unmatched()).toEqual([]);
  });

  it("rejects a command's flag with no command, without saying it goes after one", async () => {
    fake = createFakeAdb("multi-device.json");
    const run = await runCli(["--json", "--pkg", "dev.probe"], fake.env);
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({
      error: "`--pkg dev.probe` needs a command to go with",
      code: "VALIDATION_ERROR",
      help: [
        "Run `adb-axi <command> --pkg dev.probe`",
        "Run `adb-axi --help` for every command and its summary",
      ],
    });
    expect(fake.calls()).toEqual([]);
  });
});
