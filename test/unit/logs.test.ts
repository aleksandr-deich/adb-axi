import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logcatStream, parseLogcat, type LogLine } from "../../src/android/logcat.js";
import { belongsTo, createCrashParser } from "../../src/android/crash.js";
import { assertMarkName } from "../../src/commands/logs/marks.js";
import { startedPids } from "../../src/commands/logs/scope.js";
import { logcatCommand } from "../../src/commands/logs/window.js";
import { timeoutWindow } from "../../src/commands/wait/log.js";
import { AdbAxiError } from "../../src/core/errors.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

const synthetic30 = (name: string): string =>
  readFileSync(join(FIXTURES_DIR, "synthetic", "30", name), "utf8");

describe("process names", () => {
  it("matches a package's main process and its colon processes, nothing longer", () => {
    expect(belongsTo({ name: "dev.probe" }, "dev.probe")).toBe(true);
    expect(belongsTo({ name: "dev.probe:remote" }, "dev.probe")).toBe(true);
    expect(belongsTo({ name: "dev.probe.test" }, "dev.probe")).toBe(false);
    expect(belongsTo({ name: "dev.probe2" }, "dev.probe")).toBe(false);
  });
});

describe("startedPids", () => {
  const lines = parseLogcat(synthetic30("logcat-epoch-window.txt")).lines;

  it("takes the pids ActivityManager started under the app's uid, printed as u<user>a<app id>", () => {
    expect(startedPids(lines, 10213)).toEqual([6030, 6044]);
    expect(startedPids(lines, 10099)).toEqual([4400]);
    expect(startedPids(lines, 1010213)).toEqual([]);
  });

  it("ignores a Start proc text logged by another tag", () => {
    const forged = parseLogcat(
      "         1790834111.250   900   900 I SomeApp  : Start proc 1:dev.probe/u0a1 for x\n",
    ).lines;
    expect(startedPids(forged, 10001)).toEqual([]);
  });
});

describe("assertMarkName", () => {
  it("accepts file-name-safe names", () => {
    for (const name of ["before-save", "run_2", "v1.2", "A"]) {
      expect(() => {
        assertMarkName(name);
      }).not.toThrow();
    }
  });

  it("rejects durations, spaces, path parts and a leading dash with a usage error", () => {
    for (const name of ["30s", "500ms", "5m", "a b", "../x", "-x", "", "x".repeat(65)]) {
      expect(() => {
        assertMarkName(name);
      }, name).toThrow(AdbAxiError);
    }
  });
});

describe("timeoutWindow", () => {
  it("covers the entire wait with one second of slack in whole minutes", () => {
    expect(timeoutWindow(15_000)).toBe("1m");
    expect(timeoutWindow(59_000)).toBe("1m");
    expect(timeoutWindow(60_000)).toBe("2m");
    expect(timeoutWindow(70_000)).toBe("2m");
  });
});

describe("logcat streaming", () => {
  it("preserves captured lines across byte boundaries, CRLF, markers and a final partial line", () => {
    const text =
      readFileSync(join(FIXTURES_DIR, "captured/35/logcat-crash-java.txt"), "utf8").replaceAll(
        "\n",
        "\r\n",
      ) + "--------- switch to main\r\n         1790834330.000  1  1 I Unicode : café 🐈";
    const expected = parseLogcat(text);
    const input = Buffer.from(text);
    for (const size of [1, 7, 65536]) {
      const lines: LogLine[] = [];
      const parser = logcatStream((line) => lines.push(line));
      for (let offset = 0; offset < input.length; offset += size)
        parser.add(input.subarray(offset, offset + size));
      expect(parser.finish()).toEqual({
        parsed: expected.lines.length,
        unparsed: expected.unparsed,
      });
      expect(lines).toEqual(expected.lines);
    }
  });

  it("rejects an oversized retained line and oversized crash blocks with typed errors", () => {
    const parser = logcatStream(() => {});
    expect(() => {
      parser.add(Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    }).toThrow(AdbAxiError);
    const crashes = createCrashParser();
    const line = parseLogcat("1790834111.000 1 1 E AndroidRuntime: FATAL EXCEPTION: main").lines[0];
    if (line === undefined) throw new Error("missing line");
    crashes.add(line);
    expect(() => {
      crashes.add({ ...line, message: "x".repeat(16 * 1024 * 1024) });
    }).toThrow(AdbAxiError);
  });
});

describe("logcatCommand", () => {
  it("is always a bounded dump", () => {
    expect(logcatCommand(1790834110420)).toBe("logcat -d -v epoch -T 1790834110.420");
    expect(logcatCommand(1790834110005, 10213)).toBe(
      "logcat -d -v epoch -T 1790834110.005 --uid 10213",
    );
  });
});
