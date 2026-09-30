import { describe, expect, it } from "vitest";
import { parseArgs, parseDuration, type ArgsSpec } from "../../src/core/args.js";
import { AdbAxiError, errorObject } from "../../src/core/errors.js";

const spec: ArgsSpec = {
  path: ["logs"],
  helpAvailable: true,
  flags: [
    { name: "--pkg", type: "string", valueName: "<pkg>", description: "app" },
    { name: "--level", type: "enum", values: ["V", "D", "I", "W", "E"], description: "level" },
    { name: "--full", type: "boolean", description: "full" },
    { name: "--since", type: "string", valueName: "<mark|dur>", description: "since" },
  ],
  positionals: [],
};

function fail(tokens: string[], s: ArgsSpec = spec): Record<string, unknown> {
  try {
    parseArgs(tokens, s);
  } catch (error) {
    expect(error).toBeInstanceOf(AdbAxiError);
    expect((error as AdbAxiError).code).toBe("VALIDATION_ERROR");
    return errorObject(error);
  }
  throw new Error(`parseArgs(${tokens.join(" ")}) did not fail`);
}

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1ms", 1],
  ])("parses %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "5", "0s", "1.5s", "-1s", "5h", "s", "30 s", "1e3ms"])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeUndefined();
  });
});

describe("parseArgs", () => {
  it("parses command flags and globals, in both value forms", () => {
    const parsed = parseArgs(
      [
        "--pkg",
        "com.example",
        "--level=W",
        "--full",
        "-s",
        "emulator-5554",
        "--timeout",
        "5s",
        "--debug",
      ],
      spec,
    );
    expect(parsed).toEqual({
      flags: {
        pkg: "com.example",
        level: "W",
        full: true,
        device: "emulator-5554",
        timeout: 5000,
        debug: true,
      },
      positionals: {},
      help: false,
    });
  });

  it("lists the command's valid flags for an unknown flag", () => {
    const error = fail(["--bogus"]);
    expect(error.error).toBe("unknown flag --bogus for `adb-axi logs`");
    expect(error.valid_flags).toEqual([
      "--pkg <pkg>",
      "--level <V|D|I|W|E>",
      "--full",
      "--since <mark|dur>",
      "--device <serial|avd>",
      "--timeout <dur>",
      "--json",
      "--debug",
      "--help",
    ]);
    expect(error.help).toEqual(["Run `adb-axi logs --help` for flag details"]);
    expect(Object.keys(error)).toEqual(["error", "code", "valid_flags", "help"]);
  });

  it("suggests the nearest flag for a typo", () => {
    expect(fail(["--levl", "W"]).error).toBe(
      "unknown flag --levl for `adb-axi logs`; did you mean --level?",
    );
  });

  it("does not point at --help when the command has none", () => {
    expect(fail(["--bogus"], { ...spec, helpAvailable: false }).help).toBeUndefined();
  });

  it("rejects a flag with no value", () => {
    expect(fail(["--pkg"]).error).toBe("--pkg needs a value");
    expect(fail(["--pkg", "--full"]).error).toBe("--pkg needs a value");
    expect(fail(["--pkg="]).error).toBe("--pkg needs a value");
  });

  it("rejects bad durations and enum values", () => {
    expect(fail(["--timeout", "5"]).error).toBe('--timeout value "5" is not a duration');
    const level = fail(["--level", "X"]);
    expect(level.error).toBe('--level value "X" is not one of V, D, I, W, E');
    expect(level.valid_values).toEqual(["V", "D", "I", "W", "E"]);
  });

  it("rejects a repeated flag and a value on a boolean", () => {
    expect(fail(["--pkg", "a", "--pkg", "b"]).error).toBe("--pkg was given more than once");
    expect(fail(["--device", "a", "-s", "b"]).error).toBe("--device was given more than once");
    expect(fail(["--full=yes"]).error).toBe("--full takes no value");
  });

  it("binds positionals and rejects missing and extra ones", () => {
    const withArgs: ArgsSpec = {
      path: ["data", "db"],
      helpAvailable: true,
      flags: [],
      positionals: [
        { name: "pkg", description: "", required: true },
        { name: "sql", description: "", required: false },
      ],
    };
    expect(parseArgs(["com.example"], withArgs).positionals).toEqual({ pkg: "com.example" });
    expect(parseArgs(["com.example", "SELECT 1"], withArgs).positionals).toEqual({
      pkg: "com.example",
      sql: "SELECT 1",
    });
    expect(fail([], withArgs).error).toBe("missing <pkg> for `adb-axi data db`");
    expect(fail(["a", "b", "c"], withArgs).error).toBe(
      'unexpected argument "c" for `adb-axi data db`',
    );
    expect(fail([], withArgs).help).toEqual(["Run `adb-axi data db <pkg> [<sql>] [flags]`"]);
  });

  it("treats everything after -- as positional", () => {
    const shell: ArgsSpec = {
      path: ["shell"],
      helpAvailable: true,
      flags: [],
      positionals: [{ name: "cmd", description: "", required: true, rest: true }],
    };
    expect(parseArgs(["--timeout", "2s", "--", "ls", "--help", "-la"], shell)).toEqual({
      flags: { timeout: 2000 },
      positionals: { cmd: ["ls", "--help", "-la"] },
      help: false,
    });
    expect(fail(["--"], shell).error).toBe("missing <cmd> for `adb-axi shell`");
  });

  it("enforces required flags", () => {
    const wait: ArgsSpec = {
      path: ["wait", "app"],
      helpAvailable: true,
      flags: [
        {
          name: "--state",
          type: "enum",
          values: ["foreground", "running", "stopped"],
          description: "",
          required: true,
        },
      ],
      positionals: [{ name: "pkg", description: "", required: true }],
    };
    expect(fail(["com.example"], wait).error).toBe("--state is required for `adb-axi wait app`");
  });

  it("returns a help request before checking required arguments", () => {
    const parsed = parseArgs(["--help"], {
      ...spec,
      positionals: [{ name: "pkg", description: "", required: true }],
    });
    expect(parsed.help).toBe(true);
  });
});
