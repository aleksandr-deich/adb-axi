import type { AdbClient } from "../../adb/run.js";
import type { LogLine } from "../../android/logcat.js";
import { readPackage } from "../../android/packages.js";
import { appPids, belongsTo } from "../../android/ps.js";
import { invalidOutput, type ReadOptions } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint } from "../../core/output.js";
import { readShellFacts, type DeviceFacts } from "../../device/facts.js";
import type { AttachedDevice } from "../../device/list.js";
import type { LogWindow } from "./window.js";

/**
 * `logcat --uid` exists from API 31 (AOSP `logcat.cpp`, android-12.0.0_r1) and is absent
 * on 29 and 30, where `--pkg` is a pid list instead. `--uid` is never sent below this.
 */
export const PID_LIST_BELOW_API = 31;

/** How `--pkg` limits a window to one app's processes. */
export type Scope =
  | { kind: "uid"; pkg: string; uid: number }
  | { kind: "pids"; pkg: string; current: number[]; marked: number[] };

export async function resolveScope(
  adb: AdbClient,
  device: AttachedDevice,
  pkg: string,
  window: LogWindow,
  options: ReadOptions & { env: NodeJS.ProcessEnv },
  /**
   * The device's facts when the command already read them; read here otherwise, and
   * read again when the earlier read had no Android version.
   */
  known: DeviceFacts | undefined,
): Promise<Scope> {
  const serial = device.serial;
  const record = await readPackage(adb, serial, pkg, options);
  if (record === null || !record.installed) {
    throw new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed on ${serial}`, {
      help: [runHint(["app", "list"], "to see the installed packages")],
    });
  }
  const facts =
    known !== undefined && known.api !== null ? known : await readShellFacts(adb, device, options);
  if (facts.api === null) throw invalidOutput("reading the Android version", "");
  if (facts.api >= PID_LIST_BELOW_API) {
    if (record.uid === null) throw invalidOutput(`reading the uid of ${pkg}`, "");
    return { kind: "uid", pkg, uid: record.uid };
  }
  const marked = (window.mark?.processes ?? [])
    .filter((process) => belongsTo(process, pkg))
    .map((process) => process.pid);
  return { kind: "pids", pkg, current: await appPids(adb, serial, pkg, options), marked };
}

/**
 * The pids a pid-list scope covers: the app's current pids, the pids recorded at the mark,
 * and the pids ActivityManager named in "Start proc" lines of the window.
 */
export function scopePids(scope: Scope & { kind: "pids" }, lines: readonly LogLine[]): number[] {
  const pids = new Set([...scope.current, ...scope.marked, ...startedPids(lines, scope.pkg)]);
  return [...pids].sort((a, b) => a - b);
}

/**
 * `Start proc <pid>:<process>/<uid> for <reason>` is what ActivityManager logs when it
 * starts a process (AOSP `ProcessList.startProcessLocked`, API 29 and 30). The process
 * name is the package for the main process and `<pkg>:<name>` for the others.
 */
const START_PROC = /^Start proc (\d+):([^/\s]+)\/\S+ for /;

export function startedPids(lines: readonly LogLine[], pkg: string): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    if (line.tag !== "ActivityManager") continue;
    const match = START_PROC.exec(line.message);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (belongsTo({ pid: Number(match[1]), name: match[2] }, pkg)) pids.push(Number(match[1]));
  }
  return pids;
}

/** The scope as the output states it: `com.example.notes (uid 10213)`, or its pid list. */
export function describeScope(scope: Scope, lines: readonly LogLine[]): string {
  if (scope.kind === "uid") return `${scope.pkg} (uid ${scope.uid})`;
  const pids = scopePids(scope, lines);
  return `${scope.pkg} (pids ${pids.length === 0 ? "-" : pids.join(", ")})`;
}
