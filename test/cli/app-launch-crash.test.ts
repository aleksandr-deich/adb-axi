import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_CRASH_COMMAND } from "../../src/android/launch-crash.js";
import { isProcessAlive } from "../../src/core/exec.js";
import type { FakeAdb } from "../fake-adb/harness.js";
import {
  FOREGROUND,
  METADATA,
  PACKAGE,
  PROCESSES,
  START,
  both,
  expectClean,
  lifecycleDevices,
  shell,
} from "../helpers/app-lifecycle.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});
const { deviceWithRules } = lifecycleDevices((value) => {
  fake = value;
});
const RECENTS = "dumpsys activity recents";

const captures = [
  { api: 29, pid: 1985, crashPid: 2056 },
  { api: 37, pid: 7224, crashPid: 7329 },
];

function capture(api: number, name: string) {
  return { stdoutFile: `captured/${api}/launch-${name}.txt` };
}

function device(api: number, crashed: boolean): FakeAdb {
  return deviceWithRules([
    { match: shell(PACKAGE), respond: capture(api, "package") },
    { match: shell(RECENTS), respond: capture(api, "recents-running") },
    { match: shell(METADATA), respond: capture(api, "activity-metadata") },
    {
      match: shell(PROCESSES),
      when: { launched: "yes" },
      respond: capture(api, "process-crashed"),
    },
    { match: shell(PROCESSES), respond: capture(api, "process-running") },
    { match: shell(FOREGROUND), respond: capture(api, "foreground-running") },
    {
      match: shell(LAUNCH_CRASH_COMMAND),
      when: { launched: "yes" },
      respond: capture(api, "events-crashed"),
    },
    {
      match: shell(LAUNCH_CRASH_COMMAND),
      respond: capture(api, crashed ? "events-running" : "events-crashed"),
    },
    {
      match: shell(START),
      respond: crashed
        ? { ...capture(api, "am-crashed"), ...(api === 29 ? { hang: true } : {}) }
        : capture(api, "am-running"),
      ...(crashed ? { set: { launched: "yes" } } : {}),
    },
  ]);
}

describe("launch crash evidence", () => {
  it.each(captures.flatMap((row) => ["start", "restore"].map((command) => ({ ...row, command }))))(
    "reports APP_DIED_ON_START for API $api $command, even with a live process or a hung am wait",
    async ({ api, command, crashPid }) => {
      const f = device(api, true);
      const { toon, json, data } = await both(["app", command, "dev.probe"], f);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "APP_DIED_ON_START",
        error: `the dev.probe process of dev.probe/.MainActivity crashed during its ${command}`,
        last: { state: "crashed", pid: crashPid, foreground: "-" },
      });
      expect(data.help).toContain(
        "Run `adb-axi logs crash --pkg dev.probe --since 1m` for the crash",
      );
      expect(toon.durationMs).toBeLessThan(10_000);
      expect(json.durationMs).toBeLessThan(10_000);
      expect(f.calls().filter((call) => call.argv[3] === START)).toHaveLength(2);
      for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
      expectClean(f);
    },
  );

  it.each(captures)(
    "reports an ordinary API $api start as running despite the previous crash record",
    async ({ api, pid }) => {
      const f = device(api, false);
      const { toon, data } = await both(["app", "start", "dev.probe"], f);
      expect(toon.exitCode).toBe(0);
      expect(data).toMatchObject({
        ok: "start dev.probe -> foreground (already on top, intent delivered to it)",
        app: { pid, recreated: false },
      });
      expectClean(f);
    },
  );
});
