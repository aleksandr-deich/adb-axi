import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { extractJsonFlag, main } from "../../src/cli.js";
import { defineCommand, defineGroup } from "../../src/commands/define.js";
import type { Registry } from "../../src/commands/types.js";
import { okLine } from "../../src/core/output.js";

const start = defineCommand({
  path: ["app", "start"],
  summary: "Start an app in the test registry",
  positionals: [{ name: "pkg", description: "Package", required: true }],
  flags: [{ name: "--fresh", type: "boolean", description: "Cold start" }],
  examples: ["adb-axi app start com.example"],
  shipped: true,
  run: (context) =>
    Promise.resolve({
      ok: okLine("start", String(context.positionals.pkg), "foreground (cold start)"),
      app: { pid: 5388, launch: "cold", fresh: context.flags.fresh === true },
      timeout_ms: context.timeoutMs,
    }),
});
const stop = defineCommand({
  path: ["app", "stop"],
  summary: "Hidden stub in the test registry",
  positionals: [{ name: "pkg", description: "Package", required: true }],
  examples: ["adb-axi app stop com.example"],
});
const logsDump = defineCommand({
  path: ["logs"],
  summary: "Hidden default command of a hidden group",
  flags: [{ name: "--pkg", type: "string", valueName: "<pkg>", description: "App" }],
  examples: ["adb-axi logs"],
});
const logsMark = defineCommand({
  path: ["logs", "mark"],
  summary: "Hidden subcommand",
  examples: ["adb-axi logs mark"],
});
const home = defineCommand({
  path: [],
  summary: "Home view of the test registry",
  examples: ["adb-axi"],
  device: "none",
  shipped: true,
  run: () => Promise.resolve({ devices: [], target: null }),
});

const registry: Registry = {
  home,
  entries: {
    app: defineGroup({ name: "app", summary: "App lifecycle", subcommands: [start, stop] }),
    logs: defineGroup({
      name: "logs",
      summary: "Logs",
      defaultCommand: logsDump,
      subcommands: [logsMark],
    }),
  },
};

async function run(argv: string[]): Promise<{ out: string; exit: number }> {
  let out = "";
  process.exitCode = undefined;
  await main({ argv, registry, stdout: { write: (chunk: string) => (out += chunk) } });
  const exit = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out, exit };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("extractJsonFlag", () => {
  it("removes --json anywhere before --, and only there", () => {
    expect(extractJsonFlag(["--json", "logs", "--json"])).toEqual({ mode: "json", argv: ["logs"] });
    expect(extractJsonFlag(["shell", "--", "echo", "--json"])).toEqual({
      mode: "toon",
      argv: ["shell", "--", "echo", "--json"],
    });
  });
});

describe("dispatch", () => {
  it("runs a shipped subcommand and renders TOON", async () => {
    const { out, exit } = await run(["app", "start", "com.example", "--fresh", "--timeout", "2s"]);
    expect(exit).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "ok: start com.example -> foreground (cold start)
      app:
        pid: 5388
        launch: cold
        fresh: true
      timeout_ms: 2000
      "
    `);
  });

  it("renders the same fields as JSON, with --json before or after the command", async () => {
    const toon = await run(["app", "start", "com.example"]);
    const after = await run(["app", "start", "com.example", "--json"]);
    const before = await run(["--json", "app", "start", "com.example"]);
    expect(after.out).toBe(before.out);
    expect(JSON.parse(after.out)).toEqual(decode(toon.out.trimEnd()));
    expect(JSON.parse(after.out)).toMatchObject({ timeout_ms: 15_000 });
  });

  it("routes bare --json to the home view with the header", async () => {
    const { out, exit } = await run(["--json"]);
    expect(exit).toBe(0);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["bin", "description", "devices", "target"]);
    const toon = decode((await run([])).out.trimEnd()) as Record<string, unknown>;
    expect(Object.keys(toon)).toEqual(["bin", "description", "devices", "target"]);
  });

  it("rejects a leading device flag with the corrected command, in either format", async () => {
    const toon = await run(["-s", "emulator-5554", "app", "start", "com.example"]);
    expect(toon.exit).toBe(2);
    expect(toon.out).toMatchInlineSnapshot(`
      "error: \`-s emulator-5554\` must come after the command
      code: VALIDATION_ERROR
      help[1]: Run \`adb-axi app start com.example --device emulator-5554\`
      "
    `);
    const json = await run(["--json", "--device", "emulator-5554", "--debug", "app", "start", "x"]);
    expect(json.exit).toBe(2);
    expect(JSON.parse(json.out)).toEqual({
      error: "`--device emulator-5554 --debug` must come after the command",
      code: "VALIDATION_ERROR",
      help: ["Run `adb-axi app start x --device emulator-5554 --debug`"],
    });
  });

  it("puts corrected flags before -- so they stay flags", async () => {
    const { out } = await run(["-s", "e-1", "shell", "--", "ls", "-la"]);
    expect(out).toContain("Run `adb-axi shell --device e-1 -- ls -la`");
  });

  it("rejects a leading flag with no command", async () => {
    const { out, exit } = await run(["-s", "emulator-5554"]);
    expect(exit).toBe(2);
    expect(out).toContain("Run `adb-axi <command> --device emulator-5554`");
  });

  it("lists the command's valid flags for an unknown flag, with its help", async () => {
    const { out, exit } = await run(["app", "start", "com.example", "--bogus"]);
    expect(exit).toBe(2);
    expect(out).toMatchInlineSnapshot(`
      "error: unknown flag --bogus for \`adb-axi app start\`
      code: VALIDATION_ERROR
      valid_flags[6]: "--fresh","--device <serial|avd>","--timeout <dur>","--json","--debug","--help"
      help[1]: Run \`adb-axi app start --help\` for flag details
      "
    `);
  });

  it("lists shipped commands only for an unknown command", async () => {
    const { out, exit } = await run(["ap"]);
    expect(exit).toBe(2);
    expect(decode(out.trimEnd())).toEqual({
      error: "unknown command `ap`",
      code: "VALIDATION_ERROR",
      commands: ["app"],
      help: [
        "Run `adb-axi app` if you meant `app`",
        "Run `adb-axi --help` for every command and its summary",
      ],
    });
  });

  it("prints help for a shipped subcommand and for its group", async () => {
    const leaf = decode((await run(["app", "start", "--help"])).out.trimEnd()) as Record<
      string,
      unknown
    >;
    expect(leaf).toMatchObject({
      command: "adb-axi app start",
      usage: "adb-axi app start <pkg> [flags]",
    });
    for (const argv of [["app"], ["app", "--help"]]) {
      const { out, exit } = await run(argv);
      expect(exit).toBe(0);
      const group = decode(out.trimEnd()) as { subcommands: { command: string }[] };
      expect(group.subcommands.map((s) => s.command)).toEqual(["adb-axi app start"]);
    }
  });

  it("keeps hidden stubs out of help but still validates and dispatches them", async () => {
    const top = await run(["--help"]);
    expect(top.out).toContain("adb-axi app start");
    expect(top.out).not.toContain("app stop");
    expect(top.out).not.toContain("logs");

    const stubHelp = await run(["app", "stop", "--help"]);
    expect(stubHelp.exit).toBe(1);
    expect(stubHelp.out).toContain("code: NOT_IMPLEMENTED");

    const stubRun = await run(["app", "stop", "com.example"]);
    expect(stubRun.exit).toBe(1);
    expect(decode(stubRun.out.trimEnd())).toEqual({
      error: "`adb-axi app stop` is not available in this build",
      code: "NOT_IMPLEMENTED",
      help: ["Run `adb-axi --help` to see the commands this build ships"],
    });

    const stubMissing = await run(["app", "stop"]);
    expect(stubMissing.exit).toBe(2);

    const hiddenDefault = await run(["logs", "--pkg", "x"]);
    expect(hiddenDefault.out).toContain("`adb-axi logs` is not available in this build");
    const hiddenFlag = await run(["logs", "--bogus"]);
    expect(hiddenFlag.exit).toBe(2);
    expect(hiddenFlag.out).not.toContain("help[");
    const hiddenGroupHelp = await run(["logs", "--help"]);
    expect(hiddenGroupHelp.out).toContain("NOT_IMPLEMENTED");
  });

  it("rejects an unknown subcommand and suggests the nearest shipped one", async () => {
    const { out, exit } = await run(["app", "strat", "x"]);
    expect(exit).toBe(2);
    expect(decode(out.trimEnd())).toEqual({
      error: "unknown subcommand `strat` for `adb-axi app`",
      code: "VALIDATION_ERROR",
      subcommands: ["start"],
      help: [
        "Run `adb-axi app start` if you meant `start`",
        "Run `adb-axi app --help` for its subcommands",
      ],
    });
  });

  it("tells where the subcommand goes when flags come first", async () => {
    const { out, exit } = await run(["app", "--fresh", "start", "x"]);
    expect(exit).toBe(2);
    expect(out).toContain("Run `adb-axi app start --fresh x`");
  });

  it("prints the version for version flags", async () => {
    expect((await run(["--version"])).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
