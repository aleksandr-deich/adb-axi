import type { AdbClient } from "../adb/run.js";
import { assertPackageName } from "./component.js";
import { readShell, type ReadOptions } from "./read.js";

/**
 * How important the system rates a process, from its oom adj (AOSP `ProcessList`
 * `*_ADJ` constants). After HOME an app goes `foreground`, briefly `perceptible`, then
 * `previous`, and on some releases `cached` about a minute later (E0, `EVIDENCE.md`).
 */
export type Importance =
  | "persistent"
  | "foreground"
  | "visible"
  | "perceptible"
  | "backup"
  | "heavy"
  | "service"
  | "home"
  | "previous"
  | "service-b"
  | "cached";

/** Lowest oom adj of each band, highest band first (AOSP `ProcessList`, API 29 to 37). */
const BANDS: readonly [number, Importance][] = [
  [900, "cached"],
  [800, "service-b"],
  [700, "previous"],
  [600, "home"],
  [500, "service"],
  [400, "heavy"],
  [300, "backup"],
  [200, "perceptible"],
  [100, "visible"],
  [0, "foreground"],
];

export function importanceForAdj(adj: number): Importance {
  return BANDS.find(([min]) => adj >= min)?.[1] ?? "persistent";
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

/** One line of `dumpsys activity lru`. */
export interface LruEntry {
  pid: number;
  process: string;
  /** The uid as printed: `u0a264`, `1000`. */
  user: string;
  /** The oom adj label as printed, without padding: `fg`, `prev`, `cch+5`. */
  adjLabel: string;
  /** The oom adj the label stands for, or `null` for an unknown label. */
  adj: number | null;
  importance: Importance | null;
  /** The process state label: `TOP`, `LAST`, `CEM`, ... */
  procState: string;
  /** The process hosts activities or recent tasks (`act:` from API 30, `activity=` on 29). */
  activities: boolean;
}

/** Base oom adj of each label `ProcessList.makeOomAdjString` prints (API 29 to 37). */
const ADJ_LABELS: Readonly<Record<string, number>> = {
  cch: 900,
  svcb: 800,
  prev: 700,
  home: 600,
  svc: 500,
  hvy: 400,
  bkup: 300,
  prcl: 250,
  prcm: 225,
  prcp: 200,
  vis: 100,
  fore: 0,
  fg: 0,
  psvc: -700,
  pers: -800,
  sys: -900,
  ntv: -1000,
};

/**
 * `#<index>: <adj label>[+ <n>] <proc state> [<capabilities>] <pid>:<process>/<uid>
 * [act:<kinds>]` (AOSP `ActivityManagerService.dumpLruEntryLocked`). API 29 has no
 * capability column and prints ` activity=<kinds>`; the label pads differently per release.
 */
const LRU_LINE =
  /^\s*#\s*\d+:\s+([a-z]+|-?\d+)\s*(?:\+\s*(\d+))?\s+([A-Z]+)\s+(?:[A-Z-]+\s+)?(\d+):([^/\s]+)\/(\S+)(.*)$/;

export function parseLru(stdout: string): LruEntry[] {
  const entries: LruEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LRU_LINE.exec(line);
    if (
      match?.[1] === undefined ||
      match[3] === undefined ||
      match[4] === undefined ||
      match[5] === undefined ||
      match[6] === undefined
    ) {
      continue;
    }
    const label = match[1];
    const offset = match[2] === undefined ? 0 : Number(match[2]);
    const base = /^-?\d+$/.test(label) ? Number(label) : ADJ_LABELS[label];
    const adj = base === undefined ? null : base + offset;
    entries.push({
      pid: Number(match[4]),
      process: match[5],
      user: match[6],
      adjLabel: offset === 0 ? label : `${label}+${offset}`,
      adj,
      importance: adj === null ? null : importanceForAdj(adj),
      procState: match[3],
      activities: /\b(?:act:|activity=)\S/.test(match[7] ?? ""),
    });
  }
  return entries;
}

/** The records of every running process of a package. */
export async function readProcesses(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
): Promise<ProcessRecord[]> {
  assertPackageName(pkg);
  const result = await readShell(
    adb,
    serial,
    `dumpsys activity processes ${pkg}`,
    `reading the processes of ${pkg}`,
    options,
  );
  return parseProcesses(result.stdout);
}

/** Every process in LRU order, most recently used first. */
export async function readLru(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<LruEntry[]> {
  const result = await readShell(
    adb,
    serial,
    "dumpsys activity lru",
    "reading the process list",
    options,
  );
  return parseLru(result.stdout);
}
