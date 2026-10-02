import type { AdbClient } from "../adb/run.js";
import { assertPackageName } from "./component.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/** One running process: its pid and process name (the package, or `<pkg>:<name>`). */
export interface ProcessName {
  pid: number;
  name: string;
}

/** Every process with its pid and name, one `ps` call (toybox `ps -A -o PID,NAME`, API 29 to 37). */
export const PS_COMMAND = "ps -A -o PID,NAME";

/**
 * Parse `ps -A -o PID,NAME`: a `PID NAME` header, then one `<pid> <name>` row per process.
 * Anything that is not a row is skipped; the header is required, so output that is not
 * `ps`'s reads as `null`, never as an empty process list.
 */
export function parsePs(stdout: string): ProcessName[] | null {
  const rows = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!/^\s*PID\s+NAME\s*$/.test(rows[0] ?? "")) return null;
  const processes: ProcessName[] = [];
  for (const row of rows.slice(1)) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(row);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    processes.push({ pid: Number(match[1]), name: match[2] });
  }
  return processes;
}

/** Whether a process belongs to a package: the main process or a `<pkg>:<name>` one. */
export function belongsTo(process: ProcessName, pkg: string): boolean {
  return process.name === pkg || process.name.startsWith(`${pkg}:`);
}

/** Every running process on the device. */
export async function readProcessNames(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<ProcessName[]> {
  const step = "reading the process list";
  const result = await readShell(adb, serial, PS_COMMAND, step, options);
  const processes = parsePs(result.stdout);
  if (processes === null) throw invalidOutput(step, result.stdout);
  return processes;
}

/** The pids of every process of a package, main and `<pkg>:<name>`; empty when not running. */
export async function appPids(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
): Promise<number[]> {
  assertPackageName(pkg);
  const processes = await readProcessNames(adb, serial, options);
  return processes.filter((process) => belongsTo(process, pkg)).map((process) => process.pid);
}
