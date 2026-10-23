import type { AdbClient } from "../../adb/run.js";
import { processTable } from "../../android/app-processes.js";
import {
  formatDeviceTime,
  logcatTime,
  readDeviceClock,
  type DeviceTime,
} from "../../android/clock.js";
import { crashBelongsTo, parseCrashes, type Crash } from "../../android/crash.js";
import { parseLogcat, type LogLine } from "../../android/logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "../../android/read.js";
import { parseDuration } from "../../core/args.js";
import { AdbAxiError } from "../../core/errors.js";
import type { Output } from "../../core/output.js";
import type { DeviceSession } from "../../device/session.js";
import {
  assertMarkVerified,
  bindMarks,
  readMarks,
  requireMark,
  writeMark,
  type Mark,
} from "./marks.js";
import { PID_LIST_BELOW_API, resolveScope, type Scope } from "./scope.js";

export interface LogWindow {
  startMs: number;
  label: string;
  mark: Mark | undefined;
}

export interface OpenLogWindow extends LogWindow {
  now: DeviceTime;
  marksNote: string | undefined;
  readLines(reads?: ReadOptions): Promise<LogLine[]>;
  readLogs(pkg?: string): Promise<{
    lines: LogLine[];
    firstLine: LogLine | undefined;
    scope: Scope | undefined;
  }>;
  readCrashes(pkg?: string): Promise<{
    crashes: Crash[];
    scanned: LogLine[];
    unverified: number;
  }>;
}

type Since = string | undefined | { latest: string };

export async function openLogWindow(
  device: DeviceSession,
  since: Since,
  env: NodeJS.ProcessEnv,
): Promise<OpenLogWindow> {
  // Home binds even when its clock read fails; other reads keep clock failures ahead of state writes.
  let binding = typeof since === "object" ? await bindDeviceMarks(device, env) : undefined;
  try {
    const now = await readDeviceClock(device.adb, device.serial, device.reads);
    binding ??= await bindDeviceMarks(device, env);
    const selected =
      typeof since === "object"
        ? ((binding.verified ? latestMark(device.serial, env) : undefined) ?? since.latest)
        : since;
    const duration = selected === undefined ? undefined : parseDuration(selected);
    let window: LogWindow;
    if (selected === undefined) {
      window = { startMs: now.epochMs, label: "now", mark: undefined };
    } else if (duration !== undefined) {
      window = { startMs: now.epochMs - duration, label: `${selected} ago`, mark: undefined };
    } else {
      assertMarkVerified(device.serial, selected, binding.verified);
      const mark = requireMark(device.serial, env, selected);
      window = { startMs: mark.epochMs, label: selected, mark };
    }
    const { adb, serial, reads } = device;
    return {
      ...window,
      now,
      marksNote: binding.note,
      readLines: (options = reads) => readWindowLines(adb, serial, window, options),
      async readLogs(pkg) {
        const scope = pkg === undefined ? undefined : await resolveScope(device, pkg, window);
        const lines = await readWindowLines(
          adb,
          serial,
          window,
          reads,
          scope?.kind === "uid" ? scope.uid : undefined,
        );
        // A uid scan starts at the app's first line, not necessarily the buffer's first line.
        const firstLine =
          scope?.kind === "uid" ? await readFirstWindowLine(adb, serial, window, reads) : lines[0];
        return { lines, firstLine, scope };
      },
      async readCrashes(pkg) {
        const userId = pkg === undefined ? undefined : await device.user();
        // ANRs and tombstones are written by other processes, so never narrow this scan by uid or pid.
        const lines = await readWindowLines(adb, serial, window, reads, undefined, true);
        const reports = parseCrashes(lines);
        const matching = reports.filter(
          (crash) =>
            crash.epochMs >= window.startMs && (pkg === undefined || crashBelongsTo(crash, pkg)),
        );
        const events =
          userId !== undefined && matching.some((crash) => crash.kind !== "native")
            ? await readCrashEvents(device, window)
            : [];
        let unverified = 0;
        const crashes = matching.filter((crash) => {
          if (userId === undefined) return true;
          const owner = crashUser(crash, events, reports);
          if (owner === undefined) unverified++;
          return owner === userId;
        });
        return {
          crashes,
          scanned: lines.filter((line) => line.epochMs >= window.startMs),
          unverified,
        };
      },
    };
  } catch (error) {
    throw withNote(error, binding?.note);
  }
}

export async function recordLogMark(
  device: DeviceSession,
  given: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ name: string; shown: string; marksNote: string | undefined }> {
  const { adb, serial, reads } = device;
  const facts = await device.facts();
  if (facts.api === null) throw invalidOutput("reading the Android version", "");
  // Older logcat needs the processes from before the clock to include those alive at the mark.
  const processes = facts.api < PID_LIST_BELOW_API ? await processTable(adb, serial, reads) : [];
  const now = await readDeviceClock(adb, serial, reads);
  const note = bindMarks(serial, env, facts.bootId);
  try {
    const shown = formatDeviceTime(now.epochMs, now.utcOffsetMinutes);
    const name = given ?? `mark-${shown.slice(11, 19).replaceAll(":", "")}`;
    assertMarkVerified(serial, name, facts.bootId !== null);
    writeMark(serial, env, name, {
      epochMs: now.epochMs,
      utcOffsetMinutes: now.utcOffsetMinutes,
      processes,
      hostEpochMs: Date.now(),
    });
    return { name, shown, marksNote: note };
  } catch (error) {
    throw withNote(error, note);
  }
}

async function bindDeviceMarks(
  device: DeviceSession,
  env: NodeJS.ProcessEnv,
): Promise<{ verified: boolean; note: string | undefined }> {
  let bootId: string | null = null;
  try {
    bootId = (await device.facts()).bootId;
  } catch (error) {
    if (!(error instanceof AdbAxiError)) throw error;
  }
  return { verified: bootId !== null, note: bindMarks(device.serial, env, bootId) };
}

function latestMark(serial: string, env: NodeJS.ProcessEnv): string | undefined {
  let latest: { name: string; epochMs: number } | undefined;
  for (const [name, mark] of readMarks(serial, env)) {
    if (latest === undefined || mark.epochMs > latest.epochMs)
      latest = { name, epochMs: mark.epochMs };
  }
  return latest?.name;
}

export async function withMarksNote(
  note: string | undefined,
  read: () => Promise<Output>,
): Promise<Output> {
  try {
    const output = await read();
    return note === undefined ? output : { ...output, marks_note: note };
  } catch (error) {
    throw withNote(error, note);
  }
}

function withNote(error: unknown, note: string | undefined): unknown {
  if (error instanceof AdbAxiError && note !== undefined) error.fields.marks_note = note;
  return error;
}

export function logcatCommand(startMs: number, uid?: number): string {
  const base = `logcat -d -v epoch -T ${logcatTime(startMs)}`;
  return uid === undefined ? base : `${base} --uid ${uid}`;
}

// A default 2 MiB buffer can expand to near 40 MB across main, system and crash.
const MAX_WINDOW_BYTES = 64 * 1024 * 1024;

// Reports and their fatal signals or user events can be separated by slow crash/ANR handling.
const CRASH_LEAD_IN_MS = 60_000;

async function readCrashEvents(device: DeviceSession, window: LogWindow): Promise<LogLine[]> {
  return readLogLines(
    device.adb,
    device.serial,
    `logcat -d -b events -v epoch -T ${logcatTime(window.startMs - CRASH_LEAD_IN_MS)} -s am_crash:I am_anr:I am_proc_start:I am_proc_died:I`,
    device.reads,
  );
}

function crashUser(
  crash: Crash,
  events: readonly LogLine[],
  reports: readonly Crash[],
): number | undefined {
  if (crash.kind === "native") {
    const uids = crash.trace.flatMap((message) => /^uid: (\d+)\s*$/.exec(message)?.[1] ?? []);
    const uid = uids.length === 1 ? Number(uids[0]) : NaN;
    return Number.isSafeInteger(uid) ? Math.floor(uid / 100000) : undefined;
  }
  const matches = events.flatMap((line) => {
    if (line.level !== "I") return [];
    const fields =
      crash.kind === "java" && line.tag === "am_crash"
        ? /^\[(\d+),(\d+),([^,\]]+),[^,]+,([^,\]]+),/.exec(line.message)
        : crash.kind === "anr" && line.tag === "am_anr"
          ? /^\[(\d+),(\d+),([^,\]]+),/.exec(line.message)
          : null;
    if (fields === null || fields[3] !== crash.process || fields[4] === "Native crash") return [];
    const pid = Number(fields[crash.kind === "java" ? 1 : 2]);
    const userId = Number(fields[crash.kind === "java" ? 2 : 1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(userId)) return [];
    const matchesReport = (report: Crash): boolean => {
      if (
        report.kind !== crash.kind ||
        report.pid !== pid ||
        report.process !== crash.process ||
        (crash.kind === "java" && line.epochMs < report.epochMs) ||
        (crash.kind === "anr" && line.epochMs > report.epochMs) ||
        Math.abs(line.epochMs - report.epochMs) > CRASH_LEAD_IN_MS
      )
        return false;
      const start = Math.min(line.epochMs, report.epochMs);
      const end = Math.max(line.epochMs, report.epochMs);
      // A reused pid is not evidence that two reports belong to the same Android user.
      return !events.some((event) => {
        if (event.epochMs <= start || event.epochMs >= end || event.level !== "I") return false;
        if (event.tag !== "am_proc_start" && event.tag !== "am_proc_died") return false;
        return Number(/^\[\d+,(\d+),/.exec(event.message)?.[1]) === pid;
      });
    };
    // Ambiguous reports stay unverified, rather than lending one event to multiple crashes.
    return matchesReport(crash) && reports.filter(matchesReport).length === 1 ? [userId] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function readWindowLines(
  adb: AdbClient,
  serial: string,
  window: LogWindow,
  options: ReadOptions,
  uid?: number,
  includeLeadIn = false,
): Promise<LogLine[]> {
  const command = logcatCommand(window.startMs - (includeLeadIn ? CRASH_LEAD_IN_MS : 0), uid);
  const lines = await readLogLines(adb, serial, command, options);
  return includeLeadIn ? lines : lines.filter((line) => line.epochMs >= window.startMs);
}

async function readLogLines(
  adb: AdbClient,
  serial: string,
  command: string,
  options: ReadOptions,
): Promise<LogLine[]> {
  const step = "reading the log";
  const result = await readShell(adb, serial, command, step, {
    ...options,
    maxOutputBytes: MAX_WINDOW_BYTES,
    limitHelp: [
      "Read a shorter window: a later mark (`adb-axi logs mark <name>`) or a shorter `--since` such as `--since 1m`",
    ],
  });
  const parsed = parseLogcat(result.stdout);
  // Text that is no log line at all is never passed off as an empty log.
  if (parsed.lines.length === 0 && parsed.unparsed > 0) throw invalidOutput(step, result.stdout);
  return parsed.lines;
}

async function readFirstWindowLine(
  adb: AdbClient,
  serial: string,
  window: LogWindow,
  options: ReadOptions,
): Promise<LogLine | undefined> {
  const step = "reading the start of the log buffer";
  const result = await readShell(
    adb,
    serial,
    `${logcatCommand(window.startMs)} -m 1`,
    step,
    options,
  );
  const parsed = parseLogcat(result.stdout);
  if (parsed.lines.length === 0 && parsed.unparsed > 0) throw invalidOutput(step, result.stdout);
  return parsed.lines.find((line) => line.epochMs >= window.startMs);
}

/** A regex from the command line; one that does not compile is a usage error. */
export function compileRegex(flag: string, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new AdbAxiError("VALIDATION_ERROR", `${flag} "${source}" is not a valid regex`, {
      fields: { detail: error instanceof Error ? error.message : String(error) },
      help: ["Pass a JavaScript regular expression, for example `Room|Migration`"],
    });
  }
}

/** A line's device-local time of day, `10:12:41.337`. */
export function clockTime(epochMs: number, utcOffsetMinutes: number | null): string {
  return formatDeviceTime(epochMs, utcOffsetMinutes).slice("2026-09-30 ".length);
}
