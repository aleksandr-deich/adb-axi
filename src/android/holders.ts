import type { AdbClient } from "../adb/run.js";
import { parseLogcat } from "./logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

/**
 * An instrumentation that may own the single UiAutomation connection. `doctor` reports
 * these; `doctor ui` adds the `app_process` servers and decides who still uses each one.
 */
export interface Holder {
  kind: "instrumentation";
  /** The package of the instrumentation's runner, for example `com.example.notes.test`. */
  package: string;
  /** The runner component, `<package>/<class>`. */
  component: string;
  /** Whether the instrumentation was started with a UiAutomation connection (`am instrument` does). */
  uiAutomation: boolean;
  /** The processes it runs in (`mRunningProcesses`); empty when none are printed. */
  processes: { pid: number; package: string }[];
}

const HEADER =
  /^\s*Instrumentation #\d+: ActiveInstrumentation\{\S+ \{([^/\s}]+)\/([^\s}]+)\}( FINISHED)? \d+ procs\}\s*$/;

/** `#0: ProcessRecord{9d1c2aa 9021:com.example.notes/u0a214}` under `mRunningProcesses:`. */
const RUNNING_PROCESS = /^\s+#\d+: ProcessRecord\{[0-9a-f]+ (\d+):([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)(?::[\w.]+)?\//;

/**
 * The live instrumentations in `dumpsys activity processes`. The section is printed by
 * `ActivityManagerService.dumpActiveInstruments` (AOSP, API 29 to 37): a header line per
 * instrumentation, then its fields; `mUiAutomationConnection=` is printed only when the
 * instrumentation was given a UiAutomation connection, and `mRunningProcesses:` lists one
 * `ProcessRecord` per process it runs in. Finished ones are not holders.
 */
export function parseInstrumentations(dump: string): Holder[] {
  const holders: Holder[] = [];
  let current: { holder: Holder; finished: boolean } | undefined;
  let inSection = false;
  let inProcesses = false;
  const close = (): void => {
    if (current && !current.finished) holders.push(current.holder);
    current = undefined;
  };
  for (const line of dump.split(/\r?\n/)) {
    if (/^ {2}Active instrumentation:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const header = HEADER.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined) {
      close();
      inProcesses = false;
      current = {
        holder: {
          kind: "instrumentation",
          package: header[1],
          component: `${header[1]}/${header[2]}`,
          uiAutomation: false,
          processes: [],
        },
        finished: header[3] !== undefined,
      };
      continue;
    }
    if (current && /^\s+mUiAutomationConnection=/.test(line)) {
      current.holder.uiAutomation = true;
    }
    if (current && /^\s+mRunningProcesses:\s*$/.test(line)) {
      inProcesses = true;
      continue;
    }
    const running = inProcesses ? RUNNING_PROCESS.exec(line) : null;
    if (current && running?.[1] !== undefined && running[2] !== undefined) {
      current.holder.processes.push({ pid: Number(running[1]), package: running[2] });
      continue;
    }
    inProcesses = false;
    // The section ends at the next two-space-indented heading (`OOM levels:` and so on).
    if (/^ {2}\S/.test(line)) {
      close();
      inSection = false;
    }
  }
  close();
  return holders;
}

/** Every instrumentation running on the device, with or without UiAutomation. */
export async function probeHolders(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<Holder[]> {
  const result = await readShell(
    adb,
    serial,
    "dumpsys activity processes",
    "looking for running instrumentations",
    options,
  );
  if (!/^ACTIVITY MANAGER RUNNING PROCESSES\b/m.test(result.stdout)) {
    throw invalidOutput("looking for running instrumentations", result.stdout);
  }
  return parseInstrumentations(result.stdout);
}

/** A process started through `app_process` that runs a Java class, such as mobilecli's server. */
export interface AppProcessServer {
  kind: "server";
  pid: number;
  /** The class `app_process` runs, for example `com.mobilenext.mobilecli.DeviceServer`. */
  className: string;
}

/** Every process with its command line (toybox `ps -A -o PID,ARGS`, API 29 to 37). */
export const PS_ARGS_COMMAND = "ps -A -o PID,ARGS";

/**
 * The `app_process` processes in `ps -A -o PID,ARGS`: a header, then `<pid> <argv...>`.
 * `app_process [options] <dir> <class> [args]` keeps `app_process` (or `app_process64`)
 * as its name unless `--nice-name` is given (AOSP `app_main.cpp`); the class is the first
 * argument after the options and the directory. A missing header reads as `null`.
 */
export function parseAppProcessServers(stdout: string): AppProcessServer[] | null {
  const rows = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!/^\s*PID\s+\S+\s*$/.test(rows[0] ?? "")) return null;
  const servers: AppProcessServer[] = [];
  for (const row of rows.slice(1)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const words = match[2].trim().split(/\s+/);
    if (!/^(?:\S*\/)?app_process(?:32|64)?$/.test(words[0] ?? "")) continue;
    const rest = words.slice(1).filter((word) => !word.startsWith("-"));
    const className = rest[1];
    if (className === undefined || !/^[\w$]+(?:\.[\w$]+)+$/.test(className)) continue;
    servers.push({ kind: "server", pid: Number(match[1]), className });
  }
  return servers;
}

/** Every `app_process` server running on the device. */
export async function probeAppProcessServers(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<AppProcessServer[]> {
  const step = "reading the process command lines";
  const result = await readShell(adb, serial, PS_ARGS_COMMAND, step, options);
  const servers = parseAppProcessServers(result.stdout);
  if (servers === null) throw invalidOutput(step, result.stdout);
  return servers;
}

/**
 * What `UiAutomation.disconnect()` throws when it is called while the connection is still
 * being made (AOSP `UiAutomation.java`). After it, the holder never serves again.
 */
export const WEDGE_SIGNATURE = "Cannot call disconnect() while connecting";

/** The wedge signature as a `logcat -e` pattern (no shell or regex metacharacters to quote). */
const WEDGE_PATTERN = "Cannot call disconnect.. while connecting";

/** The pids that logged the wedge signature in `logcat -v epoch` output. */
export function parseWedgedPids(stdout: string): Set<number> {
  const pids = new Set<number>();
  for (const line of parseLogcat(stdout).lines) {
    if (line.message.includes(WEDGE_SIGNATURE)) pids.add(line.pid);
  }
  return pids;
}

/**
 * The pids that logged the wedge signature in the device's log buffers. Only a line from
 * the holder's own pid counts, so it was written after that holder started.
 */
export async function readWedgedPids(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<Set<number>> {
  const result = await readShell(
    adb,
    serial,
    `logcat -d -v epoch -e '${WEDGE_PATTERN}'`,
    "searching the log for wedged UiAutomation",
    options,
  );
  return parseWedgedPids(result.stdout);
}

/** One `adb forward --list` line: `<serial> <local> <remote>`. */
export interface Forward {
  serial: string;
  local: string;
  remote: string;
}

export function parseForwards(stdout: string): Forward[] {
  const forwards: Forward[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [serial, local, remote, ...extra] = line.trim().split(/\s+/);
    if (serial === undefined || local === undefined || remote === undefined) continue;
    if (extra.length > 0) continue;
    forwards.push({ serial, local, remote });
  }
  return forwards;
}
