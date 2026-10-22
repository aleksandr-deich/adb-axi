import type { AdbClient } from "../../adb/run.js";
import { mainProcess, runningProcesses, type AppIdentity } from "../../android/app-processes.js";
import { readForeground } from "../../android/foreground.js";
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
 * Observe one app for one Android user. It is running while any of its processes runs;
 * the pid is its main process's, `-` when only another process runs. The foreground package
 * comes from the resumed activity, read only when `withForeground` is set (it is the costlier
 * read). Without it a running app is reported as `running`, never as `foreground`.
 */
export async function observeApp(
  adb: AdbClient,
  serial: string,
  app: AppIdentity,
  userId: number,
  withForeground: boolean,
  options: ReadOptions,
): Promise<AppObservation> {
  const processes = await runningProcesses(adb, serial, app, options);
  const pid = mainProcess(app, processes)?.pid ?? UNKNOWN;
  const running = processes.length > 0;
  if (!withForeground) {
    return { state: running ? "running" : "stopped", pid };
  }
  const resumed = (await readForeground(adb, serial, { ...options, userId }))?.package ?? UNKNOWN;
  const state = resumed === app.pkg ? "foreground" : running ? "running" : "stopped";
  return { state, pid, foreground: resumed };
}
