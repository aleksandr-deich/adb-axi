import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  commandLine,
  noop,
  okLine,
  render,
  runHint,
  TextBlock,
  withDeviceSelection,
} from "../../src/core/output.js";

describe("output", () => {
  it("builds the mutation lead line and no-op state", () => {
    expect(okLine("stop", "com.example.notes", noop("already not running"))).toBe(
      "stop com.example.notes -> already not running (no-op)",
    );
  });

  it("renders TOON and JSON from one object with the same fields", () => {
    const data = {
      ok: okLine("kill", "com.example.notes", "process gone, task kept in recents"),
      kill: { pid_before: 5120, pid_after: null, method: "am kill", note: undefined },
      help: ["Run `adb-axi app restore com.example.notes` to reopen it"],
    };
    const toon = render(data, "toon");
    const json = render(data, "json");
    // JSON alone adds the no-op flag a script can read; TOON says `(no-op)` in the line.
    expect({ ...(decode(toon) as object), noop: false }).toEqual(JSON.parse(json));
    expect(json).not.toContain('"note"');
    expect(toon).not.toContain("note:");
  });

  it("adds a boolean no-op flag to a JSON mutation result, right after its ok line", () => {
    const data = { ok: okLine("uninstall", "com.x", noop("already not installed")) };
    expect(render(data, "json")).toBe(
      '{\n  "ok": "uninstall com.x -> already not installed (no-op)",\n  "noop": true\n}',
    );
    expect(render(data, "toon")).toBe("ok: uninstall com.x -> already not installed (no-op)");
    expect(render({ app: { installed: false } }, "json")).not.toContain("noop");
  });

  it("prints a text block of several lines as a TOON list, and as one JSON string", () => {
    const data = {
      exit: 0,
      stdout: new TextBlock("Physical density: 480\nOverride density: 560\nplain, text"),
      stderr: new TextBlock("one line"),
      help: ["Run `adb-axi doctor`"],
    };
    const toon = render(data, "toon");
    expect(toon).toBe(
      [
        "exit: 0",
        "stdout[3]:",
        '  - "Physical density: 480"',
        '  - "Override density: 560"',
        '  - "plain, text"',
        "stderr: one line",
        "help[1]: Run `adb-axi doctor`",
      ].join("\n"),
    );
    expect(decode(toon)).toEqual({
      exit: 0,
      stdout: ["Physical density: 480", "Override density: 560", "plain, text"],
      stderr: "one line",
      help: ["Run `adb-axi doctor`"],
    });
    expect(JSON.parse(render(data, "json"))).toEqual({
      exit: 0,
      stdout: "Physical density: 480\nOverride density: 560\nplain, text",
      stderr: "one line",
      help: ["Run `adb-axi doctor`"],
    });
  });

  it("adds the selected device to every suggested command that acts on a device", () => {
    const output = {
      help: [
        "Run `adb-axi app info dev.probe` for its pid",
        "Run `adb-axi logs mark 3potatoes` to record it now",
        "Run `adb-axi shell --full -- 'echo a -- b'` to write it",
        "Run `adb-axi doctor --device emulator-5554` to see why",
        "Run `adb-axi app --help` for its subcommands",
        "Run `adb-axi devices` to see what is attached",
        "Run `adb-axi wait log 'it'\\''s up'` and `adb-axi` again",
        "Or export ANDROID_SERIAL=<serial> in this shell",
      ],
    };
    expect(withDeviceSelection(output, "medium_tablet").help).toEqual([
      "Run `adb-axi app info dev.probe --device medium_tablet` for its pid",
      "Run `adb-axi logs mark 3potatoes --device medium_tablet` to record it now",
      "Run `adb-axi shell --full --device medium_tablet -- 'echo a -- b'` to write it",
      "Run `adb-axi doctor --device emulator-5554` to see why",
      "Run `adb-axi app --help` for its subcommands",
      "Run `adb-axi devices` to see what is attached",
      "Run `adb-axi wait log 'it'\\''s up' --device medium_tablet` and `adb-axi --device medium_tablet` again",
      "Or export ANDROID_SERIAL=<serial> in this shell",
    ]);
    expect(withDeviceSelection({ ok: "x" }, "a")).toEqual({ ok: "x" });
    expect(withDeviceSelection({ help: ["Run `adb-axi logs`"] }, "my phone").help).toEqual([
      "Run `adb-axi logs --device 'my phone'`",
    ]);
  });

  it("says zero explicitly for empty lists", () => {
    // Golden output is what the official encoder prints, not hand-written TOON.
    expect(render({ count: "0 attached, 0 online", devices: [] }, "toon")).toBe(
      'count: "0 attached, 0 online"\ndevices: []',
    );
  });

  it("quotes arguments a shell would split, and keeps placeholders", () => {
    expect(commandLine(["logs", "--device", "emulator-5554"])).toBe(
      "adb-axi logs --device emulator-5554",
    );
    expect(commandLine(["wait", "log", "Displayed com.x"])).toBe(
      "adb-axi wait log 'Displayed com.x'",
    );
    expect(commandLine(["shell", "--", "echo it's"])).toBe("adb-axi shell -- 'echo it'\\''s'");
    expect(commandLine(["logs", "--device", "<serial or avd>"])).toBe(
      "adb-axi logs --device <serial or avd>",
    );
    expect(runHint(["doctor"], "to see why")).toBe("Run `adb-axi doctor` to see why");
  });
});
