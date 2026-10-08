import type { AdbClient } from "../adb/run.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/** Resolve once per command so its subsequent app operations keep the same user. */
export async function readCurrentUser(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<number> {
  const step = "reading the current Android user";
  const result = await readShell(adb, serial, "am get-current-user", step, options);
  const user = result.stdout.trim();
  if (!/^\d+$/.test(user) || !Number.isSafeInteger(Number(user))) {
    throw invalidOutput(step, result.stdout);
  }
  return Number(user);
}
