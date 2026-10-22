import type { AdbClient } from "../../adb/run.js";
import { identityOf, runningProcesses } from "../../android/app-processes.js";
import type { LogLine } from "../../android/logcat.js";
import { readPackageSnapshot } from "../../android/packages.js";
import { invalidOutput, type ReadOptions } from "../../android/read.js";
import { readCurrentUser } from "../../android/users.js";
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
  | { kind: "pids"; pkg: string; uid: number; current: number[]; marked: number[] };

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
  const userId = await readCurrentUser(adb, serial, options);
  const { info: record, dump } = await readPackageSnapshot(adb, serial, pkg, options, userId);
  if (record === null || !record.installed) {
    throw new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed on ${serial}`, {
      help: [runHint(["app", "list"], "to see the installed packages")],
    });
  }
  const facts =
    known !== undefined && known.api !== null ? known : await readShellFacts(adb, device, options);
  if (facts.api === null) throw invalidOutput("reading the Android version", "");
  const app = identityOf(record, dump);
  if (facts.api >= PID_LIST_BELOW_API) return { kind: "uid", pkg, uid: app.uid };
  const marked = (window.mark?.processes ?? [])
    .filter((process) => process.uid === app.uid)
    .map((process) => process.pid);
  const current = (await runningProcesses(adb, serial, app, options)).map(({ pid }) => pid);
  return { kind: "pids", pkg, uid: app.uid, current, marked };
}

/**
 * The pids a pid-list scope covers: the app's current pids, the pids recorded at the mark,
 * and the pids ActivityManager named in "Start proc" lines of the window.
 */
export function scopePids(scope: Scope & { kind: "pids" }, lines: readonly LogLine[]): number[] {
  const pids = new Set([...scope.current, ...scope.marked, ...startedPids(lines, scope.uid)]);
  return [...pids].sort((a, b) => a - b);
}

/**
 * `Start proc <pid>:<process>/<uid> for <reason>` is what ActivityManager logs when it
 * starts a process (AOSP `ProcessList.startProcessLocked`, API 29 and 30).
 * `UserHandle.formatUid` uses `u<user>a<app id - 10000>` for app ids and
 * `u<user>s<app id>` for secondary-user system ids: `u10a116` is uid 1010116 and
 * `u10s1000` is uid 1001000. Primary-user system uids print as decimal numbers.
 * Isolated `u<user>i<id>` entries cannot belong to the app's exact uid and are ignored.
 */
const START_PROC = /^Start proc (\d+):[^/\s]+\/(?:u(\d+)([as])(\d+)|(\d+)) for /;

export function startedPids(lines: readonly LogLine[], uid: number): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    if (line.tag !== "ActivityManager") continue;
    const match = START_PROC.exec(line.message);
    if (match?.[1] === undefined) continue;
    const started =
      match[2] !== undefined
        ? Number(match[2]) * 100000 + (match[3] === "a" ? 10000 : 0) + Number(match[4])
        : Number(match[5]);
    if (started === uid) pids.push(Number(match[1]));
  }
  return pids;
}

/** The scope as the output states it: `com.example.notes (uid 10213)`, or its pid list. */
export function describeScope(scope: Scope, lines: readonly LogLine[]): string {
  if (scope.kind === "uid") return `${scope.pkg} (uid ${scope.uid})`;
  const pids = scopePids(scope, lines);
  return `${scope.pkg} (pids ${pids.length === 0 ? "-" : pids.join(", ")})`;
}
