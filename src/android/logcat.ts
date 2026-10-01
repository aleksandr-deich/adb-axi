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

/** Whether `level` is at or above `minimum`, as `logcat *:<minimum>` filters. */
export function atLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}
