import type { AdbClient } from "../../adb/run.js";
import { readForeground } from "../../android/foreground.js";
import { pidof } from "../../android/pidof.js";
import type { ReadOptions } from "../../android/read.js";
import { UNKNOWN } from "./shared.js";

/** Where an app stands: in front, running in the background, or not running. */
export type AppState = "foreground" | "running" | "stopped";

/** One observation of an app, as `wait app` reports it in `last`. */
export interface AppObservation {
  state: AppState;
  pid: number | "-";
  /** The package in front, `-` when none. Only read when the caller asks for the foreground. */
  foreground?: string;
}

/**
 * Observe one app. The pid comes from `pidof` on its main process; the foreground package
 * from the resumed activity, read only when `withForeground` is set (it is the costlier read).
 * Without it a running app is reported as `running`, never as `foreground`.
 */
export async function observeApp(
  adb: AdbClient,
  serial: string,
  pkg: string,
  withForeground: boolean,
  options: ReadOptions,
): Promise<AppObservation> {
  const pids = await pidof(adb, serial, pkg, options);
  const pid = pids[0] ?? UNKNOWN;
  if (!withForeground) {
    return { state: pids.length > 0 ? "running" : "stopped", pid };
  }
  const resumed = (await readForeground(adb, serial, options))?.package ?? UNKNOWN;
  const state = resumed === pkg ? "foreground" : pids.length > 0 ? "running" : "stopped";
  return { state, pid, foreground: resumed };
}
