import type { AdbClient } from "../adb/run.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/** The device's wall clock at one moment. Log windows use it, never the host clock. */
export interface DeviceTime {
  epochMs: number;
  /** Seconds with milliseconds (`1790834220.608`), the form `logcat -T` accepts. */
  logcatTime: string;
  /** The device's UTC offset in minutes, or `null` when it printed none. */
  utcOffsetMinutes: number | null;
}

/**
 * Epoch seconds with nanoseconds, then the UTC offset. toybox `date` supports `%N` on
 * every release adb-axi supports (`toys/posix/date.c` at android-10.0.0_r1 and later).
 */
export const CLOCK_COMMAND = "date '+%s.%N %z'";

/** Parse `date +%s.%N`, optionally followed by a `%z` offset such as `+0200`. */
export function parseDeviceClock(stdout: string): DeviceTime | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(stdout.trim());
  if (match?.[1] === undefined) return null;
  const millis = Number((match[2] ?? "").padEnd(3, "0").slice(0, 3));
  const epochMs = Number(match[1]) * 1000 + millis;
  let utcOffsetMinutes: number | null = null;
  if (match[3] !== undefined) {
    const minutes = Number(match[4]) * 60 + Number(match[5]);
    utcOffsetMinutes = match[3] === "-" ? -minutes : minutes;
  }
  return { epochMs, logcatTime: logcatTime(epochMs), utcOffsetMinutes };
}

/** Epoch milliseconds as `logcat -T` takes them: `<seconds>.<milliseconds>`. */
export function logcatTime(epochMs: number): string {
  const seconds = Math.floor(epochMs / 1000);
  return `${seconds}.${String(epochMs - seconds * 1000).padStart(3, "0")}`;
}

/**
 * A device time as the device shows it: `2026-10-01 07:57:00.608` at the device's UTC
 * offset (UTC when the offset is unknown).
 */
export function formatDeviceTime(epochMs: number, utcOffsetMinutes: number | null): string {
  const shifted = new Date(epochMs + (utcOffsetMinutes ?? 0) * 60_000);
  return shifted.toISOString().replace("T", " ").replace("Z", "");
}

export async function readDeviceClock(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<DeviceTime> {
  const step = "reading the device clock";
  const result = await readShell(adb, serial, CLOCK_COMMAND, step, options);
  const time = parseDeviceClock(result.stdout);
  if (time === null) throw invalidOutput(step, result.stdout);
  return time;
}
