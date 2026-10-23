import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProcesses } from "../../src/android/app-processes.js";
import { parseLaunchCrashes } from "../../src/android/launch-crash.js";
import { parseLogcat } from "../../src/android/logcat.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";

function fixture(api: number, file: string): string {
  return readFileSync(
    join(FIXTURES_DIR, "captured", String(api), `launch-crashes-${file}.txt`),
    "utf8",
  );
}

function lines(api: number, file: string) {
  const parsed = parseLogcat(fixture(api, file));
  expect(parsed.unparsed).toBe(0);
  return parsed.lines;
}

describe("parseLaunchCrashes", () => {
  it("L1: finds no crash in a running launch event buffer", () => {
    expect(parseLaunchCrashes(lines(29, "running"))).toEqual([]);
  });

  it("L2: attributes a Java crash using its matching process-start event", () => {
    expect(parseLaunchCrashes(lines(29, "java-start"))).toEqual([
      {
        key: expect.any(String) as unknown,
        pid: 2201,
        userId: 0,
        uid: 10116,
        process: "dev.probe",
      },
    ]);
  });

  it("L3: attributes a pre-existing Java process using prelaunch evidence", () => {
    const prelaunch = parseProcesses(fixture(30, "prelaunch"));
    expect(parseLaunchCrashes(lines(30, "java-preexisting"), prelaunch)).toEqual([
      {
        key: expect.any(String) as unknown,
        pid: 2642,
        userId: 0,
        uid: 10130,
        process: "dev.probe",
      },
    ]);
  });

  it("L4: retains an unattributed Java crash without guessing its uid", () => {
    expect(parseLaunchCrashes(lines(35, "java-preexisting"))).toEqual([
      {
        key: expect.any(String) as unknown,
        pid: 3347,
        userId: 0,
        uid: null,
        process: "dev.probe",
      },
    ]);
  });

  it("L5: takes a confirmed native crash pid and uid from the tombstone, not system_server", () => {
    expect(parseLaunchCrashes(lines(35, "native"))).toEqual([
      {
        key: expect.any(String) as unknown,
        pid: 3687,
        userId: 0,
        uid: 10207,
        process: "dev.probe",
      },
    ]);
  });

  it("L6: refuses native attribution without a confirming process-death event", () => {
    const withoutDeath = lines(35, "native").filter((line) => line.tag !== "am_proc_died");
    expect(parseLaunchCrashes(withoutDeath)).toEqual([]);
  });
});
