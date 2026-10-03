import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertPackageName } from "../../android/component.js";
import { readDeviceClock } from "../../android/clock.js";
import { LOG_LEVELS, atLeast, type LogLevel, type LogLine } from "../../android/logcat.js";
import { capLines, shownLine, truncateField, writeFullOutput } from "../../core/truncate.js";
import { readOptions, targetSerial } from "../app/shared.js";
import { defineCommand } from "../define.js";
import { describeScope, resolveScope, scopePids, type Scope } from "./scope.js";
import { clockTime, compileRegex, readWindowLines, resolveWindow } from "./window.js";

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
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();
    const device = context.target?.device;
    if (device === undefined) throw new TypeError("logs ran without a resolved device");

    const now = await readDeviceClock(adb, serial, options);
    const window = resolveWindow(serial, context.env, since ?? DEFAULT_SINCE, now);
    const scope =
      pkg === undefined
        ? undefined
        : await resolveScope(adb, device, pkg, window, { ...options, env: context.env });
    const scanned = await readWindowLines(
      adb,
      serial,
      window,
      options,
      scope?.kind === "uid" ? scope.uid : undefined,
    );

    const lines = select(scanned, { scope, level, grep });
    const rows = collapse(lines, now.utcOffsetMinutes);
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
    const cutRow = displayed[0];
    const cutShown =
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

    const seconds = Math.max(0, Math.round((now.epochMs - window.startMs) / 1000));
    const full = context.flags.full === true;
    const counts = countLevels(lines);
    return {
      window: `${window.label} -> now (${seconds} s), ${scanned.length} lines scanned`,
      ...(scope?.kind !== "uid" &&
      scanned[0] !== undefined &&
      scanned[0].epochMs - window.startMs > 2000
        ? {
            note: `first log line in this window is at ${clockTime(scanned[0].epochMs, now.utcOffsetMinutes)}, after the window start; the device log buffer may have dropped earlier lines`,
          }
        : {}),
      ...(scope === undefined ? {} : { scope: describeScope(scope, scanned) }),
      counts,
      lines: displayed,
      ...(shown.truncated ? { shown: shownLine({ ...cutShown, total: lines.length }) } : {}),
      ...(full
        ? {
            full: writeFullOutput(
              `logs-${window.label}-${clockTime(now.epochMs, now.utcOffsetMinutes).slice(0, 8).replaceAll(":", "")}`,
              lines.map((line) => `${formatFullLine(line, now.utcOffsetMinutes)}\n`).join(""),
              (path, content) => {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, content, { flag: "wx" });
              },
            ),
          }
        : {}),
      ...(shown.truncated && !full
        ? {
            help: [
              `Run the same command with \`--full\` to write all ${lines.length} lines to a file`,
            ],
          }
        : {}),
    };
  },
});

interface Filters {
  scope: Scope | undefined;
  level: LogLevel | undefined;
  grep: RegExp | undefined;
}

/** The window's lines that pass `--pkg`, `--level` and `--grep`. */
function select(lines: readonly LogLine[], filters: Filters): LogLine[] {
  const pids =
    filters.scope?.kind === "pids" ? new Set(scopePids(filters.scope, lines)) : undefined;
  return lines.filter(
    (line) =>
      (pids === undefined || pids.has(line.pid)) &&
      (filters.level === undefined || atLeast(line.level, filters.level)) &&
      (filters.grep === undefined || filters.grep.test(line.message)),
  );
}

/** Line counts by level, most severe first; levels without lines are left out. */
function countLevels(lines: readonly LogLine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const level of [...LOG_LEVELS].reverse()) {
    const n = lines.filter((line) => line.level === level).length;
    if (n > 0) counts[level] = n;
  }
  return counts;
}

/** One line, or a run of identical consecutive lines, as shown in the table. */
interface Row {
  time: string;
  level: LogLevel;
  tag: string;
  message: string;
  repeats: number;
}

/** Collapse runs of consecutive lines that differ only in time, pid and tid. */
function collapse(lines: readonly LogLine[], utcOffsetMinutes: number | null): Row[] {
  const rows: Row[] = [];
  for (const line of lines) {
    const last = rows.at(-1);
    if (last?.level === line.level && last.tag === line.tag && last.message === line.message) {
      last.repeats++;
      continue;
    }
    rows.push({
      time: clockTime(line.epochMs, utcOffsetMinutes),
      level: line.level,
      tag: line.tag,
      message: line.message,
      repeats: 1,
    });
  }
  return rows;
}

function displayMessage(row: Row): string {
  const message = truncateField(row.message);
  return row.repeats > 1 ? `${message} (repeated ${row.repeats}x)` : message;
}

/** A row as it counts against the output caps: what the table prints for it. */
function formatRow(row: Row): string {
  return `${row.time},${row.level},${row.tag},${displayMessage(row)}`;
}

function formatFullLine(line: LogLine, utcOffsetMinutes: number | null): string {
  return `${clockTime(line.epochMs, utcOffsetMinutes)} ${line.level} ${line.tag}: ${line.message}`;
}
