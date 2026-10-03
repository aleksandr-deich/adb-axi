import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBoot } from "../../src/android/boot.js";
import { parseInstrumentations } from "../../src/android/holders.js";
import { splitSections } from "../../src/device/columns.js";
import { parseAvailableBytes } from "../../src/commands/doctor/device-checks.js";
import { parseAdbVersion } from "../../src/commands/doctor/host-checks.js";
import { settle, tildePath } from "../../src/commands/doctor/result.js";
import { AdbAxiError } from "../../src/core/errors.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

const captured = (path: string): string =>
  readFileSync(join(FIXTURES_DIR, "captured", path), "utf8");

describe("splitSections", () => {
  it("splits on marker lines, drops blanks and keeps an empty section empty", () => {
    const sections = splitSections("@a\n1\n\n2\r\n@b\n@c\n  x  \n");
    expect([...sections]).toEqual([
      ["a", ["1", "2"]],
      ["b", []],
      ["c", ["x"]],
    ]);
  });
});

describe("parseBoot", () => {
  it("reads a finished boot and the uptime in whole seconds (a real /proc/uptime)", () => {
    const uptime = captured("35/proc-uptime.txt");
    expect(parseBoot(`@boot_completed\n1\n@uptime\n${uptime}`)).toEqual({
      bootCompleted: true,
      uptimeS: 1141,
    });
  });

  it("reads an unset property as a boot that is not finished", () => {
    expect(parseBoot("@boot_completed\n\n@uptime\n131.54 400.00\n")).toEqual({
      bootCompleted: false,
      uptimeS: 131,
    });
    expect(parseBoot("@boot_completed\n0\n@uptime\n5.00 5.00\n")?.bootCompleted).toBe(false);
  });

  it("leaves the uptime unknown when /proc/uptime printed nothing usable", () => {
    expect(parseBoot("@boot_completed\n1\n@uptime\n")?.uptimeS).toBeNull();
    expect(parseBoot("@boot_completed\n1\n@uptime\nnot a number\n")?.uptimeS).toBeNull();
  });

  it("refuses output it cannot read instead of guessing", () => {
    expect(parseBoot("")).toBeNull();
    expect(parseBoot("1\n1141.19 3978.79\n")).toBeNull();
    expect(parseBoot("@boot_completed\nmaybe\n@uptime\n1.00 1.00\n")).toBeNull();
  });
});

describe("parseInstrumentations", () => {
  const RUNNER = "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner";
  const section = (header: string, ...fields: string[]): string =>
    [
      "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)",
      "  All known processes:",
      "  Active instrumentation:",
      header,
      ...fields,
      "",
      "  OOM levels:",
      "    SCHED_GROUP_BACKGROUND=0",
    ].join("\n");
  const header = (component: string, finished = false): string =>
    `    Instrumentation #0: ActiveInstrumentation{4be1f09 {${component}}${finished ? " FINISHED" : ""} 1 procs}`;

  it("finds none in a real dump", () => {
    expect(
      parseInstrumentations(captured("35/dumpsys-activity-processes-probe-front.txt")),
    ).toEqual([]);
    expect(
      parseInstrumentations(captured("37/dumpsys-activity-processes-probe-front.txt")),
    ).toEqual([]);
  });

  it("reads the package, the component and whether UiAutomation is attached", () => {
    const dump = section(
      header(RUNNER),
      `      mClass=ComponentInfo{${RUNNER}} mFinished=false`,
      "      mUiAutomationConnection=android.app.UiAutomationConnection@5a7c3f1",
    );
    expect(parseInstrumentations(dump)).toEqual([
      {
        kind: "instrumentation",
        package: "com.example.notes.test",
        component: RUNNER,
        uiAutomation: true,
        pids: [],
      },
    ]);
  });

  it("marks an instrumentation without a UiAutomation connection", () => {
    const dump = section(header(RUNNER), `      mClass=ComponentInfo{${RUNNER}} mFinished=false`);
    expect(parseInstrumentations(dump)).toMatchObject([{ uiAutomation: false }]);
  });

  it("ignores a finished instrumentation and reads several, each with its own connection", () => {
    expect(parseInstrumentations(section(header(RUNNER, true)))).toEqual([]);

    const dump = [
      "  Active instrumentation:",
      header("a.one/.Runner"),
      "      mUiAutomationConnection=android.app.UiAutomationConnection@1",
      "mHasBackgroundActivityStartsPermission=false",
      "    Instrumentation #1: ActiveInstrumentation{77aa {b.two/.Runner} 1 procs}",
      "      mClass=ComponentInfo{b.two/.Runner} mFinished=false",
      "    Instrumentation #2: ActiveInstrumentation{88bb {c.three/.Runner} FINISHED 1 procs}",
      "      mUiAutomationConnection=android.app.UiAutomationConnection@3",
      "  OOM levels:",
    ].join("\n");
    expect(parseInstrumentations(dump).map((h) => [h.package, h.uiAutomation])).toEqual([
      ["a.one", true],
      ["b.two", false],
    ]);
  });

  it("does not read a UiAutomation line outside the section", () => {
    const dump = `${section(header(RUNNER))}\n      mUiAutomationConnection=elsewhere\n`;
    expect(parseInstrumentations(dump)).toMatchObject([{ uiAutomation: false }]);
  });
});

describe("parseAvailableBytes", () => {
  it("reads the Available column of the last line in bytes", () => {
    const df =
      "Filesystem       1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-48   5898520 2788180   3110340  48% /data\n";
    expect(parseAvailableBytes(df)).toBe(3_110_340 * 1024);
  });

  it("does not care what the filesystem is called", () => {
    const df =
      "Filesystem 1K-blocks Used Available Use% Mounted on\n/data/media 100 40 60 40% /data\n";
    expect(parseAvailableBytes(df)).toBe(60 * 1024);
  });

  it("is unknown for anything it cannot read", () => {
    expect(parseAvailableBytes("")).toBeNull();
    expect(parseAvailableBytes("df: /data: No such file or directory\n")).toBeNull();
    expect(parseAvailableBytes("Filesystem 1K-blocks Used Available Use% Mounted on\n")).toBeNull();
    expect(parseAvailableBytes("header\n/dev/x a b c 1% /data\n")).toBeNull();
  });
});

describe("parseAdbVersion", () => {
  it("takes the platform-tools version without its build suffix (the real adb 37 output)", () => {
    expect(parseAdbVersion(captured("host/adb-version.txt"))).toBe("37.0.0");
  });

  it("is unknown without a Version line", () => {
    expect(parseAdbVersion("Android Debug Bridge version 1.0.41\n")).toBeUndefined();
  });
});

describe("tildePath", () => {
  it("collapses the home directory only as a whole leading path", () => {
    expect(tildePath("/Users/a/sdk/adb", "/Users/a")).toBe("~/sdk/adb");
    expect(tildePath("/Users/ab/sdk/adb", "/Users/a")).toBe("/Users/ab/sdk/adb");
    expect(tildePath("/opt/adb", "")).toBe("/opt/adb");
  });
});

describe("settle", () => {
  const throwing = (code: ConstructorParameters<typeof AdbAxiError>[0], message: string) => () =>
    Promise.reject(new AdbAxiError(code, message));

  it("turns a device that does not answer into a failed row on one line", async () => {
    for (const code of ["TIMEOUT", "DEVICE_OFFLINE", "ADB_SERVER_UNREACHABLE"] as const) {
      expect(await settle("boot", throwing(code, "it\n did   not\nanswer"))).toEqual({
        check: "boot",
        status: "failed",
        detail: "it did not answer",
        help: [],
      });
    }
  });

  it("turns output it cannot read into a warning", async () => {
    for (const code of ["REMOTE_EXIT", "INVALID_OUTPUT"] as const) {
      expect(await settle("ime", throwing(code, "bad"))).toMatchObject({
        status: "warn",
        detail: "could not read it: bad",
      });
    }
  });

  it("lets a bug through instead of hiding it in a row", async () => {
    await expect(settle("ime", throwing("INTERNAL_ERROR", "boom"))).rejects.toThrow("boom");
    await expect(settle("ime", () => Promise.reject(new Error("plain")))).rejects.toThrow("plain");
  });
});
