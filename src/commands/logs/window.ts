import type { AdbClient } from "../../adb/run.js";
import { formatDeviceTime, logcatTime, type DeviceTime } from "../../android/clock.js";
import { parseLogcat, type LogLine } from "../../android/logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "../../android/read.js";
import { parseDuration } from "../../core/args.js";
import { AdbAxiError } from "../../core/errors.js";
import { requireMark, type Mark } from "./marks.js";

/** The start of a log read, resolved against the device clock. */
export interface LogWindow {
  /** Window start on the device clock, in epoch milliseconds. */
  startMs: number;
  /** How the window was named: a mark name, or `<dur> ago`. */
  label: string;
  /** The mark the window starts at, when `--since` named one. */
  mark: Mark | undefined;
}

/**
 * Resolve `--since` against the device clock. A duration counts back from the device's
 * now and a name is a mark; marks cannot be named like durations, so the two never
 * collide.
 */
export function resolveWindow(
  serial: string,
  env: NodeJS.ProcessEnv,
  since: string,
  now: DeviceTime,
): LogWindow {
  const duration = parseDuration(since);
  if (duration !== undefined) {
    return { startMs: now.epochMs - duration, label: `${since} ago`, mark: undefined };
  }
  const mark = requireMark(serial, env, since);
  return { startMs: mark.epochMs, label: since, mark };
}

/** The window that opens at the device's now. */
export function windowFromNow(now: DeviceTime): LogWindow {
  return { startMs: now.epochMs, label: "now", mark: undefined };
}

/** The shell command of one bounded dump: `-d` always, so logcat never streams. */
export function logcatCommand(startMs: number, uid?: number): string {
  const base = `logcat -d -v epoch -T ${logcatTime(startMs)}`;
  return uid === undefined ? base : `${base} --uid ${uid}`;
}

/** Every log line of the window that the device printed, in order. */
export async function readWindowLines(
  adb: AdbClient,
  serial: string,
  window: LogWindow,
  options: ReadOptions,
  uid?: number,
  includeLeadIn = false,
): Promise<LogLine[]> {
  const step = "reading the log";
  const command = includeLeadIn ? "logcat -d -v epoch" : logcatCommand(window.startMs, uid);
  const result = await readShell(adb, serial, command, step, options);
  const parsed = parseLogcat(result.stdout);
  // Text that is no log line at all is never passed off as an empty log.
  if (parsed.lines.length === 0 && parsed.unparsed > 0) throw invalidOutput(step, result.stdout);
  return includeLeadIn ? parsed.lines : parsed.lines.filter((line) => line.epochMs >= window.startMs);
}

/** A regex from the command line; one that does not compile is a usage error. */
export function compileRegex(flag: string, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new AdbAxiError("VALIDATION_ERROR", `${flag} "${source}" is not a valid regex`, {
      fields: { detail: error instanceof Error ? error.message : String(error) },
      help: ["Pass a JavaScript regular expression, for example `Room|Migration`"],
    });
  }
}

/** A line's device-local time of day, `10:12:41.337`. */
export function clockTime(epochMs: number, utcOffsetMinutes: number | null): string {
  return formatDeviceTime(epochMs, utcOffsetMinutes).slice("2026-09-30 ".length);
}
