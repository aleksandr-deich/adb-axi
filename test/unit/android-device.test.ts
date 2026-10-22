import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeviceClock } from "../../src/android/clock.js";
import {} from "../../src/android/foreground.js";
import { runningProcesses } from "../../src/android/app-processes.js";
import {} from "../../src/android/recents.js";
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

const PS = "ps -A -o PID,UID,NAME";
const PS_HEADER = { stdout: "  PID   UID NAME\n" };

const running = (adb: AdbClient, pkg: string) =>
  runningProcesses(adb, SERIAL, { pkg, uid: 10213 }, options());

describe("pidof", () => {
  it("never reads an inconsistent answer as not running", async () => {
    const { adb } = device({ [PS]: PS_HEADER, "pidof 'dev.probe'": { stdout: "", exit: 0 } });
    expect(await failure(running(adb, "dev.probe"))).toMatchObject({
      code: "INVALID_OUTPUT",
      step: "reading the pid of dev.probe",
    });
  });

  it("reports a failed pidof as REMOTE_EXIT with its stderr", async () => {
    const { adb } = device({
      [PS]: PS_HEADER,
      "pidof 'dev.probe'": { stderr: "/system/bin/sh: pidof: inaccessible\n", exit: 126 },
    });
    expect(await failure(running(adb, "dev.probe"))).toEqual({
      error: "reading the pid of dev.probe failed: `pidof 'dev.probe'` exited 126",
      code: "REMOTE_EXIT",
      step: "reading the pid of dev.probe",
      exit: 126,
      stderr: "/system/bin/sh: pidof: inaccessible",
    });
  });

  it("refuses a package name that the device shell would read as syntax, before any call", async () => {
    const { f, adb } = device({});
    expect(await failure(running(adb, "dev.probe; reboot"))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(f.calls()).toEqual([]);
  });
});

describe("readDeviceClock", () => {
  it("refuses a reading that is not a clock", async () => {
    const { adb } = device({ "date '+%s.%N %z'": { stdout: "Thu Oct  1 07:57:00 CEST 2026\n" } });
    expect(await failure(readDeviceClock(adb, SERIAL, options()))).toMatchObject({
      code: "INVALID_OUTPUT",
      step: "reading the device clock",
    });
  });
});
