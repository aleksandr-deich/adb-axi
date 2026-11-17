import { StringDecoder } from "node:string_decoder";
import { AdbAxiError } from "../core/errors.js";

export const LOG_LIMIT_HELP = [
  "Read a shorter window: a later mark (`adb-axi logs mark <name>`) or a shorter `--since` such as `--since 1m`",
];

/** logcat priorities, lowest first. `S` (silent) never appears on a line. */
export const LOG_LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One line of `logcat -v epoch`. */
export interface LogLine {
  /** Device wall clock in epoch milliseconds. */
  epochMs: number;
  /** The time as printed (`1790834111.087`), the form `logcat -T` accepts back. */
  time: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
  /** The buffer named by the last `--------- beginning of <buffer>` line, if any. */
  buffer: string | null;
}

export interface ParsedLog {
  lines: LogLine[];
  /** Lines that were neither log lines nor buffer markers. */
  unparsed: number;
}

/**
 * `logcat -v epoch` is the threadtime layout with the time as `%19lld.%03ld`, then
 * `%5d %5d %c %-8.*s: ` and the message (AOSP liblog `logprint.cpp`
 * `android_log_formatLogLine`, the same from API 29 to 37). A multi-line message is
 * printed as one line per message line, each with the full prefix. The tag is padded to
 * eight columns, so it ends at the first `: `.
 */
const LINE = /^\s*(\d+)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s(.*?)\s*:(?: (.*))?$/;
const BUFFER_MARKER = /^-{9} (?:beginning of|switch to) (\w+)\s*$/;

export function parseLogLine(line: string, buffer: string | null = null): LogLine | null {
  const match = LINE.exec(line);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined ||
    match[6] === undefined
  ) {
    return null;
  }
  return {
    epochMs: Number(match[1]) * 1000 + Number(match[2]),
    time: `${match[1]}.${match[2]}`,
    pid: Number(match[3]),
    tid: Number(match[4]),
    level: match[5] as LogLevel,
    tag: match[6].trim(),
    message: match[7] ?? "",
    buffer,
  };
}

export function parseLogcat(stdout: string): ParsedLog {
  const lines: LogLine[] = [];
  let unparsed = 0;
  let buffer: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const marker = BUFFER_MARKER.exec(raw);
    if (marker?.[1] !== undefined) {
      buffer = marker[1];
      continue;
    }
    const line = parseLogLine(raw, buffer);
    if (line === null) unparsed++;
    else lines.push(line);
  }
  return { lines, unparsed };
}

export function logcatStream(consume: (line: LogLine) => void): {
  add(chunk: Buffer): void;
  finish(): { parsed: number; unparsed: number };
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let buffer: string | null = null;
  let parsed = 0;
  let unparsed = 0;
  const line = (raw: string): void => {
    if (raw.trim() === "") return;
    const marker = BUFFER_MARKER.exec(raw);
    if (marker?.[1] !== undefined) {
      buffer = marker[1];
      return;
    }
    const value = parseLogLine(raw.replace(/\r$/, ""), buffer);
    if (value === null) unparsed++;
    else {
      parsed++;
      consume(value);
    }
  };
  const text = (value: string): void => {
    pending += value;
    let start = 0;
    for (;;) {
      const end = pending.indexOf("\n", start);
      if (end < 0) break;
      if (Buffer.byteLength(pending.slice(start, end)) > 16 * 1024 * 1024)
        throw new AdbAxiError(
          "INVALID_OUTPUT",
          "one log line exceeds the 16 MiB retained-state limit",
          { help: LOG_LIMIT_HELP },
        );
      line(pending.slice(start, end));
      start = end + 1;
    }
    pending = pending.slice(start);
    if (Buffer.byteLength(pending) > 16 * 1024 * 1024)
      throw new AdbAxiError(
        "INVALID_OUTPUT",
        "one log line exceeds the 16 MiB retained-state limit",
        { help: LOG_LIMIT_HELP },
      );
  };
  return {
    add(chunk) {
      text(decoder.write(chunk));
    },
    finish() {
      text(decoder.end());
      if (pending !== "") line(pending);
      pending = "";
      return { parsed, unparsed };
    },
  };
}

/** Whether `level` is at or above `minimum`, as `logcat *:<minimum>` filters. */
export function atLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}
