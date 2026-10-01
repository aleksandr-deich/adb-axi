import type { AdbClient } from "../adb/run.js";
import { assertPackageName } from "./component.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/**
 * `pidof <name>` prints every matching pid on one line, space-separated, and exits 1 with
 * no output when nothing matches (toybox `pidof.c`, the same from API 29 to 37). The name
 * is matched exactly, so `dev.probe` is the app's main process, not `dev.probe:remote`.
 */
export function parsePidof(stdout: string): number[] | null {
  const text = stdout.trim();
  if (text === "") return [];
  const pids = text.split(/\s+/).map(Number);
  return pids.every((pid) => Number.isInteger(pid) && pid > 0) ? pids : null;
}

/** The pids of a package's main process; empty when it is not running. */
export async function pidof(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
): Promise<number[]> {
  assertPackageName(pkg);
  const step = `reading the pid of ${pkg}`;
  const result = await readShell(adb, serial, `pidof ${pkg}`, step, options, [0, 1]);
  const pids = parsePidof(result.stdout);
  // Exit 1 with output, or exit 0 without, is not something pidof does.
  if (pids === null || (result.exitCode === 1) !== (pids.length === 0)) {
    throw invalidOutput(step, result.stdout);
  }
  return pids;
}
