import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { isErrorCode } from "../../src/core/errors.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import { unrunnableCommands } from "../helpers/help-lines.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

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

interface Case {
  /** The command line after `adb-axi`. */
  args: string[];
}

const PKG = "com.example.notes";

/** Every v0.1 command, with arguments that pass validation. `update` talks to npm, not adb. */
const CASES: Case[] = [
  { args: [] },
  { args: ["devices"] },
  { args: ["doctor"] },
  { args: ["doctor", "ui"] },
  { args: ["wait", "boot"] },
  { args: ["wait", "app", PKG, "--state", "foreground"] },
  { args: ["wait", "log", "Displayed"] },
  { args: ["app", "current"] },
  { args: ["app", "list"] },
  { args: ["app", "info", PKG] },
  { args: ["app", "install", "test/fixtures/apk/probe-debug.apk"] },
  { args: ["app", "uninstall", PKG] },
  { args: ["app", "start", PKG] },
  { args: ["app", "stop", PKG] },
  { args: ["app", "clear", PKG] },
  { args: ["app", "kill", PKG] },
  { args: ["app", "restore", PKG] },
  { args: ["app", "death", PKG] },
  { args: ["logs"] },
  { args: ["logs", "mark", "before-save"] },
  { args: ["logs", "crash"] },
  { args: ["data", "db", PKG] },
  { args: ["shell", "--", "id"] },
  { args: ["update"] },
];

const HELP_CONTRACTS: Record<string, { fragments: string[]; summary?: string }> = {
  devices: { fragments: ["--all", "--fields <list>"] },
  "app install": {
    fragments: [
      "--clean-data",
      "--if-changed",
      "same versionCode and signer",
      "debug and release variants",
      "180s",
    ],
  },
  "app uninstall": { fragments: ["--keep-data"] },
  "app start": { fragments: ["--fresh", "--activity <name>", "--timeout"] },
  "app clear": {
    fragments: ["--full"],
    summary:
      "Clear the current Android user's app data, verify it is cleared, and report the process stopped. Android also stops the app's running processes for other Android users, leaving their data intact.",
  },
  "app list": { fragments: ["--grep <re>"] },
  "wait app": { fragments: ["--state <foreground|running|stopped> (required)"] },
  "wait boot": { fragments: ['"--timeout <dur>",120s'] },
  "data db": { fragments: ["64 MB result limit"] },
  shell: { fragments: ["--full", "adb-axi shell -- 'getprop ro.build.version.sdk'"] },
};

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
      {
        match: ["version"],
        respond: { stdout: "Android Debug Bridge version 1.0.41\nVersion 37.0.0-14910828\n" },
      },
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
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
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

describe("conformance sweep", () => {
  it("covers every shipped command", async () => {
    const shipped = allCommands(REGISTRY)
      .filter((command) => command.shipped)
      .map((command) => command.path.join(" "));
    const covered = CASES.filter((c) => c.args.length > 0).map((c) => commandWords(c.args));
    expect(covered.sort()).toEqual(shipped.sort());
    expect(REGISTRY.home.shipped).toBe(true);
    const f = multiDevice();
    const top = await both(["--help"], f);
    expect(top.toon.exitCode).toBe(0);
    expect((top.data.commands as { command: string }[]).map((c) => c.command).sort()).toEqual(
      ["adb-axi", ...covered.map((command) => `adb-axi ${command}`)].sort(),
    );
    for (const group of ["app", "wait", "data", "logs", "doctor"]) {
      const help = await both([group, "--help"], f);
      expect(help.toon.exitCode).toBe(0);
      expect((help.data.subcommands as { command: string }[]).map((c) => c.command).sort()).toEqual(
        covered
          .filter((command) => command.startsWith(`${group} `))
          .map((command) => `adb-axi ${command}`)
          .sort(),
      );
    }
    expect(f.calls()).toEqual([]);
  });

  it("leaves no hidden stub in the registry", () => {
    for (const command of [REGISTRY.home, ...allCommands(REGISTRY)]) {
      expect(command.shipped, command.path.join(" ")).toBe(true);
    }
  });

  it("every command rejects an unknown flag with exit 2 and the valid flags, never calling adb", async () => {
    for (const c of CASES.filter((c) => c.args.length > 0)) {
      const f = multiDevice();
      const { toon, data } = await both(withFlag(c.args, "--bogus"), f);
      expectErrorShape(toon, data);
      expect(data.code, name(c)).toBe("VALIDATION_ERROR");
      expect(data.error).toBe(`unknown flag --bogus for \`adb-axi ${name(c)}\``);
      expect(data.valid_flags, name(c)).toContain("--device <serial|avd>");
      if (name(c) === "logs") expect(data.valid_flags).toContain("--pkg <pkg>");
      expect(f.calls(), name(c)).toEqual([]);
      f.cleanup();
    }
  });

  it("every command prints its help with flags, defaults and examples", async () => {
    for (const c of CASES.filter((c) => c.args.length > 0)) {
      const f = multiDevice();
      const words = commandWords(c.args);
      const { toon, data } = await both([...words.split(" "), "--help"], f);
      expect(toon.exitCode, words).toBe(0);
      expect(data.command).toBe(`adb-axi ${words}`);
      expect(data.usage).toMatch(new RegExp(`^adb-axi ${words}\\b`));
      const flags = [
        ...(data.flags as object[]),
        ...((data.global_flags as object[] | undefined) ?? []),
      ] as {
        flag: string;
        default: string;
        description: string;
      }[];
      const flagNames = flags.map((flag) => flag.flag.split(" ")[0]);
      if (words === "update") {
        expect(flagNames, words).toEqual(
          expect.arrayContaining(["--json", "--debug", "--help", "--check", "--dry-run"]),
        );
        expect(flagNames, words).not.toContain("--device");
        expect(flagNames, words).not.toContain("--timeout");
      } else {
        expect(flagNames, words).toEqual(
          expect.arrayContaining(["--device", "--timeout", "--json", "--debug", "--help"]),
        );
      }
      for (const flag of flags) {
        expect(flag.default.length, `${words} ${flag.flag}`).toBeGreaterThan(0);
        expect(flag.description.length, `${words} ${flag.flag}`).toBeGreaterThan(0);
      }
      const examples = data.examples as string[];
      expect(examples.length, words).toBeGreaterThanOrEqual(2);
      expect(examples.length, words).toBeLessThanOrEqual(3);
      const contract = HELP_CONTRACTS[name(c)];
      for (const fragment of contract?.fragments ?? []) {
        expect(toon.stdout, words).toContain(fragment);
      }
      if (contract?.summary !== undefined) expect(data.summary).toBe(contract.summary);
      expect(f.calls(), words).toEqual([]);
      f.cleanup();
    }
  });

  it.each([
    ["app", "current"],
    ["app", "start", PKG],
  ])(
    "never lets a device call outlive --timeout, and leaves no adb process behind: %s %s",
    async (...args) => {
      const f = multiDevice();
      const { toon, data } = await both(
        withFlag(withDevice(args, "emulator-5554"), "--timeout", "1s"),
        f,
        true,
      );
      expect(toon.durationMs).toBeLessThan(1_000 + MARGIN_MS);
      expectErrorShape(toon, data);
      expect(["TIMEOUT", "WAIT_TIMEOUT"]).toContain(data.code);
      // The deadline was really exercised: some device call hung and was killed.
      expect(f.calls().some((call) => call.end === null)).toBe(true);
      for (const call of f.calls()) {
        expect(isProcessAlive(call.pid), call.argv.join(" ")).toBe(false);
        if (call.end !== null) expect(call.end - call.start).toBeLessThan(1_000 + MARGIN_MS);
      }
    },
  );

  it("returns at once when the target is offline, never asking its shell", async () => {
    const f = multiDevice();
    const { toon, data } = await both(withDevice(["app", "current"], "emulator-5558"), f);
    expectErrorShape(toon, data);
    expect(data).toMatchObject({ code: "DEVICE_OFFLINE", state: "offline" });
    expect(toon.durationMs).toBeLessThan(2_000);
    const shellCalls = f
      .calls()
      .filter((call) => call.argv[1] === "emulator-5558" && call.argv[2] !== "emu");
    expect(shellCalls).toEqual([]);
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
