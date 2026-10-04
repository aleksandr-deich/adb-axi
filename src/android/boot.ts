import type { AdbClient } from "../adb/run.js";
import { splitSections } from "../device/columns.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/**
 * What the device says about its boot: the property, how long it has been up, and whether
 * the services an install or a launch needs answer. `null` is a part the device did not say.
 */
export interface BootReading {
  /** `sys.boot_completed`; the property is unset until the boot finishes. */
  bootCompleted: boolean;
  /** Whole seconds since the kernel started, or `null` when `/proc/uptime` printed nothing usable. */
  uptimeS: number | null;
  /** The pid of `system_server`, which hosts both services; a new pid means it restarted. */
  systemServerPid: number | null;
  /** The package service answered a call (`cmd package path android` exited 0). */
  packageService: boolean | null;
  /** The activity service answered a call (`cmd activity get-current-user` exited 0). */
  activityService: boolean | null;
}

/**
 * One shell call reads every part, each introduced by an `@name` marker line. The services
 * are asked a real question rather than looked up, because a service that is registered
 * but whose process is going away fails the call ("Broken pipe") while it still looks found.
 */
export const BOOT_COMMAND = [
  "echo @boot_completed",
  "getprop sys.boot_completed",
  "echo @uptime",
  "cat /proc/uptime",
  "echo @system_server",
  "pidof system_server",
  "echo @package",
  "cmd package path android >/dev/null 2>&1",
  "echo $?",
  "echo @activity",
  "cmd activity get-current-user >/dev/null 2>&1",
  "echo $?",
  "echo @system_server_after",
  "pidof system_server",
].join("; ");

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
  // `pidof` prints nothing while the process is not running.
  const pid = Number(sections.get("system_server")?.[0]);
  const pidAfter = Number(sections.get("system_server_after")?.[0]);
  return {
    bootCompleted: value === "1",
    uptimeS: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    systemServerPid: Number.isInteger(pid) && pid > 0 && pid === pidAfter ? pid : null,
    packageService: answered(sections.get("package")),
    activityService: answered(sections.get("activity")),
  };
}

/** A service call's exit code: 0 answered, any other code did not, nothing is unknown. */
function answered(lines: readonly string[] | undefined): boolean | null {
  const exit = lines?.[0];
  if (exit === undefined || !/^\d+$/.test(exit)) return null;
  return exit === "0";
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
