import type { AdbClient } from "../adb/run.js";
import { parseCrashes } from "./crash.js";
import { parseLogcat } from "./logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

export const LAUNCH_CRASH_COMMAND = "logcat -d -b events,crash -v epoch -s am_crash DEBUG:F";

export interface LaunchCrash {
  key: string;
  pid: number;
  userId: number;
  process: string;
}

export function parseLaunchCrashes(stdout: string): LaunchCrash[] {
  const { lines } = parseLogcat(stdout);
  const java = lines.flatMap((line) => {
    if (line.tag !== "am_crash" || line.level !== "I") return [];
    const fields = /^\[(\d+),(\d+),([^,]+),[^,]+,([^,]+),/.exec(line.message);
    if (fields?.[1] === undefined || fields[2] === undefined || fields[3] === undefined) return [];
    if (fields[4] === "Native crash" || /,\d+,1\]$/.test(line.message)) return [];
    return [
      {
        key: `${line.time}:${line.pid}:${line.tid}:${line.message}`,
        pid: Number(fields[1]),
        userId: Number(fields[2]),
        process: fields[3],
      },
    ];
  });
  const native = parseCrashes(lines).flatMap((crash) => {
    if (crash.kind !== "native" || crash.pid === null) return [];
    const uid = crash.trace.flatMap((message) => /^uid: (\d+)\s*$/.exec(message)?.[1] ?? []);
    if (uid.length !== 1) return [];
    return [
      {
        key: `native:${crash.epochMs}:${crash.pid}:${crash.process}`,
        pid: crash.pid,
        userId: Math.floor(Number(uid[0]) / 100000),
        process: crash.process,
      },
    ];
  });
  return [...java, ...native];
}

export async function readLaunchCrashes(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<LaunchCrash[]> {
  const step = "reading launch crashes";
  const result = await readShell(adb, serial, LAUNCH_CRASH_COMMAND, step, options);
  if (parseLogcat(result.stdout).unparsed !== 0) throw invalidOutput(step, result.stdout);
  return parseLaunchCrashes(result.stdout);
}
