import { describe, expect, it } from "vitest";
import { allCommands, REGISTRY } from "../../src/commands/registry.js";
import { commandHelp, groupHelp, topLevelHelp } from "../../src/commands/help.js";
import type { CommandSpec, GroupSpec } from "../../src/commands/types.js";
import { unrunnableCommands, V02_PATTERNS } from "../helpers/help-lines.js";

/** Every v0.1 command and subcommand (PRD 6.1), as paths after `adb-axi`. */
const V01_COMMANDS = [
  "devices",
  "doctor",
  "doctor ui",
  "wait boot",
  "wait app",
  "wait log",
  "app current",
  "app list",
  "app info",
  "app install",
  "app uninstall",
  "app start",
  "app stop",
  "app clear",
  "app kill",
  "app restore",
  "app death",
  "logs mark",
  "logs",
  "logs crash",
  "data db",
  "shell",
  "update",
];

const paths = (): string[] => allCommands(REGISTRY).map((command) => command.path.join(" "));

function helpStrings(command: CommandSpec): string[] {
  return [
    command.summary,
    ...command.examples,
    ...command.flags.map((flag) => flag.description),
    ...command.positionals.map((p) => p.description),
    JSON.stringify(commandHelp(command)),
  ];
}

describe("command registry", () => {
  it("registers every v0.1 command exactly once", () => {
    expect([...paths()].sort()).toEqual([...V01_COMMANDS].sort());
  });

  it("registers no v0.2 command", () => {
    for (const name of ["lease", "config", "fwd", "rev", "setup"]) {
      expect(REGISTRY.entries[name]).toBeUndefined();
    }
    const data = REGISTRY.entries.data as GroupSpec;
    expect(data.subcommands.map((c) => c.path[1])).toEqual(["db"]);
    const doctorUi = allCommands(REGISTRY).find((c) => c.path.join(" ") === "doctor ui");
    const doctor = allCommands(REGISTRY).find((c) => c.path.join(" ") === "doctor");
    expect(doctor?.flags.map((f) => f.name)).toEqual([]);
    expect(doctorUi?.flags.map((f) => f.name)).toEqual(["--fix"]);
  });

  it("names no v0.2 command in any help string", () => {
    const strings = [
      ...allCommands(REGISTRY).flatMap(helpStrings),
      ...helpStrings(REGISTRY.home),
      JSON.stringify(topLevelHelp(REGISTRY)),
      ...Object.values(REGISTRY.entries)
        .filter((entry): entry is GroupSpec => entry.kind === "group")
        .map((group) => JSON.stringify({ ...group, subcommands: [], defaultCommand: undefined })),
    ];
    for (const text of strings) {
      for (const pattern of V02_PATTERNS) expect(text).not.toMatch(pattern);
    }
  });

  it("tells a runnable help line from one this build cannot run", () => {
    expect(
      unrunnableCommands([
        "Run `adb-axi logs crash --since before-save` to see it",
        "Run `adb-axi app <subcommand> --help`",
        "Run `adb-axi <command> --device <serial or avd>`",
        "Run `adb-axi shell --device emulator-5554 -- 'ime reset'`",
      ]),
    ).toEqual([]);
    expect(
      unrunnableCommands({
        help: [
          "Run `adb-axi doctor --fix`",
          "Run `adb-axi lease acquire`",
          "`adb-axi logs --bogus`",
        ],
      }),
    ).toEqual(["adb-axi doctor --fix", "adb-axi lease acquire", "adb-axi logs --bogus"]);
  });

  it("names only commands and flags this build ships, in every help string and example", () => {
    const groups = Object.values(REGISTRY.entries).filter(
      (entry): entry is GroupSpec => entry.kind === "group",
    );
    const help = [
      ...[REGISTRY.home, ...allCommands(REGISTRY)].flatMap((command) => [
        ...helpStrings(command),
        ...command.examples.map((example) => `\`${example}\``),
      ]),
      topLevelHelp(REGISTRY),
      ...groups.map(groupHelp),
    ];
    expect(unrunnableCommands(help)).toEqual([]);
  });

  it("shows only shipped commands in top-level and group help", () => {
    const shipped = new Set(
      allCommands(REGISTRY)
        .filter((command) => command.shipped)
        .map((command) => `adb-axi ${command.path.join(" ")}`),
    );
    const listed = (topLevelHelp(REGISTRY).commands as { command: string }[]).map((c) => c.command);
    expect(new Set(listed)).toEqual(
      REGISTRY.home.shipped ? new Set([...shipped, "adb-axi"]) : shipped,
    );
    for (const entry of Object.values(REGISTRY.entries)) {
      if (entry.kind !== "group") continue;
      const subs = (groupHelp(entry).subcommands as { command: string }[]).map((c) => c.command);
      for (const sub of subs) expect(shipped.has(sub)).toBe(true);
    }
  });

  it("gives every command a summary, examples that run it, and a default deadline", () => {
    for (const command of [...allCommands(REGISTRY), REGISTRY.home]) {
      expect(command.summary.length).toBeGreaterThan(10);
      expect(command.examples.length).toBeGreaterThanOrEqual(1);
      for (const example of command.examples) {
        expect(example.startsWith(`adb-axi ${command.path.join(" ")}`.trimEnd())).toBe(true);
      }
      expect(command.defaultTimeoutMs).toBeGreaterThan(0);
    }
  });

  it("uses the deadline defaults of 7.4", () => {
    const timeout = (path: string): number | undefined =>
      allCommands(REGISTRY).find((c) => c.path.join(" ") === path)?.defaultTimeoutMs;
    expect(timeout("app install")).toBe(180_000);
    expect(timeout("wait boot")).toBe(120_000);
    expect(timeout("app death")).toBe(30_000);
    expect(timeout("logs")).toBe(15_000);
  });

  it("never lets a command flag shadow a global flag", () => {
    for (const command of allCommands(REGISTRY)) {
      for (const flag of command.flags) {
        expect(["--device", "--timeout", "--json", "--debug", "--help"]).not.toContain(flag.name);
        expect(flag.alias).not.toBe("-s");
      }
    }
  });
});
