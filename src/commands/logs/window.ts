import type { AdbClient } from "../../adb/run.js";
import { processTable, userIdFromUid } from "../../android/app-processes.js";
import {
  formatDeviceTime,
  logcatTime,
  readDeviceClock,
  type DeviceTime,
} from "../../android/clock.js";
import { crashBelongsTo, createCrashParser, type Crash } from "../../android/crash.js";
import { LOG_LIMIT_HELP, logcatStream, parseLogcat, type LogLine } from "../../android/logcat.js";
import { invalidOutput, readShell, type ReadOptions } from "../../android/read.js";
import { parseDuration } from "../../core/args.js";
import { AdbAxiError } from "../../core/errors.js";
import type { Output } from "../../core/output.js";
import { FullOutputFile } from "../../core/truncate.js";
import type { DeviceSession } from "../../device/session.js";
import {
  assertMarkVerified,
  bindMarks,
  readMarks,
  requireMark,
  writeMark,
  type Mark,
} from "./marks.js";
import { CrashSpool } from "./crash-spool.js";
import { PID_LIST_BELOW_API, resolveScope, startedPids, type Scope } from "./scope.js";

export interface LogWindow {
  startMs: number;
  label: string;
  mark: Mark | undefined;
}

export interface OpenLogWindow extends LogWindow {
  now: DeviceTime;
  marksNote: string | undefined;
  readLines(consume: (line: LogLine) => void, reads?: ReadOptions): Promise<void>;
  readLogs(
    consume: (line: LogLine) => void,
    pkg?: string,
  ): Promise<{
    scanned: number;
    firstLine: LogLine | undefined;
    scope: Scope | undefined;
  }>;
  readCrashes(
    pkg?: string,
    full?: { file: FullOutputFile; header(crash: Crash): string },
  ): Promise<{
    crashes: Crash[];
    count: number;
    scanned: number;
    unverified: number;
    note: string | undefined;
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
      readLines: (consume, options = reads) => streamWindow(adb, serial, window, options, consume),
      async readLogs(consume, pkg) {
        const scope = pkg === undefined ? undefined : await resolveScope(device, pkg, window);
        let scanned = 0;
        let firstLine: LogLine | undefined;
        const spool = scope?.kind === "pids" ? new FullOutputFile("log-scan") : undefined;
        let spoolBuffer: string | null = null;
        const pids = new Set(scope?.kind === "pids" ? [...scope.current, ...scope.marked] : []);
        try {
          await streamWindow(
            adb,
            serial,
            window,
            reads,
            (line) => {
              scanned++;
              firstLine ??= line;
              if (scope?.kind === "pids" && spool !== undefined) {
                for (const pid of startedPids([line], scope.uid)) pids.add(pid);
                if (pids.size > 65536)
                  throw new AdbAxiError(
                    "INVALID_OUTPUT",
                    "log scope exceeds the 65536 pid retained-state limit",
                    { help: LOG_LIMIT_HELP },
                  );
                if (line.buffer !== null && line.buffer !== spoolBuffer) {
                  spool.write(`--------- beginning of ${line.buffer}\n`);
                  spoolBuffer = line.buffer;
                }
                spool.write(
                  `${line.time} ${line.pid} ${line.tid} ${line.level} ${line.tag}: ${line.message}\n`,
                );
              } else consume(line);
            },
            scope?.kind === "uid" ? scope.uid : undefined,
          );
          if (scope?.kind === "pids" && spool !== undefined) {
            scope.current = [...pids];
            const replay = logcatStream((line) => {
              if (pids.has(line.pid)) consume(line);
            });
            for (const chunk of spool.chunks()) {
              if (reads.deadline.remainingMs() === 0)
                throw new AdbAxiError(
                  "TIMEOUT",
                  "reading the log did not finish before the deadline",
                  { fields: { step: "reading the log" } },
                );
              replay.add(chunk);
            }
            replay.finish();
          }
          // A uid scan starts at the app's first line, not necessarily the buffer's first line.
          if (scope?.kind === "uid")
            firstLine = await readFirstWindowLine(adb, serial, window, reads);
          return { scanned, firstLine, scope };
        } finally {
          spool?.discard();
        }
      },
      async readCrashes(pkg, full) {
        const userId = pkg === undefined ? undefined : await device.user();
        const spool = new CrashSpool(full !== undefined);
        const matches = (crash: Crash): boolean =>
          crash.epochMs >= window.startMs && (pkg === undefined || crashBelongsTo(crash, pkg));
        const needsEvents = { value: false };
        const parser = createCrashParser({
          retain: false,
          onTrace(order, message) {
            spool.line(order, message);
          },
          onReport(order, crash) {
            if (crash !== null && matches(crash) && crash.kind !== "native")
              needsEvents.value = true;
            spool.report(order, crash);
          },
        });
        let scanned = 0;
        try {
          await streamWindow(
            adb,
            serial,
            window,
            reads,
            (line) => {
              if (line.epochMs >= window.startMs) scanned++;
              parser.add(line);
            },
            undefined,
            true,
          );
          parser.finish();
          const events =
            userId !== undefined && needsEvents.value ? await readCrashEvents(device, window) : [];
          const candidates = events.map((event) => ({ event, reports: 0 }));
          if (candidates.length > 0) {
            for (const { crash } of spool.reports()) {
              for (const candidate of candidates)
                if (eventMatchesCrash(candidate.event, crash, events) !== undefined)
                  candidate.reports++;
            }
          }
          let count = 0;
          let unverified = 0;
          const crashes: Crash[] = [];
          for (const entry of spool.reports()) {
            const { crash } = entry;
            if (!matches(crash)) continue;
            if (userId !== undefined) {
              const owner = crashUser(crash, events, candidates);
              if (owner === undefined) unverified++;
              if (owner !== userId) continue;
            }
            count++;
            if (crashes.length < 5) crashes.push(crash);
            if (full !== undefined) {
              full.file.write(`${full.header(crash)}\n`);
              spool.writeTrace(entry, full.file);
              full.file.write("\n");
            }
          }
          return {
            crashes,
            count,
            scanned,
            unverified,
            note: parser.degraded
              ? "Crash details exceeded retained-state limits; summaries may be truncated. Use --full for complete traces."
              : undefined,
          };
        } finally {
          spool.discard();
        }
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

function eventMatchesCrash(
  line: LogLine,
  crash: Crash,
  events: readonly LogLine[],
): number | undefined {
  if (line.level !== "I") return undefined;
  const fields =
    crash.kind === "java" && line.tag === "am_crash"
      ? /^\[(\d+),(\d+),([^,\]]+),[^,]+,([^,\]]+),/.exec(line.message)
      : crash.kind === "anr" && line.tag === "am_anr"
        ? /^\[(\d+),(\d+),([^,\]]+),/.exec(line.message)
        : null;
  if (fields === null || fields[3] !== crash.process || fields[4] === "Native crash")
    return undefined;
  const pid = Number(fields[crash.kind === "java" ? 1 : 2]);
  const userId = Number(fields[crash.kind === "java" ? 2 : 1]);
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(userId) ||
    crash.pid !== pid ||
    (crash.kind === "java" && line.epochMs < crash.epochMs) ||
    (crash.kind === "anr" && line.epochMs > crash.epochMs) ||
    Math.abs(line.epochMs - crash.epochMs) > CRASH_LEAD_IN_MS
  )
    return undefined;
  const start = Math.min(line.epochMs, crash.epochMs);
  const end = Math.max(line.epochMs, crash.epochMs);
  if (
    events.some(
      (event) =>
        event.epochMs > start &&
        event.epochMs < end &&
        event.level === "I" &&
        (event.tag === "am_proc_start" || event.tag === "am_proc_died") &&
        Number(/^\[\d+,(\d+),/.exec(event.message)?.[1]) === pid,
    )
  )
    return undefined;
  return userId;
}

function crashUser(
  crash: Crash,
  events: readonly LogLine[],
  candidates: readonly { event: LogLine; reports: number }[],
): number | undefined {
  if (crash.kind === "native")
    return crash.uid === undefined ? undefined : userIdFromUid(crash.uid);
  const matches = candidates.flatMap(({ event, reports }) => {
    if (reports !== 1) return [];
    const owner = eventMatchesCrash(event, crash, events);
    return owner === undefined ? [] : [owner];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function streamWindow(
  adb: AdbClient,
  serial: string,
  window: LogWindow,
  options: ReadOptions,
  consume: (line: LogLine) => void,
  uid?: number,
  includeLeadIn = false,
): Promise<void> {
  const command = logcatCommand(window.startMs - (includeLeadIn ? CRASH_LEAD_IN_MS : 0), uid);
  await streamLogLines(adb, serial, command, options, (line) => {
    if (includeLeadIn || line.epochMs >= window.startMs) consume(line);
  });
}

async function readLogLines(
  adb: AdbClient,
  serial: string,
  command: string,
  options: ReadOptions,
): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  let bytes = 0;
  await streamLogLines(adb, serial, command, options, (line) => {
    bytes += Buffer.byteLength(line.message) + Buffer.byteLength(line.tag) + 128;
    if (bytes > 16 * 1024 * 1024)
      throw new AdbAxiError(
        "INVALID_OUTPUT",
        "crash ownership events exceed the 16 MiB retained-state limit",
        { help: LOG_LIMIT_HELP },
      );
    lines.push(line);
  });
  return lines;
}

async function streamLogLines(
  adb: AdbClient,
  serial: string,
  command: string,
  options: ReadOptions,
  consume: (line: LogLine) => void,
): Promise<void> {
  const parser = logcatStream(consume);
  let failure: Error | undefined;
  const controller = new AbortController();
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let result;
  try {
    result = await readShell(adb, serial, command, "reading the log", {
      ...options,
      signal:
        options.signal === undefined
          ? controller.signal
          : AbortSignal.any([options.signal, controller.signal]),
      maxOutputBytes: 4096,
      sink(stream, chunk) {
        if (failure !== undefined) return;
        try {
          if (stream === "stdout") parser.add(chunk);
          else {
            stderrBytes += chunk.length;
            if (stderrBytes > 16 * 1024 * 1024)
              throw new AdbAxiError(
                "INVALID_OUTPUT",
                "logcat stderr exceeds the 16 MiB retained-state limit",
                { help: LOG_LIMIT_HELP },
              );
            stderr.push(chunk);
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        }
      },
    });
  } catch (error) {
    if (failure !== undefined) throw failure;
    if (error instanceof AdbAxiError && error.code === "REMOTE_EXIT")
      error.fields.stderr = Buffer.concat(stderr).toString("utf8").trim();
    throw error;
  }
  if (failure !== undefined) throw failure;
  const parsed = parser.finish();
  if (parsed.parsed === 0 && parsed.unparsed > 0)
    throw invalidOutput("reading the log", result.stdout);
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
