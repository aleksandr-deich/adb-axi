import type { AdbClient } from "../adb/run.js";
import { parsePidof } from "./app-processes.js";
import { assertPackageName } from "./component.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

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
