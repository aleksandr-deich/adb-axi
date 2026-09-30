import type { AdbCallOptions, AdbClient } from "./run.js";

/**
 * Copy the raw bytes a device command writes, through `adb exec-out`. Its exit code proves
 * nothing (S1): `exec:` has no stderr channel, so a failing remote command's error text
 * arrives as the bytes and adb still exits 0. Callers must validate the bytes (for
 * example the SQLite header) and report `INVALID_OUTPUT` when they are not what was asked for.
 */
export async function execOut(
  adb: AdbClient,
  serial: string,
  command: readonly string[],
  options: AdbCallOptions,
): Promise<Buffer> {
  const result = await adb.device(serial, ["exec-out", ...command], options);
  return result.stdout;
}
