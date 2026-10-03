import type { AdbClient } from "../adb/run.js";
import { readDeviceClock } from "../android/clock.js";
import { parseCrashes } from "../android/crash.js";
import { readForeground } from "../android/foreground.js";
import type { ReadOptions } from "../android/read.js";
import { AdbAxiError } from "../core/errors.js";
import { runHint, type Output } from "../core/output.js";
import { listDevices, ONLINE } from "../device/list.js";
import { resolveTarget } from "../device/resolve.js";
import { UNKNOWN } from "./app/shared.js";
import { defineCommand } from "./define.js";
import { deviceRow, readRow, type Row } from "./devices.js";
import { DEFAULT_SINCE } from "./logs/dump.js";
import { readMarks } from "./logs/marks.js";
import { clockTime, readWindowLines, resolveWindow } from "./logs/window.js";
import type { CommandContext } from "./types.js";

/** Errors that mean adb itself is unusable; the home view has no answer without adb. */
const FATAL_CODES = new Set(["ADB_NOT_FOUND", "ADB_SERVER_UNREACHABLE"]);

/** Errors of choosing the target; the home view reports them instead of failing. */
const SELECTION_CODES = new Set([
  "DEVICE_AMBIGUOUS",
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
]);

/**
 * The no-argument home view (8.1): live device state, not a manual. The target is
 * resolved the way any command resolves it, but a selection that would fail a command
 * is reported here, and a read that fails leaves only its own field unknown.
 */
export const home = defineCommand({
  path: [],
  summary: "Devices, the resolved target, its foreground app and recent crashes",
  examples: ["adb-axi", "adb-axi --json"],
  device: "none",
  shipped: true,
  run: runHome,
});

async function runHome(context: CommandContext): Promise<Output> {
  const adb = context.adb();
  const attached = await listDevices(adb, context.deadline);
  const options = { deadline: context.deadline, env: context.env };
  const rowsPromise = Promise.all(attached.map((device) => readRow(adb, device, [], options)));
  const selection = resolveTarget({
    adb,
    deadline: context.deadline,
    env: context.env,
    devices: attached,
    requested: undefined,
    commandArgs: ["<command>"],
    isShipped: context.isShipped,
  }).then(
    async (target) => ({ target, state: await readTargetState(adb, target.serial, context) }),
    (error: unknown) => {
      if (!(error instanceof AdbAxiError) || !SELECTION_CODES.has(error.code)) throw error;
      return { error };
    },
  );
  const [rows, selected] = await Promise.all([rowsPromise, selection]);
  const online = rows.filter((row) => row.device.state === ONLINE).length;

  const base: Output = {
    count: `${attached.length} attached, ${online} online`,
    devices: rows.map((row) => deviceRow(row, [])),
  };

  if ("error" in selected) {
    const help = [
      ...(attached.length === 0
        ? ["Start an emulator or connect a device, then run `adb-axi` again"]
        : selected.error.help),
      // A target named by ANDROID_SERIAL already has its own hint in the error's help.
      ...stuckHints(rows, context.env.ANDROID_SERIAL, context),
    ];
    return {
      ...base,
      target: UNKNOWN,
      target_note: selected.error.message,
      ...withHelp(help),
    };
  }

  const { target, state } = selected;
  const help = [
    ...stuckHints(rows, target.serial, context),
    ...(state.crashCount > 0
      ? [runHint(["logs", "crash", "--since", state.since], "to see what crashed")]
      : []),
    runHint(
      ["logs", "--pkg", state.foregroundPackage ?? "<package>", "--since", "1m"],
      "for recent app logs",
    ),
    ...(state.degraded || rows.some((row) => row.degraded)
      ? [runHint(["doctor"], "to see why a read shows `-`")]
      : []),
  ];
  return {
    ...base,
    target: target.serial,
    foreground: state.foreground,
    crashes: state.crashes,
    ...withHelp(help),
  };
}

interface TargetState {
  /** `<package>/<activity>`, or `-` when nothing is resumed or the read failed. */
  foreground: string;
  foregroundPackage: string | undefined;
  /** The crash count and the window it covers, or `-` when the log could not be read. */
  crashes: string;
  crashCount: number;
  /** What `logs crash --since` takes for the same window. */
  since: string;
  degraded: boolean;
}

/**
 * The foreground app, and the crashes since the target's latest mark, else in the last
 * 15 minutes (OQ-10). Reads that fail are left unknown, never an error.
 */
async function readTargetState(
  adb: AdbClient,
  serial: string,
  context: CommandContext,
): Promise<TargetState> {
  const options: ReadOptions = { deadline: context.deadline };
  let degraded = false;
  const settle = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof AdbAxiError && !FATAL_CODES.has(error.code)) {
        degraded = true;
        return undefined;
      }
      throw error;
    }
  };

  const [resumed, counted] = await Promise.all([
    settle(() => readForeground(adb, serial, options)),
    settle(async () => {
      const now = await readDeviceClock(adb, serial, options);
      const mark = latestMark(serial, context.env);
      const window = resolveWindow(serial, context.env, mark ?? DEFAULT_SINCE, now);
      const lines = await readWindowLines(adb, serial, window, options, undefined, true);
      const count = parseCrashes(lines).filter((crash) => crash.epochMs >= window.startMs).length;
      const label =
        mark === undefined
          ? `in the last ${DEFAULT_SINCE} (no log mark yet)`
          : `since ${clockTime(window.startMs, now.utcOffsetMinutes).slice(0, 8)} (latest mark ${mark})`;
      return { count, text: `${count} ${label}`, since: mark ?? DEFAULT_SINCE };
    }),
  ]);

  return {
    foreground: resumed ? resumed.component : UNKNOWN,
    foregroundPackage: resumed?.package,
    crashes: counted?.text ?? UNKNOWN,
    crashCount: counted?.count ?? 0,
    since: counted?.since ?? DEFAULT_SINCE,
    degraded,
  };
}

/** The name of the target's most recent log mark, if it has any. */
function latestMark(serial: string, env: NodeJS.ProcessEnv): string | undefined {
  let latest: { name: string; epochMs: number } | undefined;
  for (const [name, mark] of readMarks(serial, env)) {
    if (latest === undefined || mark.epochMs > latest.epochMs)
      latest = { name, epochMs: mark.epochMs };
  }
  return latest?.name;
}

/** Point every attached device that is not online, other than the target, at `doctor`. */
function stuckHints(
  rows: readonly Row[],
  target: string | undefined,
  context: CommandContext,
): string[] {
  if (!context.isShipped(["doctor"])) return [];
  return rows
    .filter((row) => row.device.state !== ONLINE && row.device.serial !== target)
    .map((row) =>
      runHint(["doctor", "--device", row.device.serial], `to see why it is ${row.device.state}`),
    );
}

function withHelp(help: readonly string[]): { help?: string[] } {
  const unique = [...new Set(help)];
  return unique.length > 0 ? { help: unique } : {};
}
