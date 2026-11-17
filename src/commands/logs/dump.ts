import { assertPackageName } from "../../android/component.js";
import { LOG_LEVELS, atLeast, type LogLevel, type LogLine } from "../../android/logcat.js";
import {
  capLines,
  MAX_FIELD_CHARS,
  truncateField,
  FullOutputFile,
  MAX_LINES,
  type LineWindow,
} from "../../core/truncate.js";
import { createCrashParser } from "../../android/crash.js";
import { runHint } from "../../core/output.js";
import { defineCommand } from "../define.js";
import { describeScope } from "./scope.js";
import { clockTime, compileRegex, openLogWindow, withMarksNote } from "./window.js";

/** The window of `logs` without `--since`, counted back from the device's now. */
export const DEFAULT_SINCE = "15m";

export const logsDump = defineCommand({
  path: ["logs"],
  summary: "A bounded log dump for one window, with level counts and repeats collapsed",
  flags: [
    {
      name: "--since",
      type: "string",
      valueName: "<mark|dur>",
      description: "Window start: a log mark name, or a duration back from now such as 30s",
      default: DEFAULT_SINCE,
    },
    {
      name: "--pkg",
      type: "string",
      valueName: "<pkg>",
      description:
        "Only this app's processes: logcat --uid on API 31 and newer, a pid list on API 29 and 30 " +
        "(it can miss a process that starts and dies between reads); either way lines other " +
        "processes log about the app are dropped",
    },
    {
      name: "--level",
      type: "enum",
      values: ["V", "D", "I", "W", "E"],
      description: "Minimum level to show",
    },
    {
      name: "--grep",
      type: "string",
      valueName: "<re>",
      description: "Only lines whose message matches this regex",
    },
    { name: "--full", type: "boolean", description: "Write the complete output to a file" },
  ],
  examples: [
    "adb-axi logs --pkg com.example.notes --since before-save --level W",
    "adb-axi logs --since 1m --grep Room",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = typeof context.flags.pkg === "string" ? context.flags.pkg : undefined;
    if (pkg !== undefined) assertPackageName(pkg);
    const grep =
      typeof context.flags.grep === "string"
        ? compileRegex("--grep", context.flags.grep)
        : undefined;
    const level =
      typeof context.flags.level === "string" ? (context.flags.level as LogLevel) : undefined;
    const since = typeof context.flags.since === "string" ? context.flags.since : undefined;
    const window = await openLogWindow(context.device, since ?? DEFAULT_SINCE, context.env);
    return withMarksNote(window.marksNote, async () => {
      const { now } = window;
      const full = context.flags.full === true;
      const spool = full
        ? new FullOutputFile(
            `logs-${window.label}-${clockTime(now.epochMs, now.utcOffsetMinutes).slice(0, 8).replaceAll(":", "")}`,
          )
        : undefined;
      try {
        const rows: Row[] = [];
        let rowCount = 0;
        let lastMessage: string | undefined;
        let matched = 0;
        const levels: Partial<Record<LogLevel, number>> = {};
        const crashes = createCrashParser();
        const { scanned, scope, firstLine } = await window.readLogs((line) => {
          if (
            (level !== undefined && !atLeast(line.level, level)) ||
            (grep !== undefined && !grep.test(line.message))
          )
            return;
          matched++;
          levels[line.level] = (levels[line.level] ?? 0) + 1;
          crashes.add(line);
          spool?.write(`${formatFullLine(line, now.utcOffsetMinutes)}\n`);
          const last = rows.at(-1);
          if (last?.level === line.level && last.tag === line.tag && lastMessage === line.message)
            last.repeats++;
          else {
            rowCount++;
            const message = truncateField(line.message);
            rows.push({
              time: clockTime(line.epochMs, now.utcOffsetMinutes),
              level: line.level,
              tag: line.tag,
              message,
              long: message !== line.message,
              repeats: 1,
            });
            if (rows.length > MAX_LINES) rows.shift();
          }
          lastMessage = line.message;
          const keep = capLines(rows.map(formatRow), { keep: "tail" }).lines.length;
          if (rows.length > keep) rows.splice(0, rows.length - keep);
        }, pkg);
        const shown = capLines(
          rows.map((row) => formatRow(row)),
          { keep: "tail" },
        );
        const visible = rows.slice(rows.length - shown.lines.length);
        const displayed = visible.map((row) => {
          const capped = shown.cut === undefined ? undefined : shown.lines[0];
          const tagStart = `${row.time},${row.level},`.length;
          const messageStart = tagStart + row.tag.length + 1;
          const tag = capped === undefined ? row.tag : capped.slice(tagStart, messageStart - 1);
          return {
            time: row.time,
            level: row.level,
            tag:
              capped !== undefined && capped.length < messageStart
                ? Array.from(tag).slice(0, -1).join("")
                : tag,
            message: capped === undefined ? displayMessage(row) : capped.slice(messageStart),
          };
        });
        const seconds = Math.max(0, Math.round((now.epochMs - window.startMs) / 1000));
        const counts =
          matched === 0
            ? { matched: 0 }
            : Object.fromEntries(
                [...LOG_LEVELS]
                  .reverse()
                  .flatMap((level) =>
                    levels[level] === undefined ? [] : [[level, levels[level]]],
                  ),
              );
        // A row cut at the byte cap is measured as printed, with its tag and message.
        const cutRow = displayed[0];
        const printed =
          shown.cut === undefined || cutRow === undefined
            ? shown
            : {
                ...shown,
                cut: {
                  ...shown.cut,
                  shownBytes: Buffer.byteLength(
                    `${cutRow.time},${cutRow.level},${cutRow.tag},${cutRow.message}`,
                  ),
                },
              };
        const accounting = account(matched, rowCount, visible, printed);
        const cut = accounting.lossy;
        const crashed = crashes.finish().length > 0;
        return {
          window: `${window.label} -> now (${seconds} s), ${scanned} lines scanned`,
          ...(firstLine !== undefined && firstLine.epochMs - window.startMs > 2000
            ? {
                note: `first log line in this window is at ${clockTime(firstLine.epochMs, now.utcOffsetMinutes)}, after the window start; the device log buffer may have dropped earlier lines`,
              }
            : {}),
          ...(scope === undefined ? {} : { scope: describeScope(scope, []) }),
          counts,
          lines: displayed,
          ...(accounting.shown === undefined ? {} : { shown: accounting.shown }),
          ...(full
            ? {
                full: cut ? spool?.keep() : "not written: nothing was cut",
              }
            : {}),
          ...withHelp([
            ...(cut && !full
              ? [
                  `Run the same command with \`--full\` to write all ${matched} matched lines to a file`,
                ]
              : []),
            // A crash in a plain dump is better read as one summary than as its stack rows.
            ...(crashed
              ? [
                  runHint(
                    [
                      "logs",
                      "crash",
                      ...(pkg === undefined ? [] : ["--pkg", pkg]),
                      "--since",
                      since ?? DEFAULT_SINCE,
                    ],
                    "for the crash with its exception and app frame",
                  ),
                ]
              : []),
          ]),
        };
      } finally {
        spool?.discard();
      }
    });
  },
});

/** What `shown` says: how the rows on screen relate to the lines that matched. */
interface Accounting {
  shown: { rows: string; lines: string; cut?: string } | undefined;
  lossy: boolean;
}

/**
 * Tell apart the three ways the table can differ from the matched lines: repeats folded
 * into one row (nothing lost but their times), the oldest rows left out to fit the caps,
 * and rows whose content was cut. `shown` is printed whenever any of them happened.
 */
function account(
  matched: number,
  rows: number,
  visible: readonly Row[],
  window: LineWindow,
): Accounting {
  const omitted = rows - visible.length;
  const folded = matched - rows;
  // A row cut at the byte cap is the only row, and its message is not cut on its own.
  const longMessages = window.cut === undefined ? visible.filter((row) => row.long).length : 0;
  const parts = [
    ...(longMessages > 0
      ? [
          `${longMessages} ${longMessages === 1 ? "message" : "messages"} over ${MAX_FIELD_CHARS} chars`,
        ]
      : []),
    ...(window.cut === undefined
      ? []
      : [`1 row at ${window.cut.shownBytes} of ${window.cut.totalBytes} bytes`]),
  ];
  const cut = parts.length === 0 ? undefined : parts.join(", ");
  if (omitted === 0 && folded === 0 && cut === undefined) {
    return { shown: undefined, lossy: false };
  }
  return {
    shown: {
      rows: `${visible.length} of ${rows}${omitted > 0 ? `, the oldest ${omitted} left out` : ""}`,
      lines: `${matched} matched${folded > 0 ? `, ${folded} folded into repeated rows` : ""}`,
      ...(cut === undefined ? {} : { cut }),
    },
    lossy: true,
  };
}

function withHelp(help: readonly string[]): { help?: string[] } {
  return help.length > 0 ? { help: [...help] } : {};
}

/** One line, or a run of identical consecutive lines, as shown in the table. */
interface Row {
  time: string;
  level: LogLevel;
  tag: string;
  message: string;
  repeats: number;
  long: boolean;
}

function displayMessage(row: Row): string {
  return row.repeats > 1 ? `${row.message} (repeated ${row.repeats}x)` : row.message;
}

/** A row as it counts against the output caps: what the table prints for it. */
function formatRow(row: Row): string {
  return `${row.time},${row.level},${row.tag},${displayMessage(row)}`;
}

function formatFullLine(line: LogLine, utcOffsetMinutes: number | null): string {
  return `${clockTime(line.epochMs, utcOffsetMinutes)} ${line.level} ${line.tag}: ${line.message}`;
}
