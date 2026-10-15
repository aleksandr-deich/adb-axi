import type { AdbClient } from "../adb/run.js";
import { parseCrashes } from "./crash.js";
import { parseLogcat, type LogLine } from "./logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "./read.js";

export const LAUNCH_CRASH_COMMAND =
  "logcat -d -b events,crash -v epoch -s am_crash am_proc_start am_proc_died DEBUG:F";

export interface LaunchCrash {
  key: string;
  pid: number;
  userId: number;
  uid: number | null;
  process: string;
}

function crashKey(line: LogLine): string {
  return `${line.time}:${line.pid}:${line.tid}:${line.message}`;
}

export function parseLaunchCrashes(stdout: string): LaunchCrash[] {
  const { lines } = parseLogcat(stdout);
  const native = parseCrashes(lines).flatMap((crash) => {
    if (crash.kind !== "native" || crash.pid === null) return [];
    const uids = crash.trace.flatMap((message) => /^uid: (\d+)\s*$/.exec(message)?.[1] ?? []);
    if (uids.length !== 1) return [];
    const uid = Number(uids[0]);
    const died = lines.some((line) => {
      if (line.tag !== "am_proc_died" || line.level !== "I" || line.epochMs < crash.epochMs)
        return false;
      const fields = /^\[(\d+),(\d+),([^,\]]+)(?:,|\])/.exec(line.message);
      return (
        Number(fields?.[1]) === Math.floor(uid / 100000) &&
        Number(fields?.[2]) === crash.pid &&
        fields?.[3] === crash.process &&
        !lines.some((start) => {
          if (
            start.tag !== "am_proc_start" ||
            start.level !== "I" ||
            start.epochMs < crash.epochMs ||
            start.epochMs > line.epochMs
          )
            return false;
          return Number(/^\[\d+,(\d+),/.exec(start.message)?.[1]) === crash.pid;
        })
      );
    });
    return died ? [{ ...crash, uid }] : [];
  });
  const starts = new Map<number, { uid: number; process: string }>();
  const nativeBoundary = new Map<string, number>();
  return lines.flatMap((line): LaunchCrash[] => {
    if (line.level !== "I") return [];
    if (line.tag === "am_proc_start") {
      const fields = /^\[(\d+),(\d+),(\d+),([^,]+),/.exec(line.message);
      if (fields?.[2] !== undefined && fields[3] !== undefined && fields[4] !== undefined) {
        const uid = Number(fields[3]);
        if (Math.floor(uid / 100000) === Number(fields[1]))
          starts.set(Number(fields[2]), { uid, process: fields[4] });
      }
      return [];
    }
    if (line.tag !== "am_crash") return [];
    const fields = /^\[(\d+),(\d+),([^,]+),[^,]+,([^,]+),/.exec(line.message);
    if (fields?.[1] === undefined || fields[2] === undefined || fields[3] === undefined) return [];
    const process = fields[3];
    if (fields[4] === "Native crash") {
      const boundary = nativeBoundary.get(process) ?? -Infinity;
      nativeBoundary.set(process, line.epochMs);
      if (/,\d+,1\]$/.test(line.message)) return [];
      const matches = native.filter(
        (crash) =>
          crash.process === process && crash.epochMs > boundary && crash.epochMs <= line.epochMs,
      );
      const crash = matches.length === 1 ? matches[0] : undefined;
      if (crash === undefined || crash.pid === null) return [];
      return [
        {
          key: crashKey(line),
          pid: crash.pid,
          userId: Math.floor(crash.uid / 100000),
          uid: crash.uid,
          process,
        },
      ];
    }
    if (/,\d+,1\]$/.test(line.message)) return [];
    const pid = Number(fields[1]);
    const userId = Number(fields[2]);
    const started = starts.get(pid);
    const uid =
      started?.process === process && Math.floor(started.uid / 100000) === userId
        ? started.uid
        : null;
    return [{ key: crashKey(line), pid, userId, uid, process }];
  });
}

export async function readLaunchCrashes(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<{ keys: string[]; crashes: LaunchCrash[] }> {
  const step = "reading launch crashes";
  const result = await readShell(adb, serial, LAUNCH_CRASH_COMMAND, step, options);
  const { lines, unparsed } = parseLogcat(result.stdout);
  if (unparsed !== 0) throw invalidOutput(step, result.stdout);
  return {
    keys: lines.filter((line) => line.tag === "am_crash" && line.level === "I").map(crashKey),
    crashes: parseLaunchCrashes(result.stdout),
  };
}
