import type { AdbClient } from "../adb/run.js";
import { assertPackageName } from "./component.js";
import type { PackageInfo } from "./packages.js";
import { importanceForAdj, type Importance } from "./processes.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/**
 * Processes are matched by this exact uid. A uid also covers other packages that share it,
 * and isolated services run under their own uid, so neither is attributed to the app
 * correctly.
 */
export interface AppIdentity {
  pkg: string;
  uid: number;
}

/** The identity of a package record read for one Android user; `dump` is what it came from. */
export function identityOf(info: PackageInfo, dump: string): AppIdentity {
  if (info.uid === null) throw invalidOutput(`reading package ${info.package}`, dump);
  return { pkg: info.package, uid: info.uid };
}

export interface RunningProcess {
  pid: number;
  /** Process name: the package for the main process, `<pkg>:<name>` for others. */
  name: string;
}

export interface ProcessRow extends RunningProcess {
  uid: number;
}

/** Every process with its pid, uid and name (toybox `ps -A -o PID,UID,NAME`, API 29 to 37). */
const PS_COMMAND = "ps -A -o PID,UID,NAME";
const PS_STEP = "reading package process names";
const PROCESS_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

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

/**
 * The app's rows of `ps -A -o PID,UID,NAME`, pids by process name in row order. The main
 * name is always there, even without a row, so `pidof` still checks it. Rows of other uids,
 * including unreadable ones, cannot name this app and are skipped.
 */
export function psCandidates(stdout: string, app: AppIdentity): Map<string, Set<number>> {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.shift()?.trim().replace(/\s+/g, " ") !== "PID UID NAME") {
    throw invalidOutput(PS_STEP, stdout);
  }
  const names = new Map<string, Set<number>>();
  for (const line of lines) {
    // NAME is the rest of the row: kernel threads can carry spaces.
    const row = /^\s*(\S+)\s+(\S+)(?:\s+(.+?))?\s*$/.exec(line);
    const rowUid = row?.[2];
    if (rowUid === undefined || !/^\d+$/.test(rowUid) || Number(rowUid) !== app.uid) continue;
    const pid = Number(row?.[1]);
    const name = row?.[3] === undefined ? undefined : unbracket(row[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || !PROCESS_NAME.test(name)) {
      throw invalidOutput(PS_STEP, line);
    }
    const known = names.get(name) ?? new Set<number>();
    known.add(pid);
    names.set(name, known);
  }
  if (!names.has(app.pkg)) names.set(app.pkg, new Set());
  return names;
}

/** The candidates `pidof` confirmed: a pid counts only when both reads list it. */
export function confirmRunning(
  candidates: ReadonlyMap<string, ReadonlySet<number>>,
  running: ReadonlyMap<string, readonly number[]>,
): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const [name, known] of candidates) {
    for (const pid of running.get(name) ?? []) {
      if (known.has(pid)) processes.push({ pid, name });
    }
  }
  return processes;
}

/**
 * Every process running under the app's uid. `ps` can still list an exiting process, its
 * name shown as `[name]` (seen on API 29, 30 and 35), so only `pidof` decides that a
 * process is alive.
 */
export async function runningProcesses(
  adb: AdbClient,
  serial: string,
  app: AppIdentity,
  options: ReadOptions,
): Promise<RunningProcess[]> {
  assertPackageName(app.pkg);
  const table = await readShell(adb, serial, PS_COMMAND, PS_STEP, options);
  const candidates = psCandidates(table.stdout, app);
  const running = new Map<string, number[]>();
  for (const name of candidates.keys()) {
    running.set(name, await readPidof(adb, serial, name, options));
  }
  return confirmRunning(candidates, running);
}

async function readPidof(
  adb: AdbClient,
  serial: string,
  name: string,
  options: ReadOptions,
): Promise<number[]> {
  const step = `reading the pid of ${name}`;
  const result = await readShell(adb, serial, `pidof ${name}`, step, options, [0, 1]);
  const pids = parsePidof(result.stdout);
  // Exit 1 with output, or exit 0 without, is not something pidof does.
  if (pids === null || (result.exitCode === 1) !== (pids.length === 0)) {
    throw invalidOutput(step, result.stdout);
  }
  return pids;
}

function unbracket(name: string): string {
  return name.replace(/^\[([A-Za-z_][A-Za-z0-9_.:-]*)\]$/, "$1");
}

/** The app's main process: the one named exactly like the package. */
export function mainProcess<T extends { name: string } | { process: string }>(
  app: AppIdentity,
  processes: readonly T[],
): T | undefined {
  return processes.find((entry) => ("name" in entry ? entry.name : entry.process) === app.pkg);
}

/**
 * `am kill` only kills processes at or above `SERVICE_ADJ` (500): it calls
 * `killBackgroundProcesses`, which passes that as the minimum oom adj (AOSP
 * `ActivityManagerService`, API 29 to 37). Below it, `am kill` is the silent no-op of S5.
 * The previous app (700) qualifies, so an app need not reach `cached` first.
 */
export const AM_KILL_MIN_ADJ = 500;

export function amKillCanKill(adj: number): boolean {
  return adj >= AM_KILL_MIN_ADJ;
}

/** One process record from `dumpsys activity processes <pkg>`. */
export interface ProcessRecord {
  pid: number;
  /** Process name: the package for the main process, `<pkg>:<name>` for others. */
  process: string;
  uid: number;
  /** The oom adj the system last applied (`set=`), the value `am kill` compares. */
  adj: number | null;
  importance: Importance | null;
  /** `curProcState=`, an `ActivityManager.PROCESS_STATE_*` number. */
  procState: number | null;
  /** The `cached=` flag. */
  cached: boolean | null;
}

/**
 * Parse the `*APP*` and `*PERS*` records under "All known processes" (AOSP
 * `ActivityManagerService.dumpProcessesLocked` and `ProcessRecord.dump`). The oom line is
 * `oom: max=...` up to API 30 and `oom adj: max=...` from API 31. Records without a pid
 * are not running and are left out.
 */
export function parseProcesses(stdout: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  let current: ProcessRecord | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const header =
      /^ {2}\*(?:APP|PERS)\* UID (\d+) ProcessRecord\{[0-9a-f]+ (\d+):([^/\s]+)\/\S+\}/.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined && header[3] !== undefined) {
      current = {
        pid: Number(header[2]),
        process: header[3],
        uid: Number(header[1]),
        adj: null,
        importance: null,
        procState: null,
        cached: null,
      };
      if (current.pid > 0) records.push(current);
      continue;
    }
    // A record's details are indented by four (API 35 puts a blank line among them);
    // any shallower line ends the record.
    if (line.trim() === "") continue;
    if (current === undefined || !/^ {4}/.test(line)) {
      current = undefined;
      continue;
    }
    const oom = /^\s*oom(?: adj)?: max=-?\d+ curRaw=-?\d+ setRaw=-?\d+ cur=-?\d+ set=(-?\d+)/.exec(
      line,
    );
    if (oom?.[1] !== undefined) {
      current.adj = Number(oom[1]);
      current.importance = importanceForAdj(current.adj);
    }
    const state = /^\s*curProcState=(-?\d+)/.exec(line);
    if (state?.[1] !== undefined) current.procState = Number(state[1]);
    const cached = /^\s*cached=(true|false)\b/.exec(line);
    if (cached?.[1] !== undefined) current.cached = cached[1] === "true";
  }
  return records;
}

/**
 * ActivityManager's records of the app's processes. A record can be dropped before its
 * process dies, so this is importance, never exit evidence.
 */
export async function processImportance(
  adb: AdbClient,
  serial: string,
  app: AppIdentity,
  options: ReadOptions,
): Promise<ProcessRecord[]> {
  assertPackageName(app.pkg);
  const result = await readShell(
    adb,
    serial,
    `dumpsys activity processes ${app.pkg}`,
    `reading the processes of ${app.pkg}`,
    options,
  );
  return parseProcesses(result.stdout).filter((record) => record.uid === app.uid);
}
