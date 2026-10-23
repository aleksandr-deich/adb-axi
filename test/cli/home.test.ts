import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMarks, writeMark } from "../../src/commands/logs/marks.js";
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
const PROBE_FRONT = { stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt" };

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** One online emulator, plus `extra` device lines, answering the home view's reads. */
function device(
  answers: { foreground?: Response; clock?: Response; logcat?: Response; facts?: Response },
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
      {
        match: ["-s", SERIAL, "shell", { re: "echo @sdk; .*" }],
        respond: answers.facts ?? { stdout: FACTS },
      },
      {
        match: ["-s", SERIAL, "emu", "avd", "name"],
        respond: { stdout: "Pixel_10_Pro_XL\r\nOK\r\n" },
      },
      ...shell("am get-current-user", { stdout: "0\n" }),
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
  it.each(
    [true].flatMap((bound) => [{ bound, facts: { stderr: "Can't find service\n", exit: 1 } }]),
  )(
    "ignores but preserves unverified $bound marks when facts are missing: $facts",
    async ({ bound, facts }) => {
      const f = device({
        foreground: PROBE_FRONT,
        clock: { stdout: NOW },
        logcat: { stdout: "" },
        facts,
      });
      if (bound) bindMarks(SERIAL, f.env, "earlier-boot");
      writeMark(SERIAL, f.env, "old", {
        epochMs: 1790834300000,
        utcOffsetMinutes: 120,
        processes: [],
      });
      const path = join(f.home, SERIAL, "marks.json");
      const saved = readFileSync(path, "utf8");
      const result = await both(f);
      expect(decode(result.stdout.trimEnd())).toMatchObject({
        crashes: "0 in the last 15m (no log mark yet)",
        marks_note: "Log marks could not be verified for this boot; stored marks were not used",
      });
      expect(readFileSync(path, "utf8")).toBe(saved);
    },
  );

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
