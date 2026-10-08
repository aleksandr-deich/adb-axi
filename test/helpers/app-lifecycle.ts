import { decode } from "@toon-format/toon";
import { expect } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli, type CliRun } from "./run.js";
import { sharedWithToon } from "./json.js";

export const COMMAND_TIMEOUT_MS = 15_000;
// Deadline-outcome cases still need the normal command budget for device discovery
// and prerequisite reads on slow runners before reaching the step under test.
export const STOP_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
// Leave two seconds after am's delay for prerequisite/observation calls, so the
// command deadline (not just the two-second settle window) ends these cases.
export const SHORT_TIMEOUT_MS = 10_000;
export const SHORT_START_DELAY_MS = SHORT_TIMEOUT_MS - 2000;
export const TIMING_MARGIN_MS = 5_000;

export const SERIAL = "emulator-5554";
export const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;

export const CURRENT_USER = "am get-current-user";
export const RESOLVE =
  "cmd package query-activities --components --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p dev.probe";
export const KERNEL_UIDS = "ps -A -o PID,UID";
export const PROCESSES = "dumpsys activity processes dev.probe";
export const PROCESS_RUNNING = {
  stdoutFile: "captured/35/dumpsys-activity-processes-probe-front.txt",
};
export const PACKAGE = "dumpsys package dev.probe";
export const FOREGROUND = "dumpsys activity activities";
export const PIDOF = "pidof dev.probe";
export const FORCE_STOP = "am force-stop --user 0 dev.probe";
export const CLEAR = "pm clear --user 0 dev.probe";
export const DATA_FILES = "run-as dev.probe --user 0 find . -type f";
export const startOf = (activity: string): string =>
  `am start --user 0 -W -n 'dev.probe/${activity}'`;
export const START = startOf(".MainActivity");
export const metadataOf = (activity: string, userId = 0): string =>
  `cmd package resolve-activity --user ${userId} -n 'dev.probe/${activity}'`;
export const METADATA = metadataOf(".MainActivity");

export function activityInfo(activity = ".MainActivity", process = "dev.probe"): Response {
  return {
    stdout: [
      "priority=0 preferredOrder=0 match=0x100000 specificIndex=-1 isDefault=false",
      "ActivityInfo:",
      ` name=${activity.startsWith(".") ? `dev.probe${activity}` : activity}`,
      " packageName=dev.probe",
      ...(process === "dev.probe" ? [] : [` processName=${process}`]),
      " enabled=true exported=true directBootAware=false",
      " ApplicationInfo:",
      "  packageName=dev.probe",
      "  processName=dev.probe",
      "",
    ].join("\n"),
  };
}

export const INSTALLED = { stdoutFile: "captured/35/dumpsys-package-debug.txt" };
export const INSTALLED_RELEASE = { stdoutFile: "captured/35/dumpsys-package-release.txt" };
export const ABSENT = { stdoutFile: "captured/35/dumpsys-package-absent.txt" };
export const PROBE_FRONT = {
  stdoutFile: "captured/35/dumpsys-activity-activities-probe-front.txt",
};
export const LAUNCHER_FRONT = {
  stdoutFile: "captured/35/dumpsys-activity-activities-launcher-front.txt",
};
export const PROBE_RUNNING = { stdoutFile: "captured/35/pidof-running.txt" };
export const PROBE_STOPPED = { stdoutFile: "captured/35/pidof-not-running.txt", exit: 1 };
export const AM_START = {
  cold: { stdoutFile: "captured/35/am-start-cold.txt" },
  warm: { stdoutFile: "captured/35/am-start-warm.txt" },
  hot: { stdoutFile: "captured/35/am-start-hot.txt" },
  deliveredToTop: { stdoutFile: "captured/35/am-start-delivered-to-top.txt" },
  missingActivity: { stdoutFile: "captured/35/am-start-missing-activity.txt", exit: 1 },
};

export function shell(command: string): string[] {
  return ["-s", SERIAL, "shell", command];
}

/** Bind fixture ownership to one serial test file, never to shared module state. */
export function lifecycleDevices(track: (fake: FakeAdb) => void) {
  /** One online emulator whose shell answers the given commands; anything else is unmatched. */
  function device(answers: Record<string, Response>): FakeAdb {
    return deviceWithRules(
      Object.entries(answers).map(([command, respond]) => ({ match: shell(command), respond })),
    );
  }

  function deviceWithRules(rules: Rule[]): FakeAdb {
    const fake = createFakeAdb({
      description: "One online emulator answering the app lifecycle commands",
      synthetic: true,
      rules: [
        { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
        ...rules,
        { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
        { match: shell(RESOLVE), respond: { stdout: "dev.probe/.MainActivity\n" } },
        { match: shell(PROCESSES), respond: PROCESS_RUNNING },
        { match: shell(METADATA), respond: activityInfo() },
        { match: shell(KERNEL_UIDS), respond: { stdout: "  PID   UID\n 8235 10213\n" } },
      ],
    });
    track(fake);
    return fake;
  }

  /**
   * A device where the probe's process follows the commands sent to it: `am force-stop` and
   * `pm clear` end it, `am start` (answered with `started`) brings it up in front. Its data
   * directory holds no files.
   */
  function liveDevice(started: Response, initially: "running" | "stopped"): FakeAdb {
    const fake = createFakeAdb({
      description: "The probe's process and foreground follow force-stop, clear and start",
      synthetic: true,
      state: { proc: initially },
      rules: [
        { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
        { match: shell(CURRENT_USER), respond: { stdout: "0\n" } },
        { match: shell(RESOLVE), respond: { stdout: "dev.probe/.MainActivity\n" } },
        { match: shell(METADATA), respond: activityInfo() },
        { match: shell(PROCESSES), when: { proc: "running" }, respond: PROCESS_RUNNING },
        { match: shell(PROCESSES), when: { proc: "stopped" }, respond: {} },
        {
          match: shell(KERNEL_UIDS),
          when: { proc: "running" },
          respond: { stdout: "  PID   UID\n 8235 10213\n" },
        },
        {
          match: shell(KERNEL_UIDS),
          when: { proc: "stopped" },
          respond: { stdout: "  PID   UID\n" },
        },
        { match: shell(PACKAGE), respond: INSTALLED },
        { match: shell(FORCE_STOP), respond: {}, set: { proc: "stopped" } },
        { match: shell(CLEAR), respond: { stdout: "Success\n" }, set: { proc: "stopped" } },
        { match: shell(DATA_FILES), respond: {} },
        { match: shell(START), respond: started, set: { proc: "running" } },
        { match: shell(PIDOF), when: { proc: "running" }, respond: PROBE_RUNNING },
        { match: shell(PIDOF), when: { proc: "stopped" }, respond: PROBE_STOPPED },
        { match: shell(FOREGROUND), when: { proc: "running" }, respond: PROBE_FRONT },
        { match: shell(FOREGROUND), when: { proc: "stopped" }, respond: LAUNCHER_FRONT },
      ],
    });
    track(fake);
    return fake;
  }

  return { device, deviceWithRules, liveDevice };
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
}

/** Run a command as TOON and as `--json`; the two must carry the same data field for field. */
export async function both(args: string[], f: FakeAdb): Promise<Both> {
  const toon = await runCli(args, f.env);
  const json = await runCli([...args, "--json"], f.env);
  // A mismatch reports both runs whole, so each format's typed error survives a rare failure.
  const runs = `TOON run: ${describeRun(toon)}\n--json run: ${describeRun(json)}`;
  expect(toon.exitCode, runs).toBe(json.exitCode);
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  // The two runs take different times; every other field must match exactly.
  expect(withoutTime(decoded), runs).toEqual(withoutTime(data));
  return { toon, json, data };
}

export function describeRun(run: CliRun): string {
  return `exit ${run.exitCode} after ${run.durationMs} ms\nstdout:\n${run.stdout}stderr:\n${run.stderr}`;
}

export function withoutTime(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.ok !== "string") return data;
  return { ...data, ok: data.ok.replace(/ after \d+ ms\)$/, " after <n> ms)") };
}

/** Both runs of `both` send the same calls, so a command's calls appear twice. */
export function twice<T>(items: T[]): T[] {
  return [...items, ...items];
}

/** The shell commands sent to the device, in order. */
export function shellCommands(f: FakeAdb): string[] {
  return f
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[2] === "shell")
    .map((argv) => argv[3] ?? "");
}

/** Every call was answered and every device call named its device. */
export function expectClean(f: FakeAdb): void {
  expect(f.unmatched()).toEqual([]);
  for (const call of f.calls()) {
    if (call.argv[0] !== "devices") expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
  }
}
