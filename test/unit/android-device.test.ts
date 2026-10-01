import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeviceClock } from "../../src/android/clock.js";
import { readForeground } from "../../src/android/foreground.js";
import { listPackages, readPackage } from "../../src/android/packages.js";
import { pidof } from "../../src/android/pidof.js";
import { readLru, readProcesses } from "../../src/android/processes.js";
import { readRecents } from "../../src/android/recents.js";
import { AdbClient } from "../../src/adb/run.js";
import { Deadline } from "../../src/core/deadline.js";
import { AdbAxiError, errorObject } from "../../src/core/errors.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Scenario } from "../fake-adb/scenario.js";

const SERIAL = "emulator-5554";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

/** A fake device answering each shell command with the given response. */
function device(
  answers: Record<string, Response>,
  extra: Partial<Scenario> = {},
): { f: FakeAdb; adb: AdbClient } {
  fake = createFakeAdb({
    ...extra,
    rules: Object.entries(answers).map(([command, respond]) => ({
      match: ["-s", SERIAL, "shell", command],
      respond,
    })),
  });
  return { f: fake, adb: new AdbClient(join(fake.binDir, "adb"), { env: fake.env }) };
}

const options = () => ({ deadline: new Deadline(10_000) });

async function failure(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdbAxiError);
    return errorObject(error);
  }
  throw new Error("expected the read to fail");
}

/** Every call went to the one device with `-s <serial>`, and every call was answered. */
function expectAddressed(f: FakeAdb, commands: string[]): void {
  expect(f.unmatched()).toEqual([]);
  expect(f.calls().map((call) => call.argv)).toEqual(
    commands.map((command) => ["-s", SERIAL, "shell", command]),
  );
}

describe("pidof", () => {
  it("reads the pid of a running app from the captured output", async () => {
    const { f, adb } = device({
      "pidof dev.probe": { stdoutFile: "captured/37/pidof-running.txt" },
    });
    expect(await pidof(adb, SERIAL, "dev.probe", options())).toEqual([7882]);
    expectAddressed(f, ["pidof dev.probe"]);
  });

  it("treats pidof's exit 1 with no output as not running", async () => {
    const { adb } = device({
      "pidof dev.probe": { stdoutFile: "captured/35/pidof-not-running.txt", exit: 1 },
    });
    expect(await pidof(adb, SERIAL, "dev.probe", options())).toEqual([]);
  });

  it("reads several pids (API 29, synthetic)", async () => {
    const { adb } = device(
      { "pidof dev.probe": { stdoutFile: "synthetic/29/pidof-two.txt" } },
      { synthetic: true, source: "synthetic/29/index.json" },
    );
    expect(await pidof(adb, SERIAL, "dev.probe", options())).toEqual([5120, 5187]);
  });

  it("never reads an inconsistent answer as not running", async () => {
    const { adb } = device({ "pidof dev.probe": { stdout: "", exit: 0 } });
    expect(await failure(pidof(adb, SERIAL, "dev.probe", options()))).toMatchObject({
      code: "INVALID_OUTPUT",
      step: "reading the pid of dev.probe",
    });
  });

  it("reports a failed pidof as REMOTE_EXIT with its stderr", async () => {
    const { adb } = device({
      "pidof dev.probe": { stderr: "/system/bin/sh: pidof: inaccessible\n", exit: 126 },
    });
    expect(await failure(pidof(adb, SERIAL, "dev.probe", options()))).toEqual({
      error: "reading the pid of dev.probe failed: `pidof dev.probe` exited 126",
      code: "REMOTE_EXIT",
      step: "reading the pid of dev.probe",
      exit: 126,
      stderr: "/system/bin/sh: pidof: inaccessible",
    });
  });

  it("refuses a package name that the device shell would read as syntax, before any call", async () => {
    const { f, adb } = device({});
    expect(await failure(pidof(adb, SERIAL, "dev.probe; reboot", options()))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(f.calls()).toEqual([]);
  });
});

describe("packages", () => {
  it("reads an installed package and a missing one from the captured output", async () => {
    const { f, adb } = device({
      "dumpsys package dev.probe": { stdoutFile: "captured/35/dumpsys-package-release.txt" },
      "dumpsys package dev.probe.missing": {
        stdoutFile: "captured/35/dumpsys-package-absent.txt",
      },
    });
    expect(await readPackage(adb, SERIAL, "dev.probe", options())).toMatchObject({
      installed: true,
      debuggable: false,
      uid: 10213,
    });
    expect(await readPackage(adb, SERIAL, "dev.probe.missing", options())).toBeNull();
    expectAddressed(f, ["dumpsys package dev.probe", "dumpsys package dev.probe.missing"]);
  });

  it("lists third-party packages with versionCode and uid (API 29, synthetic)", async () => {
    const { f, adb } = device(
      {
        "pm list packages --show-versioncode -U -3": {
          stdoutFile: "synthetic/29/pm-list-packages-versioncode-uid.txt",
        },
      },
      { synthetic: true, source: "synthetic/29/index.json" },
    );
    expect(await listPackages(adb, SERIAL, { ...options(), thirdParty: true })).toEqual([
      { package: "com.example.notes", versionCode: 57, uid: 10124 },
      { package: "dev.probe", versionCode: 1, uid: 10123 },
    ]);
    expectAddressed(f, ["pm list packages --show-versioncode -U -3"]);
  });

  it("lists every package without -3", async () => {
    const { f, adb } = device({
      "pm list packages --show-versioncode -U": {
        stdoutFile: "captured/37/pm-list-packages.txt",
      },
    });
    expect((await listPackages(adb, SERIAL, options())).length).toBe(268);
    expectAddressed(f, ["pm list packages --show-versioncode -U"]);
  });
});

describe("activity manager reads", () => {
  it("reads the foreground, the processes, the LRU list and recents", async () => {
    const { f, adb } = device({
      "dumpsys activity activities": {
        stdoutFile: "captured/37/dumpsys-activity-activities-launcher-front.txt",
      },
      "dumpsys activity processes dev.probe": {
        stdoutFile: "captured/37/dumpsys-activity-processes-probe-previous.txt",
      },
      "dumpsys activity lru": { stdoutFile: "captured/37/dumpsys-activity-lru-previous.txt" },
      "dumpsys activity recents": {
        stdoutFile: "captured/37/dumpsys-activity-recents-after-kill.txt",
      },
    });
    expect((await readForeground(adb, SERIAL, options()))?.package).toBe(
      "com.google.android.apps.nexuslauncher",
    );
    expect(await readProcesses(adb, SERIAL, "dev.probe", options())).toMatchObject([
      { pid: 7882, importance: "previous" },
    ]);
    expect((await readLru(adb, SERIAL, options())).find((e) => e.pid === 7882)?.adjLabel).toBe(
      "prev",
    );
    expect((await readRecents(adb, SERIAL, options()))[1]?.package).toBe("dev.probe");
    expectAddressed(f, [
      "dumpsys activity activities",
      "dumpsys activity processes dev.probe",
      "dumpsys activity lru",
      "dumpsys activity recents",
    ]);
  });
});

describe("readDeviceClock", () => {
  it("reads the device clock and its UTC offset in one call (API 29, synthetic)", async () => {
    const { f, adb } = device(
      { "date '+%s.%N %z'": { stdoutFile: "synthetic/29/date-epoch-zone.txt" } },
      { synthetic: true, source: "synthetic/29/index.json" },
    );
    expect(await readDeviceClock(adb, SERIAL, options())).toEqual({
      epochMs: 1790834220608,
      logcatTime: "1790834220.608",
      utcOffsetMinutes: 120,
    });
    expectAddressed(f, ["date '+%s.%N %z'"]);
  });

  it("refuses a reading that is not a clock", async () => {
    const { adb } = device({ "date '+%s.%N %z'": { stdout: "Thu Oct  1 07:57:00 CEST 2026\n" } });
    expect(await failure(readDeviceClock(adb, SERIAL, options()))).toMatchObject({
      code: "INVALID_OUTPUT",
      step: "reading the device clock",
    });
  });
});
