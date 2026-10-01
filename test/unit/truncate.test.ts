import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capLines,
  MAX_BYTES,
  MAX_LINES,
  shownLine,
  splitLines,
  truncateField,
  writeFullOutput,
} from "../../src/core/truncate.js";

const lines = (n: number, width = 10): string[] =>
  Array.from({ length: n }, (_, i) => String(i + 1).padStart(width, "0"));

describe("capLines", () => {
  it("keeps everything under the caps", () => {
    const window = capLines(lines(12));
    expect(window).toEqual({ lines: lines(12), total: 12, truncated: false });
  });

  it("stops at 50 lines by default and says how many were shown", () => {
    const window = capLines(lines(80));
    expect(MAX_LINES).toBe(50);
    expect(window.lines).toHaveLength(50);
    expect(window.lines[0]).toBe(lines(1)[0]);
    expect(window.truncated).toBe(true);
    expect(shownLine(window)).toBe("50 of 80 lines");
  });

  it("keeps the last lines for log dumps", () => {
    const window = capLines(lines(80), { keep: "tail" });
    expect(window.lines).toEqual(lines(80).slice(30));
  });

  it("stops at 4 kB by default", () => {
    expect(MAX_BYTES).toBe(4096);
    const window = capLines(lines(45, 199));
    // Each line is 199 chars + newline = 200 bytes, so 20 lines fit in 4096 bytes.
    expect(window.lines).toHaveLength(20);
    expect(window.truncated).toBe(true);
    expect(shownLine(window)).toBe("20 of 45 lines");
  });

  it("shows a cut first line rather than nothing when one line exceeds the byte cap", () => {
    const window = capLines(["x".repeat(10_000), "y"]);
    expect(window.lines).toHaveLength(1);
    expect(window.lines[0]).toHaveLength(4096);
    expect(window.truncated).toBe(true);
  });

  it("does not call a line of exactly the byte cap cut", () => {
    const window = capLines(["x".repeat(4096)]);
    expect(window).toEqual({ lines: ["x".repeat(4096)], total: 1, truncated: false });
    expect(shownLine(capLines(["x".repeat(4096), "y"]))).toBe("1 of 2 lines");
  });

  it("says how many bytes of a cut line are shown", () => {
    expect(shownLine(capLines(["x".repeat(10_000)]))).toBe(
      "1 of 1 lines, cut at 4096 of 10000 bytes",
    );
    expect(shownLine(capLines(["é".repeat(10), "y"], { maxBytes: 5 }))).toBe(
      "1 of 2 lines, cut at 4 of 20 bytes",
    );
  });

  it("does not split multi-byte characters", () => {
    const window = capLines(["é".repeat(10)], { maxBytes: 5 });
    expect(window.lines).toEqual(["éé"]);
  });

  it("treats a trailing newline as the end of the last line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(capLines("")).toEqual({ lines: [], total: 0, truncated: false });
  });
});

describe("truncateField", () => {
  it("passes short values through", () => {
    expect(truncateField("short", 10)).toBe("short");
  });

  it("cuts long values and states the total length", () => {
    const message = `Room cannot verify the data integrity${"!".repeat(375)}`;
    expect(message).toHaveLength(412);
    expect(truncateField(message, 37)).toBe(
      "Room cannot verify the data integrity... (truncated, 412 chars total)",
    );
  });

  it("counts user-visible characters", () => {
    expect(truncateField("👍🏽👍🏽👍🏽", 1)).toBe("👍🏽... (truncated, 3 chars total)");
  });
});

describe("writeFullOutput", () => {
  let home: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.ADB_AXI_HOME;
    home = mkdtempSync(join(tmpdir(), "adb-axi-home-"));
    process.env.ADB_AXI_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ADB_AXI_HOME;
    else process.env.ADB_AXI_HOME = previous;
  });

  it("writes the complete text under out/ and returns the path", () => {
    const path = writeFullOutput("logs-before-save-1012", "all\nthe\nlines\n");
    expect(path).toBe(join(home, "out", "logs-before-save-1012.txt"));
    expect(readFileSync(path, "utf8")).toBe("all\nthe\nlines\n");
  });

  it("never overwrites an earlier file", () => {
    const first = writeFullOutput("shell", "one");
    const second = writeFullOutput("shell", "two");
    expect(second).toBe(join(home, "out", "shell-2.txt"));
    expect(readFileSync(first, "utf8")).toBe("one");
  });

  it("keeps file names inside out/", () => {
    const path = writeFullOutput("../../etc/passwd", "x");
    expect(path).toBe(join(home, "out", "etc-passwd.txt"));
  });
});
