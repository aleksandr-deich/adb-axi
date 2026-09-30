import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { commandLine, noop, okLine, render, runHint } from "../../src/core/output.js";

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
    expect(decode(toon)).toEqual(JSON.parse(json));
    expect(json).not.toContain('"note"');
    expect(toon).not.toContain("note:");
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
