import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { isErrorCode } from "../../src/core/errors.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { unrunnableCommands } from "../helpers/help-lines.js";
import { runCli, type CliRun } from "../helpers/run.js";

/**
 * The conformance sweep: every shipped command, run through the built CLI against the fake
 * adb, held to the same cross-cutting rules (PRD 7.2, 7.4 to 7.7). Each command's own
 * behaviour is tested in its own file; this file only checks that none of them breaks a
 * rule that all of them share.
 */

// Every case runs the CLI several times, and a loaded runner is slow to start node.
vi.setConfig({ testTimeout: 60_000 });

/** How far past its deadline a command may finish: node start-up plus the kill. */
const MARGIN_MS = 1_250;

/** How a command treats the target device. */
type Selection =
  /** Acts on one resolved device and fails at once when there is none. */
  | "target"
  /** Reports on the host and every device; a selection problem is a failed check (exit 1). */
  | "report"
  /** Lists every device; no selection is needed. */
  | "list"
  /** Waits for the device to come up, so an offline device is waited out. */
  | "wait";

interface Case {
  /** The command line after `adb-axi`. */
  args: string[];
  selection: Selection;
}

const PKG = "com.example.notes";

/** Every v0.1 command, with arguments that pass validation. `update` talks to npm, not adb. */
const CASES: Case[] = [
  { args: [], selection: "list" },
  { args: ["devices"], selection: "list" },
  { args: ["doctor"], selection: "report" },
  { args: ["doctor", "ui"], selection: "target" },
  { args: ["wait", "boot"], selection: "wait" },
  { args: ["wait", "app", PKG, "--state", "foreground"], selection: "target" },
  { args: ["wait", "log", "Displayed"], selection: "target" },
  { args: ["app", "current"], selection: "target" },
  { args: ["app", "list"], selection: "target" },
  { args: ["app", "info", PKG], selection: "target" },
  { args: ["app", "install", "test/fixtures/apk/probe-debug.apk"], selection: "target" },
  { args: ["app", "uninstall", PKG], selection: "target" },
  { args: ["app", "start", PKG], selection: "target" },
  { args: ["app", "stop", PKG], selection: "target" },
  { args: ["app", "clear", PKG], selection: "target" },
  { args: ["app", "kill", PKG], selection: "target" },
  { args: ["app", "restore", PKG], selection: "target" },
  { args: ["app", "death", PKG], selection: "target" },
  { args: ["logs"], selection: "target" },
  { args: ["logs", "mark", "before-save"], selection: "target" },
  { args: ["logs", "crash"], selection: "target" },
  { args: ["data", "db", PKG], selection: "target" },
  { args: ["shell", "--", "id"], selection: "target" },
];

/** Commands that never reach adb, so the device rules do not apply to them. */
const NO_ADB = ["update"];

const name = (c: Case): string => (c.args.length === 0 ? "(home)" : commandWords(c.args));

/** The command words of a case: `app start`, `logs`, `shell`. */
function commandWords(args: readonly string[]): string {
  const known = new Set(allCommands(REGISTRY).map((command) => command.path.join(" ")));
  const two = args.slice(0, 2).join(" ");
  return known.has(two) ? two : (args[0] ?? "");
}

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** Two online emulators and an offline one, with a device shell that never answers. */
function multiDevice(): FakeAdb {
  fake = createFakeAdb({
    description: "Two online emulators, one offline, and device calls that hang",
    synthetic: true,
    rules: [
      {
        match: ["devices", "-l"],
        respond: {
          stdout:
            "List of devices attached\n" +
            "emulator-5554          device product:sdk_gphone64_arm64 transport_id:1\n" +
            "emulator-5556          device product:sdk_gtablet_arm64 transport_id:2\n" +
            "emulator-5558          offline transport_id:3\n\n",
        },
      },
      ...["emulator-5554", "emulator-5556"].map((serial, i) => ({
        match: ["-s", serial, "shell", { re: "echo @sdk; .*" }],
        respond: {
          stdout: `@sdk\n${37 - i * 2}\n@boot_completed\n1\n@boot_id\nboot-${serial}\n@size\nPhysical size: ${i === 0 ? "1344x2992" : "2560x1600"}\n@density\nPhysical density: ${i === 0 ? 480 : 320}\n`,
        },
      })),
      ...[
        ["emulator-5554", "Pixel_10_Pro_XL"],
        ["emulator-5556", "Pixel_Tablet"],
        ["emulator-5558", "Pixel_Fold"],
      ].map(([serial, avd]) => ({
        match: ["-s", serial ?? "", "emu", "avd", "name"],
        respond: { stdout: `${avd}\r\nOK\r\n` },
      })),
      // Anything else on a device never answers, like adb on a wedged device.
      { match: [{ re: "-s" }, { re: "emulator-.*" }, { rest: true }], respond: { hang: true } },
      // Host-level reads doctor makes.
      { match: ["version"], respond: { stdout: "Android Debug Bridge version 1.0.41\n" } },
      { match: [{ rest: true }], respond: { hang: true } },
    ],
  });
  return fake;
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
}

/**
 * Run a command as TOON and as `--json`, and check the two carry the same data. When reads
 * running in parallel all hang, which one passes the deadline first is a race, so `racy`
 * runs compare the keys and the code instead of every value.
 */
async function both(args: string[], f: FakeAdb, racy = false): Promise<Both> {
  const toon = await runCli(args, f.env);
  const json = await runCli(withJson(args), f.env);
  expect(json.exitCode).toBe(toon.exitCode);
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  if (racy) {
    expect(Object.keys(decoded)).toEqual(Object.keys(data));
    expect(decoded.code).toBe(data.code);
  } else {
    expect(comparable(decoded)).toEqual(comparable(data));
  }
  // Every command line a help string suggests runs on this build (6.3).
  expect(unrunnableCommands(data)).toEqual([]);
  return { toon, json, data };
}

/** `--json` before any `--`, which ends the flags. */
function withJson(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)];
}

/** Two runs take different times; every other field must match exactly. */
function comparable(data: Record<string, unknown>): unknown {
  return JSON.parse(
    JSON.stringify(data)
      .replace(/\b\d+ ms\b/g, "<n> ms")
      .replace(/"(waited_ms|elapsed_ms)":\d+/g, '"$1":0'),
  );
}

/** The error shape of 7.7: `error`, `code`, structured fields, then `help`. */
function expectErrorShape(run: CliRun, data: Record<string, unknown>): void {
  const keys = Object.keys(data);
  expect(keys.slice(0, 2)).toEqual(["error", "code"]);
  expect(typeof data.error).toBe("string");
  expect(isErrorCode(String(data.code))).toBe(true);
  if ("help" in data) {
    expect(keys.at(-1)).toBe("help");
    expect(Array.isArray(data.help)).toBe(true);
  }
  expect(run.exitCode).toBe(data.code === "VALIDATION_ERROR" ? 2 : 1);
}

/** Whether a run printed an error rather than an answer. */
const isError = (data: Record<string, unknown>): boolean => "error" in data && "code" in data;

describe("conformance sweep", () => {
  it("covers every shipped command", () => {
    const shipped = allCommands(REGISTRY)
      .filter((command) => command.shipped)
      .map((command) => command.path.join(" "));
    const covered = [
      ...CASES.filter((c) => c.args.length > 0).map((c) => commandWords(c.args)),
      ...NO_ADB,
    ];
    expect(covered.sort()).toEqual(shipped.sort());
    expect(REGISTRY.home.shipped).toBe(true);
  });

  it("leaves no hidden stub in the registry", () => {
    for (const command of [REGISTRY.home, ...allCommands(REGISTRY)]) {
      expect(command.shipped, command.path.join(" ")).toBe(true);
    }
  });

  describe.each(CASES)("adb-axi $args", (c) => {
    it("fails at once with DEVICE_AMBIGUOUS when two devices are online and none is selected", async () => {
      const f = multiDevice();
      const { toon, data } = await both(c.args, f);
      // Two runs, each well inside the 15 s default deadline: nothing waited on a device.
      expect(toon.durationMs).toBeLessThan(5_000);
      if (c.selection === "target" || c.selection === "wait") {
        expectErrorShape(toon, data);
        expect(data.code).toBe("DEVICE_AMBIGUOUS");
        expect(data.devices).toEqual([
          { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", form: "phone" },
          { serial: "emulator-5556", avd: "Pixel_Tablet", form: "tablet" },
        ]);
        // The help line repeats the command as typed, with the device flag it lacks.
        expect(data.help).toEqual([
          expect.stringContaining(`--device <serial or avd>`),
          "Or export ANDROID_SERIAL=<serial> in this shell",
        ]);
        expect((data.help as string[])[0]).toContain(`adb-axi ${name(c)}`);
      } else if (c.selection === "report") {
        expect(toon.exitCode).toBe(1);
        const device = (data.checks as { check: string; status: string; detail: string }[]).find(
          (check) => check.check === "device",
        );
        expect(device).toMatchObject({ status: "failed" });
        expect(device?.detail).toContain("2 devices are online and none is selected");
      } else {
        expect(toon.exitCode).toBe(0);
      }
      // Only the device list and the facts that describe the candidates were read.
      for (const call of f.calls()) {
        const shell = call.argv[2] === "shell" ? (call.argv[3] ?? "") : "";
        expect(
          call.argv[0] === "devices" ||
            call.argv[0] === "version" ||
            call.argv[2] === "emu" ||
            shell.startsWith("echo @sdk;"),
          call.argv.join(" "),
        ).toBe(true);
      }
      expect(f.unmatched()).toEqual([]);
    });

    it.skipIf(c.args.length === 0)("returns at once when the target is offline", async () => {
      const f = multiDevice();
      const args = withDevice(c.args, "emulator-5558");
      const { toon, data } = await both(
        c.selection === "wait" ? withFlag(args, "--timeout", "1s") : args,
        f,
      );
      if (c.selection === "target") {
        expectErrorShape(toon, data);
        expect(data).toMatchObject({ code: "DEVICE_OFFLINE", state: "offline" });
        expect(toon.durationMs).toBeLessThan(2_000);
      } else if (c.selection === "wait") {
        // A booting device is offline, which `wait boot` waits out until its deadline.
        expectErrorShape(toon, data);
        expect(data).toMatchObject({ code: "WAIT_TIMEOUT", last: { state: "offline" } });
        expect(toon.durationMs).toBeLessThan(1_000 + MARGIN_MS);
      } else if (c.selection === "report") {
        expect(toon.exitCode).toBe(1);
        expect(data.checks).toContainEqual(
          expect.objectContaining({ check: "device", status: "failed" }),
        );
        expect(toon.durationMs).toBeLessThan(5_000);
      } else {
        expect(toon.exitCode).toBe(0);
      }
      // The offline device's shell is never asked anything: such calls would hang.
      const shellCalls = f
        .calls()
        .filter((call) => call.argv[1] === "emulator-5558" && call.argv[2] !== "emu");
      expect(shellCalls).toEqual([]);
    });

    it.skipIf(c.args.length === 0)(
      "never lets a device call outlive --timeout, and leaves no adb process behind",
      async () => {
        const f = multiDevice();
        const args = withFlag(withDevice(c.args, "emulator-5554"), "--timeout", "1s");
        const { toon, data } = await both(args, f, true);
        expect(toon.durationMs).toBeLessThan(1_000 + MARGIN_MS);
        if (isError(data)) {
          expectErrorShape(toon, data);
          expect(["TIMEOUT", "WAIT_TIMEOUT"]).toContain(data.code);
        }
        // The deadline was really exercised: some device call hung and was killed. A device
        // list reads only the facts that answer.
        if (c.selection !== "list") expect(f.calls().some((call) => call.end === null)).toBe(true);
        for (const call of f.calls()) {
          expect(isProcessAlive(call.pid), call.argv.join(" ")).toBe(false);
          if (call.end !== null) expect(call.end - call.start).toBeLessThan(1_000 + MARGIN_MS);
        }
      },
    );

    it.skipIf(c.args.length === 0)(
      "rejects an unknown flag with exit 2 and the valid flags, never calling adb",
      async () => {
        const f = multiDevice();
        const { toon, data } = await both(withFlag(c.args, "--bogus"), f);
        expectErrorShape(toon, data);
        expect(data.code).toBe("VALIDATION_ERROR");
        expect(data.valid_flags).toContain("--device <serial|avd>");
        expect(f.calls()).toEqual([]);
      },
    );

    it.skipIf(c.args.length === 0)(
      "prints its help with flags, defaults and examples",
      async () => {
        const f = multiDevice();
        const { toon, data } = await both([...commandWords(c.args).split(" "), "--help"], f);
        expect(toon.exitCode).toBe(0);
        expect(data.command).toBe(`adb-axi ${commandWords(c.args)}`);
        expect(data.usage).toMatch(new RegExp(`^adb-axi ${commandWords(c.args)}\\b`));
        const flags = data.flags as { flag: string; default: string; description: string }[];
        expect(flags.map((flag) => flag.flag.split(" ")[0])).toEqual(
          expect.arrayContaining(["--device", "--timeout", "--json", "--debug", "--help"]),
        );
        for (const flag of flags) {
          expect(flag.default.length).toBeGreaterThan(0);
          expect(flag.description.length).toBeGreaterThan(0);
        }
        const examples = data.examples as string[];
        expect(examples.length).toBeGreaterThanOrEqual(2);
        expect(examples.length).toBeLessThanOrEqual(3);
        expect(f.calls()).toEqual([]);
      },
    );
  });
});

/** The command line with a device flag, placed before any `--`. */
function withDevice(args: readonly string[], serial: string): string[] {
  return withFlag(args, "--device", serial);
}

function withFlag(args: readonly string[], ...flag: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? [...args, ...flag] : [...args.slice(0, end), ...flag, ...args.slice(end)];
}
