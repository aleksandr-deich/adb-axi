import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLogcat } from "../../src/android/logcat.js";
import { belongsTo, parsePs } from "../../src/android/ps.js";
import { appProcesses, assertMarkName } from "../../src/commands/logs/marks.js";
import { startedPids } from "../../src/commands/logs/scope.js";
import { logcatCommand } from "../../src/commands/logs/window.js";
import { timeoutWindow } from "../../src/commands/wait/log.js";
import { AdbAxiError } from "../../src/core/errors.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

const synthetic30 = (name: string): string =>
  readFileSync(join(FIXTURES_DIR, "synthetic", "30", name), "utf8");

describe("parsePs", () => {
  it("reads pid and name rows after the PID NAME header", () => {
    const processes = parsePs(synthetic30("ps-pid-name.txt"));
    expect(processes).toHaveLength(7);
    expect(processes?.[0]).toEqual({ pid: 1, name: "init" });
    expect(processes?.[5]).toEqual({ pid: 6050, name: "dev.probe:remote" });
  });

  it("does not take output without the header for a process list", () => {
    expect(parsePs("")).toBeNull();
    expect(parsePs("ps: bad -o 'NAME'\n")).toBeNull();
  });

  it("matches a package's main process and its colon processes, nothing longer", () => {
    expect(belongsTo({ pid: 1, name: "dev.probe" }, "dev.probe")).toBe(true);
    expect(belongsTo({ pid: 1, name: "dev.probe:remote" }, "dev.probe")).toBe(true);
    expect(belongsTo({ pid: 1, name: "dev.probe.test" }, "dev.probe")).toBe(false);
    expect(belongsTo({ pid: 1, name: "dev.probe2" }, "dev.probe")).toBe(false);
  });

  it("keeps only package-named processes for a mark", () => {
    expect(appProcesses(parsePs(synthetic30("ps-pid-name.txt")) ?? [])).toEqual([
      { pid: 4400, name: "com.other.app" },
      { pid: 6044, name: "dev.probe" },
      { pid: 6050, name: "dev.probe:remote" },
    ]);
  });
});

describe("startedPids", () => {
  const lines = parseLogcat(synthetic30("logcat-epoch-window.txt")).lines;

  it("takes the pids ActivityManager started for the package, main and colon processes", () => {
    expect(startedPids(lines, "dev.probe")).toEqual([6030, 6044]);
    expect(startedPids(lines, "com.other.app")).toEqual([4400]);
    expect(startedPids(lines, "dev.pro")).toEqual([]);
  });

  it("ignores a Start proc text logged by another tag", () => {
    const forged = parseLogcat(
      "         1790834111.250   900   900 I SomeApp  : Start proc 1:dev.probe/u0a1 for x\n",
    ).lines;
    expect(startedPids(forged, "dev.probe")).toEqual([]);
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

describe("logcatCommand", () => {
  it("is always a bounded dump", () => {
    expect(logcatCommand(1790834110420)).toBe("logcat -d -v epoch -T 1790834110.420");
    expect(logcatCommand(1790834110005, 10213)).toBe(
      "logcat -d -v epoch -T 1790834110.005 --uid 10213",
    );
  });
});
