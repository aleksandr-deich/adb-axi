import type { AdbClient } from "../adb/run.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";
import { splitSections } from "./sections.js";

/** What the device says about its boot: the property and how long it has been up. */
export interface BootReading {
  /** `sys.boot_completed`; the property is unset until the boot finishes. */
  bootCompleted: boolean;
  /** Whole seconds since the kernel started, or `null` when `/proc/uptime` printed nothing usable. */
  uptimeS: number | null;
}

/** One shell call reads both parts, each introduced by an `@name` marker line. */
export const BOOT_COMMAND =
  "echo @boot_completed; getprop sys.boot_completed; echo @uptime; cat /proc/uptime";

/**
 * Parse the output of `BOOT_COMMAND`. An unset property prints an empty line and means the
 * boot is not finished; anything but `1` or empty is a value adb-axi cannot read (`null`).
 */
export function parseBoot(stdout: string): BootReading | null {
  const sections = splitSections(stdout);
  // An empty value leaves its section empty, so only a missing marker is unreadable.
  const flag = sections.get("boot_completed");
  if (flag === undefined) return null;
  const value = flag[0] ?? "";
  if (value !== "" && value !== "0" && value !== "1") return null;

  const seconds = Math.floor(Number(sections.get("uptime")?.[0]?.split(/\s+/)[0]));
  return {
    bootCompleted: value === "1",
    uptimeS: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  };
}

export async function readBoot(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<BootReading> {
  const step = `reading the boot state of ${serial}`;
  const result = await readShell(adb, serial, BOOT_COMMAND, step, options);
  const reading = parseBoot(result.stdout);
  if (reading === null) throw invalidOutput(step, result.stdout);
  return reading;
}
