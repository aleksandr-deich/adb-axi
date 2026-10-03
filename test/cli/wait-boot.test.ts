import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isShippedPath, REGISTRY } from "../../src/commands/registry.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const TABLET = "emulator-5556";
const BOOT = "echo @boot_completed; getprop sys.boot_completed; echo @uptime; cat /proc/uptime";

const line = (serial: string, state: string): string =>
  `${serial}          ${state} product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n`;
const devices = (...lines: string[]): Response => ({
  stdout: `List of devices attached\n${lines.join("")}\n`,
});

/** What the boot read prints: the property (empty while unset) and `/proc/uptime`. */
const boot = (completed: 0 | 1, uptime = "1141.19 3978.79"): Response => ({
  stdout: `@boot_completed\n${completed === 1 ? "1" : ""}\n@uptime\n${uptime}\n`,
});

const BOOTED = boot(1);
const BOOTING = boot(0, "131.54 400.00");

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** A scripted adb: the first rule that matches (and is not used up) answers. */
function scenario(rules: Rule[]): FakeAdb {
  fake = createFakeAdb({
    description: "A device booting, as the boot read and adb devices show it",
    evidence: ["G1"],
    synthetic: true,
    source:
      "Line formats of adb devices -l and getprop sys.boot_completed with a real /proc/uptime value; the sequence of states is illustrative",
    rules,
  });
  return fake;
}

function shell(response: Response, options: Partial<Rule> = {}, serial = SERIAL): Rule {
  return { match: ["-s", serial, "shell", BOOT], respond: response, ...options };
}

function listing(response: Response, options: Partial<Rule> = {}): Rule {
  return { match: ["devices", "-l"], respond: response, ...options };
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
}

/** Run as TOON and as `--json` against the same scripted answers; the data must match. */
async function both(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  const json = await runCli([...args, "--json"], f.env);
  expect(toon.exitCode).toBe(json.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  // Two runs wait for different times; every other field must match exactly.
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

/** One run of a wait whose answers advance with each call, so a second run would start later. */
async function once(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  return { toon, json: toon, data: decode(toon.stdout.trimEnd()) as Record<string, unknown> };
}

/** Every call was answered, and every call after the device list names its device. */
function expectClean(f: FakeAdb, serial = SERIAL): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices" && call.argv[2] !== "emu") {
      expect(call.argv.slice(0, 2)).toEqual(["-s", serial]);
    }
  }
}

describe("wait boot", () => {
  it("returns at once, as a no-op, when the device has already booted", async () => {
    const f = scenario([listing(devices(line(SERIAL, "device"))), shell(BOOTED)]);
    const { toon, data } = await both(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatch(
      /^ok: wait boot emulator-5554 -> already booted \(no-op\)\nwaited_ms: \d+\n$/,
    );
    expect(data).toEqual({
      ok: "wait boot emulator-5554 -> already booted (no-op)",
      waited_ms: expect.any(Number) as number,
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(2);
    expectClean(f);
  });

  it("polls until sys.boot_completed is 1 and reports how long it waited", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"))),
      shell(BOOTING, { times: 2, then: BOOTED }),
    ]);
    const { toon, data } = await once(["wait", "boot"], f);
    expect(toon.exitCode).toBe(0);
    const waited = data.waited_ms;
    expect(typeof waited).toBe("number");
    expect(waited as number).toBeGreaterThanOrEqual(500);
    expect(data).toEqual({
      ok: `wait boot ${SERIAL} -> booted after ${String(waited)} ms`,
      waited_ms: waited,
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(3);
    expectClean(f);
  });

  it("waits through a device that is not attached yet and one that is still offline", async () => {
    const f = scenario([
      // One look finds nothing attached, one finds the device offline, then it is up and booted.
      listing(devices(), { times: 1 }),
      listing(devices(line(SERIAL, "offline")), { times: 1 }),
      listing(devices(line(SERIAL, "device"))),
      shell(BOOTED),
    ]);
    const { toon, data } = await once(["wait", "boot", "--device", SERIAL], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toMatch(/^wait boot emulator-5554 -> booted after \d+ ms$/);
    expect(f.calls().filter((call) => call.argv[2] === "shell")).toHaveLength(1);
    expectClean(f);
  });

  it("does not switch to a different device after the selected device disconnects", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device")), { times: 1 }),
      listing(devices(line(TABLET, "device"))),
      {
        match: ["-s", TABLET, "emu", "avd", "name"],
        respond: { stdout: "Pixel_Tablet\r\nOK\r\n" },
      },
      shell(BOOTING),
      shell(BOOTED, {}, TABLET),
    ]);
    const { toon, data } = await once(["wait", "boot", "--timeout", "1s"], f);
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "WAIT_TIMEOUT",
      error: `${SERIAL} had not finished booting after 1 s`,
      last: { state: "not attached", boot_completed: "-", uptime_s: "-" },
    });
    expect(f.calls().filter((call) => call.argv[2] === "shell" && call.argv[1] === TABLET)).toEqual([]);
    expect(f.unmatched()).toEqual([]);
  }, 20_000);

  it("resolves the device by AVD name", async () => {
    const f = scenario([
      listing(devices(line(SERIAL, "device"), line(TABLET, "device"))),
      {
        match: ["-s", SERIAL, "emu", "avd", "name"],
        respond: { stdout: "Pixel_10_Pro_XL\r\nOK\r\n" },
      },
      {
        match: ["-s", TABLET, "emu", "avd", "name"],
        respond: { stdout: "Pixel_Tablet\r\nOK\r\n" },
      },
      shell(BOOTED, {}, TABLET),
    ]);
    const { toon, data } = await both(["wait", "boot", "--device", "Pixel_Tablet"], f);
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe(`wait boot ${TABLET} -> already booted (no-op)`);
    expectClean(f, TABLET);
  });

  describe("WAIT_TIMEOUT", () => {
    it("carries the last observation: state, boot_completed and uptime_s", async () => {
      const f = scenario([listing(devices(line(TABLET, "device"))), shell(BOOTING, {}, TABLET)]);
      // Each look starts a few fake adb processes, so the deadline must outlast a slow runner's spawns.
      const { toon, data } = await both(["wait", "boot", "--device", TABLET, "--timeout", "3s"], f);
      expect(toon.exitCode).toBe(1);
      expect(toon.stdout).toBe(
        [
          "error: emulator-5556 had not finished booting after 3 s",
          "code: WAIT_TIMEOUT",
          "last:",
          "  state: device",
          "  boot_completed: 0",
          "  uptime_s: 131",
          "help[1]: Run `adb-axi doctor --device emulator-5556` to see why",
          "",
        ].join("\n"),
      );
      expect(data).toEqual({
        error: "emulator-5556 had not finished booting after 3 s",
        code: "WAIT_TIMEOUT",
        last: { state: "device", boot_completed: 0, uptime_s: 131 },
        help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
      });
      expectClean(f, TABLET);
    }, 20_000);

    it("reports an offline device as the last state, with the boot unknown", async () => {
      const f = scenario([listing(devices(line(SERIAL, "offline")))]);
      const { toon, data } = await both(["wait", "boot", "--timeout", "2s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        error: "the device had not finished booting after 2 s",
        code: "WAIT_TIMEOUT",
        last: { state: "offline", boot_completed: "-", uptime_s: "-" },
      });
      // The boot is never read from a device that is not online.
      expect(f.calls().filter((call) => call.argv[0] === "-s")).toEqual([]);
    }, 20_000);

    it.each([
      ["offline", "offline"],
      ["recovery", "not online"],
    ])("reports the last state for offline and %s attachments", async (other, state) => {
      const f = scenario([listing(devices(line(SERIAL, "offline"), line(TABLET, other)))]);
      const { toon, data } = await both(["wait", "boot", "--timeout", "1s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "WAIT_TIMEOUT",
        last: { state, boot_completed: "-", uptime_s: "-" },
      });
      expect(f.unmatched()).toEqual([]);
    }, 20_000);

    it("names the environment-selected device in the timeout and doctor hint", async () => {
      const f = scenario([listing(devices())]);
      const run = await runCli(["wait", "boot", "--timeout", "1s"], {
        ...f.env,
        ANDROID_SERIAL: TABLET,
      });
      expect(run.exitCode).toBe(1);
      expect(decode(run.stdout.trimEnd())).toEqual({
        error: `${TABLET} had not finished booting after 1 s`,
        code: "WAIT_TIMEOUT",
        last: { state: "not attached", boot_completed: "-", uptime_s: "-" },
        help: [`Run \`adb-axi doctor --device ${TABLET}\` to see why`],
      });
      expect(f.unmatched()).toEqual([]);
    }, 20_000);

    it("reports a device that never attached, and names the one that was asked for", async () => {
      const f = scenario([listing(devices())]);
      const { toon, data } = await both(["wait", "boot", "--device", TABLET, "--timeout", "2s"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toEqual({
        error: "emulator-5556 had not finished booting after 2 s",
        code: "WAIT_TIMEOUT",
        last: { state: "not attached", boot_completed: "-", uptime_s: "-" },
        help: ["Run `adb-axi doctor --device emulator-5556` to see why"],
      });
      expect(f.unmatched()).toEqual([]);
    }, 20_000);

    it("falls back to a plain doctor hint when no device was ever chosen", async () => {
      const f = scenario([listing(devices())]);
      const { data } = await both(["wait", "boot", "--timeout", "1s"], f);
      expect(data).toMatchObject({
        error: "the device had not finished booting after 1 s",
        help: ["Run `adb-axi doctor` to see why"],
      });
    }, 20_000);

    it("keeps the deadline when the boot read never answers, and kills the hung call", async () => {
      const f = scenario([listing(devices(line(SERIAL, "device"))), shell({ hang: true })]);
      const run = await runCli(["wait", "boot", "--timeout", "2s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(run.durationMs).toBeLessThan(2000 + 1500);
      expect(decode(run.stdout.trimEnd())).toMatchObject({
        code: "WAIT_TIMEOUT",
        last: { state: "device", boot_completed: "-", uptime_s: "-" },
      });
      for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
    }, 20_000);

    it("keeps the deadline when the server never answers", async () => {
      const f = scenario([listing({ hang: true })]);
      const run = await runCli(["wait", "boot", "--timeout", "1s"], f.env);
      expect(run.exitCode).toBe(1);
      expect(run.durationMs).toBeLessThan(1000 + 1500);
      expect(decode(run.stdout.trimEnd())).toMatchObject({ code: "ADB_SERVER_UNREACHABLE" });
    }, 20_000);

    it("uses the 120 s default deadline", async () => {
      const f = scenario([listing(devices(line(SERIAL, "device"))), shell(BOOTED)]);
      const help = await runCli(["wait", "boot", "--help"], f.env);
      expect(help.stdout).toContain('"--timeout <dur>",120s');
      expect(f.calls()).toEqual([]);
    });
  });

  describe("errors that waiting cannot fix", () => {
    it("fails with ADB_NOT_FOUND when there is no adb to ask", async () => {
      const f = scenario([]);
      const empty = mkdtempSync(join(tmpdir(), "adb-axi-no-adb-"));
      try {
        const run = await runCli(["wait", "boot"], { ...f.env, PATH: empty, HOME: empty });
        expect(run.exitCode).toBe(1);
        expect(decode(run.stdout.trimEnd())).toMatchObject({
          code: "ADB_NOT_FOUND",
          error: "adb was not found",
        });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("fails at once with DEVICE_UNAUTHORIZED", async () => {
      const f = scenario([listing(devices(line("ZY22ABCDEFG", "unauthorized")))]);
      const { toon, data } = await both(["wait", "boot"], f);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(2000);
      expect(data).toMatchObject({ code: "DEVICE_UNAUTHORIZED" });
    });

    it("fails at once with DEVICE_AMBIGUOUS when several are online and none is chosen", async () => {
      fake = createFakeAdb("multi-device.json");
      const { toon, data } = await both(["wait", "boot"], fake);
      expect(toon.exitCode).toBe(1);
      expect(toon.durationMs).toBeLessThan(2000);
      expect(data).toMatchObject({
        error: "2 devices are online and none is selected",
        code: "DEVICE_AMBIGUOUS",
        help: [
          "Run `adb-axi wait boot --device <serial or avd>`",
          "Or export ANDROID_SERIAL=<serial> in this shell",
        ],
      });
      expect(
        fake.calls().filter((call) => call.argv[2] === "shell" && call.argv[3] === BOOT),
      ).toEqual([]);
    });

    it("fails with INVALID_OUTPUT when the device prints something that is not the boot state", async () => {
      const f = scenario([
        listing(devices(line(SERIAL, "device"))),
        shell({ stdout: "unexpected\n" }),
      ]);
      const { toon, data } = await both(["wait", "boot"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INVALID_OUTPUT",
        error: "reading the boot state of emulator-5554 printed output adb-axi cannot read",
      });
    });
  });

  it("is listed in help, and its help lines name only shipped commands", async () => {
    const f = scenario([]);
    const top = await runCli(["--help"], f.env);
    expect(top.stdout).toContain("adb-axi wait boot");
    const help = await runCli(["wait", "--help"], f.env);
    expect(help.stdout).toContain("adb-axi wait boot");
    expect(isShippedPath(REGISTRY, ["wait", "boot"])).toBe(true);
    expect(f.calls()).toEqual([]);
  });
});
